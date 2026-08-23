package dev.blamspot.jcode.ext.pg

/**
 * Shell quoting, and the two bytes psql is asked to delimit its output with.
 *
 * Spelled with character codes rather than escapes: these end up inside shell strings that are
 * themselves inside Kotlin strings, and every layer of quoting is a layer to get wrong.
 */
internal object Sh {

    /** One argument, safe whatever is in it — a password with a quote in it included. */
    fun quote(value: String): String = "'" + value.replace("'", ESCAPED_QUOTE) + "'"

    private val ESCAPED_QUOTE = "'" + Char(92) + "''"

    /**
     * Field and null markers.
     *
     * Control bytes rather than a comma or a pipe: either can appear in a value, and psql's
     * unaligned output has no quoting to tell a delimiter from the data. Neither of these can come
     * out of a text column.
     */
    val FIELD: Char = Char(0x1F)
    val NULL: Char = Char(0x1E)

    /**
     * A PostgreSQL identifier, always quoted.
     *
     * Always, not only when it needs to be: a name that looks safe today is a reserved word in the
     * next major version, and folding to lower case silently addresses a different table.
     */
    fun ident(name: String): String = DOUBLE + name.replace(DOUBLE, DOUBLE + DOUBLE) + DOUBLE

    /** A PostgreSQL string literal. */
    fun literal(value: String): String = "'" + value.replace("'", "''") + "'"

    private val DOUBLE = Char(34).toString()
}
