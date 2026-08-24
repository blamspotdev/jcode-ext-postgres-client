package dev.blamspot.jcode.ext.pg

import dev.blamspot.jcode.ext.api.NativeExecResult
import dev.blamspot.jcode.ext.api.NativeHost

/** A result set, or what went wrong instead of one. */
internal data class Grid(
    val columns: List<String> = emptyList(),
    val rows: List<List<String?>> = emptyList(),
    val message: String = "",
    val error: String = "",
) {
    val ok: Boolean get() = error.isEmpty()
}

/**
 * psql, as run from JCode's runtime — directly, through a tunnel, or on the far side of one.
 *
 * The command is built once and the reach only decides where it runs. Anything else would mean
 * every query knowing how the server is reached, and three code paths through every pane.
 */
internal class Psql(private val host: NativeHost) {

    /** Set once a tunnel has been checked, so every query after the first does not re-check it. */
    private var tunnelReady = false

    /**
     * Run a query and read its rows.
     *
     * Unaligned output with control-byte delimiters, which is the only psql format that survives
     * values containing the punctuation a table format would use to draw itself.
     */
    suspend fun grid(conn: Conn, sql: String, db: String? = null, timeoutMs: Long = 120_000L): Grid {
        val blocked = ensureReachable(conn)
        if (blocked != null) return Grid(error = blocked)
        val flags = " -A -F " + Sh.quote(Sh.FIELD.toString()) +
            " -P null=" + Sh.quote(Sh.NULL.toString()) + " -q"
        return parse(output(run(conn, flags, sql, db, timeoutMs)))
    }

    /** One column of one query, for the many places that ask the server to list something. */
    suspend fun column(conn: Conn, sql: String, db: String? = null): Pair<List<String>, String> {
        val blocked = ensureReachable(conn)
        if (blocked != null) return emptyList<String>() to blocked
        val raw = output(run(conn, " -A -t -q", sql, db, 60_000L))
        val failure = failureIn(raw)
        if (failure.isNotEmpty()) return emptyList<String>() to failure
        return raw.lines().map { it.trim() }.filter { it.isNotEmpty() } to ""
    }

    /** A statement run for its effect: the message it printed, or the error it raised. */
    suspend fun statement(conn: Conn, sql: String, db: String? = null, timeoutMs: Long = 120_000L): Grid {
        val g = grid(conn, sql, db, timeoutMs)
        return if (g.ok && g.message.isEmpty()) g.copy(message = "OK") else g
    }

    /** A plain command in the runtime — the local server controls and the backup tools need one. */
    suspend fun shell(command: String, timeoutMs: Long = 60_000L): String =
        output(host.exec(command, timeoutMs = timeoutMs))

    // --- how the command is built, and where it runs -------------------------------------------

    private suspend fun run(
        conn: Conn,
        flags: String,
        sql: String,
        db: String?,
        timeoutMs: Long,
    ): NativeExecResult {
        val invocation = invocation(conn, db, flags, sql)
        val command = when (conn.reach) {
            // A tunnel changes where psql dials, not where it runs; direct changes neither.
            Reach.Direct, Reach.Tunnel -> invocation
            Reach.Remote -> sshCommand(conn.ssh) + " " + Sh.quote(invocation)
        }
        return host.exec(command + " 2>&1", timeoutMs = timeoutMs)
    }

    /**
     * psql, with the environment it reads its secrets from.
     *
     * `-w` never prompts: without it a wrong password hangs the call until it times out rather than
     * failing. `LC_ALL=C` silences the locale warning Debian's perl wrapper prints to stderr, which
     * is merged into the output here and would otherwise arrive as if it were data.
     */
    private fun invocation(conn: Conn, db: String?, flags: String, sql: String): String {
        val database = db?.takeIf { it.isNotBlank() } ?: conn.database.ifBlank { "postgres" }
        return "LC_ALL=C PGPASSWORD=" + Sh.quote(conn.password) +
            " PGCONNECT_TIMEOUT=15 PGSSLMODE=" + Sh.quote(conn.sslmode) +
            " psql -h " + Sh.quote(conn.dbHost) + " -p " + Sh.quote(conn.dbPort) +
            " -U " + Sh.quote(conn.user) + " -d " + Sh.quote(database) +
            " -w" + flags + " -c " + Sh.quote(sql)
    }

    /** ssh, carrying whichever secret this connection was given. */
    private fun sshCommand(ssh: Ssh, extra: String = ""): String {
        val options = " -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null" +
            " -o ConnectTimeout=15 -o LogLevel=ERROR"
        val target = " -p " + Sh.quote(ssh.port) + " " + Sh.quote(ssh.user + "@" + ssh.host)
        return when (ssh.auth) {
            SshAuth.Key -> {
                // IdentitiesOnly, or ssh offers every key an agent knows before the one named here,
                // and a server counting attempts refuses the connection before it reaches that one.
                val key = " -i " + Sh.quote(ssh.keyPath) + " -o IdentitiesOnly=yes"
                val unlock =
                    if (ssh.passphrase.isEmpty()) ""
                    else "sshpass -P assphrase -p " + Sh.quote(ssh.passphrase) + " "
                unlock + "ssh" + options + extra + key + target
            }

            SshAuth.Password ->
                "sshpass -p " + Sh.quote(ssh.password) + " ssh" + options + extra + target
        }
    }

