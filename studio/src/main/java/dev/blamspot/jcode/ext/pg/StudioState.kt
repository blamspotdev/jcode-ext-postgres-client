package dev.blamspot.jcode.ext.pg

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.blamspot.jcode.ext.api.NativeHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** One column as the diagram cares about it: its name, its type, and whether it is a key. */
internal data class DiagramColumn(
    val name: String,
    val type: String,
    val primary: Boolean,
    val foreign: Boolean,
)

/** The tables on the canvas, and the foreign keys between them. */
internal data class Diagram(
    val tables: Map<String, List<DiagramColumn>> = emptyMap(),
    val edges: List<Pair<String, String>> = emptyList(),
)

/** The studio's sections, in the order they are worked through. */
internal enum class Pane(val label: String) {
    Tables("Tables"),
    Diagram("Diagram"),
    Security("Security"),
    Backup("Backup"),
}

/** One column of a table, as the catalogue describes it. */
internal data class ColumnInfo(
    val position: String,
    val name: String,
    val type: String,
    val nullable: String,
    val default: String,
    val key: String,
)

/**
 * One database, open.
 *
 * Its own connection and its own questions: a studio tab is restored with a session and reached
 * from other tabs, so it cannot assume the drawer is on screen or that it decided anything.
 */
internal class StudioState(
    private val host: NativeHost,
    private val scope: CoroutineScope,
    view: String,
) {
    private val psql = Psql(host)

    /** The database this tab is about, carried in the route that opened it. */
    val database: String = decode(view.removePrefix("db:"))

    var conn by mutableStateOf(Conn.from(emptyMap()))
        private set

    var pane by mutableStateOf(Pane.Tables)

    var loading by mutableStateOf(true)
        private set
    var busy by mutableStateOf(false)
        private set

    /** Whether the last thing asked of the server was answered. */
    var connected by mutableStateOf(false)
        private set

    var message by mutableStateOf("")
        private set
    var failed by mutableStateOf(false)
        private set

    val tables = mutableStateListOf<String>()
    var table by mutableStateOf("")
        private set

    val columns = mutableStateListOf<ColumnInfo>()

    /**
     * Every table and column in the database, for the editor to suggest from.
     *
     * Fetched once when the database opens: it is two queries, and a suggestion that has to ask the
     * server before it can offer anything arrives after the word has been typed.
     */
    private var schemaTables by mutableStateOf(emptyList<String>())
    private var schemaColumns by mutableStateOf(emptyMap<String, List<String>>())

    /** What could finish the word being typed, given this database's own names. */
    val suggestions: List<String>
        get() = suggestionsFor(query, schemaTables, schemaColumns)

    fun accept(suggestion: String) {
        query = applySuggestion(query, suggestion)
    }

    /** The query in the editor, and the last thing running it produced. */
    var query by mutableStateOf("")
    var grid by mutableStateOf(Grid())
        private set

    var confirm by mutableStateOf<Confirm?>(null)

    // --- the other three sections ---------------------------------------------------------------

    /** Who exists on this server, and what they may touch. */
    var roles by mutableStateOf(Grid())
        private set
    var grants by mutableStateOf(Grid())
        private set

    /** Where a dump is written and read — a path in the runtime, not on the server. */
    var dumpPath by mutableStateOf("")
    val dumpLog = mutableStateListOf<String>()

    /** The tables drawn on the diagram, and the keys between them. */
    val onCanvas = mutableStateListOf<String>()
    var diagram by mutableStateOf(Diagram())
        private set

    fun boot() {
        scope.launch {
            loading = true
            conn = Conn.from(host.config())
            ping()
            loadTables()
            loading = false
        }
    }

    fun reload() {
        if (busy) return
        scope.launch {
            busy = true
            conn = Conn.from(host.config())
            ping()
            loadTables()
            busy = false
        }
    }

    /** One cheap question, so the dot in the toolbar means something. */
    private suspend fun ping() {
        val (rows, error) = psql.column(conn, "SELECT 1", database)
        connected = error.isEmpty() && rows.firstOrNull() == "1"
        if (error.isNotEmpty()) report(error, failed = true)
    }

    private suspend fun loadTables() {
        val (names, error) = psql.column(conn, TABLES_SQL, database)
        tables.clear()
        if (error.isNotEmpty()) {
            report(error, failed = true)
            return
        }
        tables += names
        schemaTables = names
        loadSchemaColumns()
        if (table.isEmpty() || table !in names) table = names.firstOrNull().orEmpty()
        if (table.isNotEmpty()) loadColumns()
    }

    /** Every column in the database, keyed by the table it belongs to. */
    private suspend fun loadSchemaColumns() {
        val (rows, error) = psql.column(conn, SCHEMA_COLUMNS_SQL, database)
        if (error.isNotEmpty()) return
        val byTable = LinkedHashMap<String, MutableList<String>>()
        rows.forEach { line ->
            val table = line.substringBefore(Sh.FIELD)
            val column = line.substringAfter(Sh.FIELD, "")
            if (column.isNotEmpty()) byTable.getOrPut(table) { mutableListOf() } += column
        }
        schemaColumns = byTable.mapValues { it.value.toList() }
    }

    fun select(name: String) {
        if (name == table || busy) return
        table = name
        scope.launch {
            busy = true
            loadColumns()
            busy = false
        }
    }

    private suspend fun loadColumns() {
        val g = psql.grid(conn, columnsSql(table), database)
        columns.clear()
        if (!g.ok) {
            report(g.error, failed = true)
            return
        }
        g.rows.forEach { row ->
            columns += ColumnInfo(
                position = row.getOrNull(0).orEmpty(),
                name = row.getOrNull(1).orEmpty(),
                type = row.getOrNull(2).orEmpty(),
                nullable = row.getOrNull(3).orEmpty(),
                default = row.getOrNull(4).orEmpty(),
                key = row.getOrNull(5).orEmpty(),
            )
        }
        // The first thing anyone wants of a table they just picked is to see what is in it.
        query = "SELECT * FROM " + qualified(table) + " LIMIT 1000;"
        runQuery()
    }

    fun runQuery() {
        if (busy || query.isBlank()) return
        scope.launch {
            busy = true
            val g = psql.grid(conn, query.trim().removeSuffix(";"), database, timeoutMs = 300_000L)
            grid = g
            connected = g.ok || g.error.isEmpty()
            report(if (g.ok) g.message else g.error, failed = !g.ok)
            // A statement rather than a result set may well have been a CREATE or a DROP, and the
            // table it made should be in the list without being asked for again. Only then: after a
            // SELECT there is nothing new to learn, and re-reading the catalogue per query would
            // put two more round trips on every one of them.
            if (g.ok && g.columns.isEmpty()) loadTables()
            busy = false
        }
    }

    fun newQuery() {
        query = ""
        grid = Grid()
        message = ""
        failed = false
    }

    // --- changing a table -------------------------------------------------------------------------

    fun addColumn() {
        if (table.isEmpty()) return
        confirm = Confirm(
            title = "Add column",
            body = "Add a column to " + table + ". Give it a name and a type, as SQL spells them.",
            action = "Add",
            destructive = false,
            input = "",
            placeholder = "name TEXT",
        ) { spec ->
            if (spec.isNotBlank()) {
                ddl("ALTER TABLE " + qualified(table) + " ADD COLUMN " + spec, "Column added.")
            }
        }
    }

    fun renameTable() {
        if (table.isEmpty()) return
        val bare = table.substringAfterLast('.')
        confirm = Confirm(
            title = "Rename table",
            body = "Rename " + table + ".",
            action = "Rename",
            destructive = false,
            input = bare,
            placeholder = "New name",
        ) { to ->
            if (to.isNotBlank() && to != bare) {
                ddl("ALTER TABLE " + qualified(table) + " RENAME TO " + Sh.ident(to), "Renamed to " + to + ".")
            }
        }
    }

    fun dropTable() {
        if (table.isEmpty()) return
        confirm = Confirm(
            title = "Drop table",
            body = "Drop " + table + " and everything in it? This cannot be undone.",
            action = "Drop",
        ) {
            ddl("DROP TABLE " + qualified(table), "Dropped " + table + ".")
        }
    }

    private fun ddl(sql: String, done: String) {
        if (busy) return
        scope.launch {
            busy = true
            val r = psql.statement(conn, sql, database)
            report(if (r.ok) done else r.error, failed = !r.ok)
            if (r.ok) {
                host.snackbar(done)
                loadTables()
            }
            busy = false
        }
    }

    /**
     * Open a section, fetching what it needs the first time it is asked for.
     *
     * Not on boot: the diagram and the privilege list are several joins across the whole catalogue,
     * and paying for them to open a database nobody asked to diagram is how a studio feels slow.
     */
    fun show(next: Pane) {
        if (pane == next) return
        pane = next
        when (next) {
            Pane.Security -> if (roles.columns.isEmpty()) scope.launch { work { loadSecurity() } }
            Pane.Diagram -> if (diagram.tables.isEmpty()) scope.launch { work { drawDiagram() } }
            Pane.Backup -> if (dumpPath.isEmpty()) dumpPath = "/root/pgdumps/" + database + ".dump"
            Pane.Tables -> Unit
        }
    }

    private suspend fun work(block: suspend () -> Unit) {
        busy = true
        block()
        busy = false
    }

    // --- security ---------------------------------------------------------------------------------

    private suspend fun loadSecurity() {
        roles = psql.grid(conn, ROLES_SQL, database)
        grants = psql.grid(conn, GRANTS_SQL, database)
        listOf(roles, grants).firstOrNull { !it.ok }?.let { report(it.error, failed = true) }
    }

    // --- backup and restore -----------------------------------------------------------------------

    /**
     * pg_dump in the runtime, to a file in the runtime.
     *
     * Custom format, because that is the one pg_restore can be selective from; a plain SQL dump can
     * only be replayed whole.
     */
    fun backUp() {
        val path = dumpPath.trim()
        if (path.isBlank() || busy) return
        scope.launch {
            work {
                dumpLog.clear()
                dumpLog += "Backing up " + database + " to " + path + " …"
                val directory = path.substringBeforeLast('/', ".")
                val printed = psql.shell(
                    "mkdir -p " + Sh.quote(directory) + " && " + tools("pg_dump") +
                        " -w -Fc -f " + Sh.quote(path) + " " + Sh.quote(database) +
                        " 2>&1 && ls -la " + Sh.quote(path),
                    timeoutMs = 600_000L,
                )
                dumpLog += printed.ifBlank { "Backup complete." }
                host.snackbar("Backed up to " + path)
            }
        }
    }

    fun restore() {
        val path = dumpPath.trim()
        if (path.isBlank() || busy) return
        confirm = Confirm(
            title = "Restore database",
            body = "Restore " + database + " from " + path +
                "? Existing objects are dropped and recreated.",
            action = "Restore",
        ) {
            scope.launch {
                work {
                    dumpLog.clear()
                    dumpLog += "Restoring " + database + " from " + path + " …"
                    val printed = psql.shell(
                        tools("pg_restore") + " -w -d " + Sh.quote(database) +
                            " --clean --if-exists --no-owner " + Sh.quote(path) +
                            " 2>&1; echo exit:" + DOLLAR + "?",
                        timeoutMs = 600_000L,
                    )
                    dumpLog += printed.ifBlank { "Restore complete." }
                    // The echoed exit code is the authority: --clean and --if-exists print warnings
                    // that read like failures and still finish with a restored database.
                    val bad = printed.lines().any { it.startsWith("exit:") && it.trim() != "exit:0" }
                    host.snackbar(if (bad) "Restore failed — read the log." else "Restore complete.")
                    loadTables()
                }
            }
        }
    }

    /** pg_dump and pg_restore take the same connection flags psql does. */
    private fun tools(binary: String): String =
        "LC_ALL=C PGPASSWORD=" + Sh.quote(conn.password) +
            " PGSSLMODE=" + Sh.quote(conn.sslmode) + " " + binary +
            " -h " + Sh.quote(conn.dbHost) + " -p " + Sh.quote(conn.dbPort) +
            " -U " + Sh.quote(conn.user)

    // --- diagram ----------------------------------------------------------------------------------

    fun addToCanvas(name: String) {
        if (name in onCanvas) return
        onCanvas += name
        scope.launch { work { drawDiagram() } }
    }

    fun removeFromCanvas(name: String) {
        onCanvas -= name
        scope.launch { work { drawDiagram() } }
    }

    private suspend fun drawDiagram() {
        // Only the tables actually on the canvas: every column of every table is a payload big
        // enough to stall the app on a real database, fetched for boxes nobody put there.
        if (onCanvas.isEmpty()) onCanvas += tables.take(6)
        if (onCanvas.isEmpty()) {
            diagram = Diagram()
            return
        }
        val inList = onCanvas.joinToString(",") { Sh.literal(it) }
        val cols = psql.grid(conn, diagramColumnsSql(inList), database)
        if (!cols.ok) {
            report(cols.error, failed = true)
            return
        }
        val byTable = LinkedHashMap<String, MutableList<DiagramColumn>>()
        cols.rows.forEach { row ->
            val name = row.getOrNull(0).orEmpty()
            if (name !in onCanvas) return@forEach
            byTable.getOrPut(name) { mutableListOf() } += DiagramColumn(
                name = row.getOrNull(1).orEmpty(),
                type = row.getOrNull(2).orEmpty(),
                primary = row.getOrNull(3) == "1",
                foreign = row.getOrNull(4) == "1",
            )
        }
        val keys = psql.grid(conn, diagramKeysSql(inList), database)
        val edges = keys.rows.mapNotNull { row ->
            val from = row.getOrNull(0).orEmpty()
            val to = row.getOrNull(1).orEmpty()
            if (from == to || from !in onCanvas || to !in onCanvas) null else from to to
        }
        diagram = Diagram(byTable.mapValues { it.value.toList() }, edges)
    }

    private fun report(text: String, failed: Boolean) {
        message = text
        this.failed = failed
    }

    private companion object {
        /** A literal dollar, so the shell expands the exit code and Kotlin does not read a template. */
        val DOLLAR = Char(36).toString()

        const val ROLES_SQL =
            "SELECT rolname AS role, CASE WHEN rolcanlogin THEN 'yes' ELSE 'no' END AS can_login, " +
                "CASE WHEN rolsuper THEN 'yes' ELSE 'no' END AS superuser, " +
                "CASE WHEN rolcreatedb THEN 'yes' ELSE 'no' END AS create_db " +
                "FROM pg_roles ORDER BY rolname"

        const val GRANTS_SQL =
            "SELECT grantee, table_schema || '.' || table_name AS relation, " +
                "privilege_type AS privilege FROM information_schema.role_table_grants " +
                "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') " +
                "ORDER BY grantee, 2 LIMIT 500"

        fun diagramColumnsSql(inList: String): String =
            "SELECT c.table_schema || '.' || c.table_name, c.column_name, c.data_type, " +
                "CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END, " +
                "CASE WHEN fk.column_name IS NOT NULL THEN 1 ELSE 0 END " +
                "FROM information_schema.columns c " +
                "LEFT JOIN (SELECT kcu.table_schema, kcu.table_name, kcu.column_name " +
                "FROM information_schema.table_constraints tc " +
                "JOIN information_schema.key_column_usage kcu " +
                "ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema " +
                "WHERE tc.constraint_type = 'PRIMARY KEY') pk " +
                "ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name " +
                "AND pk.column_name = c.column_name " +
                "LEFT JOIN (SELECT kcu.table_schema, kcu.table_name, kcu.column_name " +
                "FROM information_schema.table_constraints tc " +
                "JOIN information_schema.key_column_usage kcu " +
                "ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema " +
                "WHERE tc.constraint_type = 'FOREIGN KEY') fk " +
                "ON fk.table_schema = c.table_schema AND fk.table_name = c.table_name " +
                "AND fk.column_name = c.column_name " +
                "WHERE (c.table_schema || '.' || c.table_name) IN (" + inList + ") " +
                "ORDER BY c.table_schema, c.table_name, c.ordinal_position"

        fun diagramKeysSql(inList: String): String =
            "SELECT DISTINCT tc.table_schema || '.' || tc.table_name, " +
                "ccu.table_schema || '.' || ccu.table_name " +
                "FROM information_schema.table_constraints tc " +
                "JOIN information_schema.constraint_column_usage ccu " +
                "ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema " +
                "WHERE tc.constraint_type = 'FOREIGN KEY' " +
                "AND (tc.table_schema || '.' || tc.table_name) IN (" + inList + ") " +
                "AND (ccu.table_schema || '.' || ccu.table_name) IN (" + inList + ")"

        /** Table and column in one line, split by the same byte the grid parser uses. */
        val SCHEMA_COLUMNS_SQL =
            "SELECT table_schema || '.' || table_name || chr(31) || column_name " +
                "FROM information_schema.columns " +
                "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') " +
                "ORDER BY table_schema, table_name, ordinal_position"

        const val TABLES_SQL =
            "SELECT table_schema || '.' || table_name FROM information_schema.tables " +
                "WHERE table_type = 'BASE TABLE' " +
                "AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1"

        /** A schema-qualified name, each half quoted so neither can be mistaken for a keyword. */
        fun qualified(full: String): String =
            full.split('.').joinToString(".") { Sh.ident(it) }

        fun columnsSql(full: String): String {
            val schema = full.substringBefore('.', "public")
            val name = full.substringAfter('.')
            return "SELECT c.ordinal_position::text, c.column_name, " +
                "c.data_type || COALESCE('(' || c.character_maximum_length || ')', ''), " +
                "c.is_nullable, COALESCE(c.column_default, ''), " +
                "COALESCE(k.constraint_type, '') " +
                "FROM information_schema.columns c " +
                "LEFT JOIN (SELECT kcu.column_name, tc.constraint_type " +
                "FROM information_schema.table_constraints tc " +
                "JOIN information_schema.key_column_usage kcu " +
                "ON kcu.constraint_name = tc.constraint_name " +
                "AND kcu.table_schema = tc.table_schema " +
                "WHERE tc.table_schema = " + Sh.literal(schema) +
                " AND tc.table_name = " + Sh.literal(name) + ") k " +
                "ON k.column_name = c.column_name " +
                "WHERE c.table_schema = " + Sh.literal(schema) +
                " AND c.table_name = " + Sh.literal(name) + " ORDER BY c.ordinal_position"
        }
    }
}
