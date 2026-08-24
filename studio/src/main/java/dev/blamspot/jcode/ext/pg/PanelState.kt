package dev.blamspot.jcode.ext.pg

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.blamspot.jcode.ext.api.NativeHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One database on the server, and how much of the disk it is using. */
internal data class Database(val name: String, val size: String)

/** Where the local server has got to. */
internal data class Local(
    val installed: Boolean = false,
    val initialized: Boolean = false,
    val running: Boolean = false,
)

/**
 * The drawer: a server, the databases on it, and the local server it can be.
 *
 * Everything the panel knows it asked the server for, because a database is not a file that can be
 * watched — the only way to know what is there is to ask, and the only honest moment to ask is when
 * something changed or the user said to.
 */
internal class PanelState(
    private val host: NativeHost,
    private val scope: CoroutineScope,
) {
    private val psql = Psql(host)

    var conn by mutableStateOf(Conn.from(emptyMap()))
        private set

    var loading by mutableStateOf(true)
        private set
    var busy by mutableStateOf(false)
        private set

    /** The last thing that went wrong, shown in place rather than thrown away. */
    var error by mutableStateOf("")
        private set

    /** Whether the psql client is in the runtime at all — nothing works without it. */
    var clientInstalled by mutableStateOf(true)
        private set

    var local by mutableStateOf(Local())
        private set

    /** What the setup script has printed so far, when one is running. */
    val log = mutableStateListOf<String>()

    val databases = mutableStateListOf<Database>()

    /** The question on screen, if one is. */
    var confirm by mutableStateOf<Confirm?>(null)

    fun boot() {
        scope.launch {
            loading = true
            refresh()
            loading = false
        }
    }

    fun reload() {
        if (busy) return
        scope.launch {
            busy = true
            refresh()
            busy = false
        }
    }

    private suspend fun refresh() {
        conn = Conn.from(host.config())
        clientInstalled = psql.shell(
            "command -v psql >/dev/null 2>&1 && echo OK || echo NO",
            timeoutMs = 15_000L,
        ).contains("OK")
        local = probeLocal()
        if (clientInstalled) listDatabases() else databases.clear()
    }

    // --- the server, and what is on it ----------------------------------------------------------

    private suspend fun listDatabases() {
        // Size and name in one pass: two queries would be two round trips over a link that may be a
        // tunnel, and the sizes would be from a moment other than the names.
        val g = psql.grid(
            conn,
            "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database " +
                "WHERE datistemplate = false ORDER BY datname",
        )
        error = g.error
        databases.clear()
        if (!g.ok) return
        g.rows.forEach { row ->
            val name = row.getOrNull(0).orEmpty()
            if (name.isNotEmpty()) databases += Database(name, row.getOrNull(1).orEmpty())
        }
    }

    /** Open a database in its own tab. A studio is a sitting, not a glance past the drawer. */
    fun open(database: String) = host.openView("db:" + encode(database), title = database)

    fun createDatabase() {
        confirm = Confirm(
            title = "New database",
            body = "Create a database on " + conn.host + ".",
            action = "Create",
            destructive = false,
            input = "",
            placeholder = "Database name",
        ) { name ->
            if (name.isNotBlank()) ddl("CREATE DATABASE " + Sh.ident(name), "Created " + name + ".")
        }
    }

    fun renameDatabase(name: String) {
        confirm = Confirm(
            title = "Rename database",
            body = "Rename " + name + ".",
            action = "Rename",
            destructive = false,
            input = name,
            placeholder = "New name",
        ) { to ->
            if (to.isNotBlank() && to != name) {
                ddl("ALTER DATABASE " + Sh.ident(name) + " RENAME TO " + Sh.ident(to), "Renamed to " + to + ".")
            }
        }
    }

    fun dropDatabase(name: String) {
        confirm = Confirm(
            title = "Drop database",
            body = "Drop " + name + " and everything in it? This cannot be undone.",
            action = "Drop",
        ) {
            // WITH (FORCE) so an idle connection someone left open does not make this fail with a
            // message about other sessions that the user has no way to act on from here.
            ddl("DROP DATABASE " + Sh.ident(name) + " WITH (FORCE)", "Dropped " + name + ".")
        }
    }

    private fun ddl(sql: String, done: String) {
        if (busy) return
        scope.launch {
            busy = true
            // Against the connection database: a database cannot be created, renamed or dropped
            // from a session connected to it.
            val r = psql.statement(conn, sql, conn.database)
            if (r.ok) host.snackbar(done) else host.snackbar("Failed", "Show detail") { error = r.error }
            error = r.error
            refresh()
            busy = false
        }
    }

    // --- the local server ------------------------------------------------------------------------

    private suspend fun probeLocal(): Local {
        val probe = psql.shell(
            "echo BIN=$(ls " + BIN_GLOB + "/postgres 2>/dev/null | head -1); " +
                "echo INIT=$(test -f " + Sh.quote(DATA + "/PG_VERSION") + " && echo yes)",
            timeoutMs = 15_000L,
        )
        return Local(
            installed = probe.contains("BIN=/usr"),
            initialized = probe.contains("INIT=yes"),
            running = host.serviceRunning(SERVICE),
        )
    }

    private suspend fun binDir(): String =
        psql.shell("ls -d " + BIN_GLOB + " 2>/dev/null | sort -V | tail -1", timeoutMs = 15_000L).trim()

    /**
     * Install, initialise and start a PostgreSQL server inside the runtime.
     *
     * Long, and every step says so: this installs a package, unpacks a shim, builds a cluster and
     * waits for a server, and silence across that stretch reads as a hang.
     */
    fun setUpLocal() {
        if (busy) return
        scope.launch {
            busy = true
            log.clear()
            error = ""
            setUp()
            busy = false
            refresh()
        }
    }

    private suspend fun setUp() {
        if (!probeLocal().installed) {
            say("Installing PostgreSQL (native arm64)…")
            psql.shell(
                "export DEBIAN_FRONTEND=noninteractive; apt-get install -y " +
                    "-o DPkg::Lock::Timeout=180 postgresql 2>&1 | tail -3",
                timeoutMs = 900_000L,
            )
        }
        val bin = binDir()
        if (bin.isEmpty()) {
            say("The postgres binaries are still not here — the install did not finish.")
            return
        }

        say("Installing the shared-memory shim…")
        val shim = psql.shell(
            "mkdir -p /usr/local/lib && printf %s " + Sh.quote(SHIM_GZ_BASE64) +
                " | base64 -d | gzip -dc > " + Sh.quote(SHIM) +
                " && chmod 644 " + Sh.quote(SHIM) + " && echo OK",
            timeoutMs = 60_000L,
        )
        if (!shim.contains("OK")) {
            say("The shim would not install: " + shim)
            return
        }

        if (!probeLocal().initialized) {
            say("Initialising the cluster…")
            val init = psql.shell(
                "rm -rf " + Sh.quote(DATA) + " && mkdir -p " + Sh.quote(DATA) +
                    " && chown postgres:postgres " + Sh.quote(DATA) +
                    " && chmod 700 " + Sh.quote(DATA) +
                    " && su postgres -c " + Sh.quote(
                        "LC_ALL=C LD_PRELOAD=" + SHIM + " " + bin + "/initdb -D " + DATA +
                            " -U postgres --locale=C --auth-host=scram-sha-256 --auth-local=trust" +
                            " --no-instructions --no-sync",
                    ) + " 2>&1 | tail -4; test -f " + Sh.quote(DATA + "/PG_VERSION") + " && echo INITDB_OK",
                timeoutMs = 300_000L,
            )
            if (!init.contains("INITDB_OK")) {
                say("initdb failed: " + init)
                return
            }
            // mmap for both, because the SysV path is the one Android does not have; the rest keeps
            // a server meant to share a phone with an IDE from claiming what an IDE needs.
            psql.shell(
                "printf %s " + Sh.quote(
                    "listen_addresses = '127.0.0.1'" + NEWLINE + "port = " + PORT + NEWLINE +
                        "unix_socket_directories = '" + SOCKET + "'" + NEWLINE +
                        "shared_memory_type = mmap" + NEWLINE +
                        "dynamic_shared_memory_type = mmap" + NEWLINE +
                        "shared_buffers = 32MB" + NEWLINE + "max_connections = 50" + NEWLINE,
                ) + " >> " + Sh.quote(DATA + "/postgresql.conf"),
                timeoutMs = 15_000L,
            )
        }

        say("Starting the server…")
        stopProcess(bin, "immediate")
        if (!host.serviceStart(SERVICE, startCommand(bin))) {
            say("The workbench would not start the service.")
            return
        }

        say("Waiting for it to answer…")
        if (!waitForServer()) say("It has not answered yet — try Start again in a moment.")

        // A password set over the trusted local socket, then stored as the client's own settings, so
        // the very first connection after setup works without anyone being asked to invent one.
        val password = "jc_" + java.util.UUID.randomUUID().toString().replace("-", "").take(16)
        psql.shell(
            "su postgres -c " + Sh.quote(
                "LC_ALL=C psql -h " + SOCKET + " -p " + PORT + " -d postgres -Atc " +
                    Sh.quote("ALTER USER postgres PASSWORD " + Sh.literal(password)),
            ) + " 2>&1",
            timeoutMs = 30_000L,
        )
        host.setConfig("pg.host", "127.0.0.1")
        host.setConfig("pg.port", PORT)
        host.setConfig("pg.user", "postgres")
        host.setConfig("pg.password", password)
        host.setConfig("pg.database", "postgres")
        host.setConfig("pg.sslmode", "disable")
        host.setConfig("pg.ssh.mode", Reach.Direct.id)
        say("Done.")
        host.snackbar("Local PostgreSQL is running.")
    }

    fun startLocal() {
        if (busy) return
        scope.launch {
            busy = true
            val bin = binDir()
            if (bin.isEmpty()) {
                host.snackbar("PostgreSQL is not installed in the runtime.")
            } else {
                stopProcess(bin, "immediate")
                val started = host.serviceStart(SERVICE, startCommand(bin))
                waitForServer()
                host.snackbar(if (started) "Local server started." else "It would not start.")
            }
            refresh()
            busy = false
        }
    }

    fun stopLocal() {
        if (busy) return
        scope.launch {
            busy = true
            val bin = binDir()
            if (bin.isEmpty()) host.serviceStop(SERVICE) else stopProcess(bin, "fast")
            host.snackbar("Local server stopped.")
            refresh()
            busy = false
        }
    }

    /**
     * The command the service supervises.
     *
     * Run as the postgres user, because the server refuses to run as root; the preload is set inside
     * the -c string because su drops it from the environment it passes on.
     */
    private fun startCommand(bin: String): String =
        "su postgres -c " + Sh.quote("LC_ALL=C LD_PRELOAD=" + SHIM + " " + bin + "/postgres -D " + DATA)

    /**
     * Stop the postmaster through its own pidfile.
     *
     * It is launched through su, which puts it in another session, so stopping the service wrapper
     * does not reliably reach it. Harmless when nothing is running.
     */
    private suspend fun stopProcess(bin: String, mode: String) {
        psql.shell(
            "su postgres -c " + Sh.quote(
                "LC_ALL=C " + bin + "/pg_ctl -D " + DATA + " stop -m " + mode + " -w -t 20",
            ) + " 2>/dev/null; true",
            timeoutMs = 60_000L,
        )
        host.serviceStop(SERVICE)
    }

    private suspend fun waitForServer(): Boolean {
        repeat(25) {
            val ping = psql.shell(
                "su postgres -c " + Sh.quote(
                    "LC_ALL=C psql -h " + SOCKET + " -p " + PORT + " -d postgres -Atc " +
                        Sh.quote("SELECT 1"),
                ) + " 2>/dev/null",
                timeoutMs = 15_000L,
            )
            if (ping.trim() == "1") return true
            delay(1_500)
        }
        return false
    }

    private fun say(line: String) {
        log += line
    }

    private companion object {
        const val DATA = "/var/lib/postgresql/jcode"
        const val SHIM = "/usr/local/lib/libandroshm.so"
        const val SERVICE = "pglocal"
        const val PORT = "5432"
        const val SOCKET = "/tmp"
        const val BIN_GLOB = "/usr/lib/postgresql/*/bin"
        val NEWLINE = Char(10).toString()
    }
}

/** A database name as a view id can carry it. */
internal fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")

internal fun decode(value: String): String = java.net.URLDecoder.decode(value, "UTF-8")