    /**
     * Make sure the server can be reached at all, once per session.
     *
     * A tunnel is a process rather than a setting: it has to be running before the first query, it
     * outlives any one of them, and re-establishing it per query would open an SSH connection for
     * every keystroke in the query editor.
     */
    private suspend fun ensureReachable(conn: Conn): String? {
        val missing = conn.missing()
        if (missing != null) return missing
        if (conn.reach != Reach.Tunnel || tunnelReady) return null
        val tools = ensureSshTools(conn.ssh)
        if (tools != null) return tools
        val forward = "127.0.0.1:" + conn.ssh.localPort + ":" + conn.host + ":" + conn.port
        val running = shell(
            "pgrep -f " + Sh.quote(forward) + " >/dev/null 2>&1 && echo UP || echo DOWN",
            timeoutMs = 15_000L,
        )
        if (running.contains("UP")) {
            tunnelReady = true
            return null
        }
        // ExitOnForwardFailure, or ssh reports success having quietly forwarded nothing, and the
        // failure surfaces later as a connection refused against our own loopback — which reads as
        // the database being down rather than the tunnel never having opened.
        val open = sshCommand(conn.ssh, extra = " -f -N -o ExitOnForwardFailure=yes") +
            " -L " + Sh.quote(forward)
        val complaint = shell(open + " 2>&1", timeoutMs = 60_000L)
            .lines().firstOrNull { it.isNotBlank() }.orEmpty()
        if (complaint.isNotEmpty()) return "SSH tunnel failed: " + complaint
        tunnelReady = true
        return null
    }

    /** ssh and, when a password is in play, sshpass — neither is in the runtime by default. */
    private suspend fun ensureSshTools(ssh: Ssh): String? {
        val needsSshpass = ssh.auth == SshAuth.Password || ssh.passphrase.isNotEmpty()
        val probe = "command -v ssh >/dev/null 2>&1" +
            (if (needsSshpass) " && command -v sshpass >/dev/null 2>&1" else "") +
            " && echo OK || echo NO"
        if (shell(probe, timeoutMs = 15_000L).contains("OK")) return null
        val packages = "openssh-client" + if (needsSshpass) " sshpass" else ""
        shell(
            "apt-get update -y >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y " +
                "-o DPkg::Lock::Timeout=180 " + packages + " >/dev/null 2>&1",
            timeoutMs = 900_000L,
        )
        return if (shell(probe, timeoutMs = 15_000L).contains("OK")) null
        else "Could not install " + packages + " in the runtime."
    }

    // --- reading what psql printed -------------------------------------------------------------

    private fun output(r: NativeExecResult): String = (r.stdout + r.stderr).trimEnd()

    /**
     * Tell a result from a complaint.
     *
     * psql writes both to the same stream once stderr is merged, and a failed statement exits zero
     * often enough that the exit code cannot be trusted to separate them.
     */
    private fun failureIn(raw: String): String {
        val markers = listOf(
            "psql:", "ERROR:", "FATAL:", "PANIC:", "could not connect", "could not translate host",
            "connection to server", "Connection refused", "Connection reset",
            "could not receive data", "could not send data", "password authentication failed",
            "server closed the connection", "terminating connection", "timeout expired",
            "does not exist", "not found", "No such file or directory", "Permission denied",
        )
        return if (markers.any { raw.contains(it) }) raw else ""
    }

    private fun parse(raw: String): Grid {
        val failure = failureIn(raw)
        if (failure.isNotEmpty()) return Grid(error = failure)
        // Only the outer blank lines: an interior blank line is a single-column row holding an empty
        // string, and dropping those silently loses rows the server did return.
        val lines = raw.lines().dropWhile { it.isBlank() }.dropLastWhile { it.isBlank() }
        if (lines.isEmpty()) return Grid(message = "OK")
        val footer = lines.indexOfFirst { isRowCount(it.trim()) }
        if (footer < 0) return Grid(message = lines.firstOrNull { it.isNotBlank() }?.trim() ?: "OK")
        val header = lines.first().split(Sh.FIELD)
        val rows = lines.subList(1, footer).map { line ->
            line.split(Sh.FIELD).map { cell -> if (cell == Sh.NULL.toString()) null else cell }
        }
        return Grid(columns = header, rows = rows)
    }

    /** psql prints "(N rows)" after a tuple result, even unaligned — the anchor the parse needs. */
    private fun isRowCount(line: String): Boolean =
        line.startsWith("(") && (line.endsWith(" row)") || line.endsWith(" rows)")) &&
            line.drop(1).takeWhile { it.isDigit() }.isNotEmpty()
}
