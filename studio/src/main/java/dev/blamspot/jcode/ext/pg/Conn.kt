package dev.blamspot.jcode.ext.pg

/** How the client reaches the server. */
internal enum class Reach(val id: String, val label: String) {
    /** Straight at the host, from inside JCode's runtime. */
    Direct("off", "Direct"),

    /** Through an SSH port-forward, for a server only its own network can see. */
    Tunnel("tunnel", "SSH tunnel"),

    /** psql runs on the far side of the connection and only its output comes back. */
    Remote("ssh", "Run over SSH"),
    ;

    companion object {
        fun of(id: String): Reach = entries.firstOrNull { it.id == id } ?: Direct
    }
}

/** Which secret gets the SSH connection open. */
internal enum class SshAuth(val id: String) {
    Key("key"),
    Password("password"),
    ;

    companion object {
        fun of(id: String): SshAuth = entries.firstOrNull { it.id == id } ?: Key
    }
}

/**
 * Everything needed to reach one server, as the app's Settings hold it.
 *
 * Read here rather than edited: host, role and password are JCode settings, and a second place to
 * type them would be a second place for them to disagree.
 */
internal data class Conn(
    val host: String,
    val port: String,
    val user: String,
    val password: String,
    val database: String,
    val sslmode: String,
    val reach: Reach,
    val ssh: Ssh,
) {
    /**
     * Where psql should look for the server.
     *
     * Through a tunnel that is the near end of it rather than the server's own address — the point
     * of the forward is that the server's address means nothing on this side of it.
     */
    val dbHost: String get() = if (reach == Reach.Tunnel) "127.0.0.1" else host

    val dbPort: String get() = if (reach == Reach.Tunnel) ssh.localPort else port

    /** What is missing before a connection can be attempted, or null when nothing is. */
    fun missing(): String? = if (reach == Reach.Direct) null else ssh.missing()

    companion object {
        fun from(config: Map<String, String>): Conn {
            fun value(key: String, fallback: String): String =
                config[key]?.trim().orEmpty().ifBlank { fallback }
            return Conn(
                host = value("pg.host", "localhost"),
                port = value("pg.port", "5432"),
                user = value("pg.user", "postgres"),
                password = config["pg.password"].orEmpty(),
                database = value("pg.database", "postgres"),
                sslmode = value("pg.sslmode", "prefer"),
                reach = Reach.of(value("pg.ssh.mode", "off")),
                ssh = Ssh(
                    host = value("pg.ssh.host", ""),
                    port = value("pg.ssh.port", "22"),
                    user = value("pg.ssh.user", ""),
                    auth = SshAuth.of(value("pg.ssh.auth", "key")),
                    password = config["pg.ssh.password"].orEmpty(),
                    keyPath = value("pg.ssh.key", ""),
                    passphrase = config["pg.ssh.passphrase"].orEmpty(),
                    localPort = value("pg.ssh.localPort", "15432"),
                ),
            )
        }
    }
}

/** The SSH half of a connection; unused when the reach is [Reach.Direct]. */
internal data class Ssh(
    val host: String,
    val port: String,
    val user: String,
    val auth: SshAuth,
    val password: String,
    val keyPath: String,
    val passphrase: String,
    val localPort: String,
) {
    /**
     * What is missing before this can be attempted at all.
     *
     * Said before anything is run, because ssh's own complaint about a half-filled connection is a
     * usage message, and a usage message is not an answer to "why did nothing happen".
     */
    fun missing(): String? = when {
        host.isBlank() -> "Set the SSH host in Settings."
        user.isBlank() -> "Set the SSH user in Settings."
        auth == SshAuth.Key && keyPath.isBlank() -> "Set the SSH key file in Settings."
        auth == SshAuth.Password && password.isBlank() -> "Set the SSH password in Settings."
        else -> null
    }
}
