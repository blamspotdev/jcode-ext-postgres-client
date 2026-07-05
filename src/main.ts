// Postgres Client — JCode extension UI (TypeScript, bundled to www/main.js by esbuild).
// Talks to a PostgreSQL server over the ARM64-native `psql` client in the Linux runtime, via the
// JCode Extension API v1. Two surfaces from one bundle (by location.hash):
//   • the left-drawer database list (connection status + browse databases), and
//   • a per-database studio opened as an editor tab (workbench.openView) with
//     Tables / Query / Diagram / Security / Backup panes.
// Connection auth (host / port / role / password / database) lives in app Settings and is read
// through the config.* API, so no credentials are entered in this UI.

import { SHIM_GZ_B64 } from './shim';

interface ApiResult { ok: boolean; data?: any; error?: string }
interface ExecResult { stdout: string; stderr: string; exitCode: number; error?: string }
interface Conn { host: string; port: string; user: string; password: string; database: string; sslmode: string }
interface Grid { columns: string[]; rows: string[][]; error?: string; message?: string }

// ---- Extension API v1 bridge ----
const pending: Record<string, (r: ApiResult) => void> = {};
let seq = 0;
function api(type: string, payload?: unknown): Promise<ApiResult> {
  return new Promise((resolve) => {
    const id = 'q' + (seq++);
    pending[id] = resolve;
    try {
      (window as any).JCodeNative.request(id, JSON.stringify({ type, payload: payload ?? {} }));
    } catch (e) {
      delete pending[id];
      resolve({ ok: false, error: 'bridge unavailable: ' + e });
    }
  });
}
(window as any).JCode = {
  request: api,
  _onResult(id: string, jsonString: string) {
    const cb = pending[id];
    if (!cb) return;
    delete pending[id];
    let r: ApiResult;
    try { r = JSON.parse(jsonString); } catch { r = { ok: false, error: jsonString }; }
    cb(r);
  },
  _onEvent(name: string) { if (name === 'config') void boot(); },
};

// ---- helpers ----
function $<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const sh = (v: string | number) => "'" + String(v).replace(/'/g, "'\\''") + "'";
const out = (r: ExecResult) => ((r.stdout || '') + (r.stderr || '')).replace(/\s+$/, '');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const SEP = String.fromCharCode(0x1f);
// psql field separator: the ASCII unit-separator byte (0x1f), which never appears in ordinary data.
// NULLTOK (record-separator 0x1e) marks a SQL NULL distinctly from an empty string in grid output — psql
// prints BOTH as an empty field by default, so `-P null=<0x1e>` is what lets the grid/edit code tell them
// apart. queryGrid maps it back to the literal token 'NULL' (the same sentinel the SQL Client keys on).
const NULLTOK = String.fromCharCode(0x1e);
const PG_GRID_FLAGS = " -A -F \"$(printf '\\037')\" -P null=\"$(printf '\\036')\" -q";
const PG_SCALAR_FLAGS = " -A -t -q";

async function exec(command: string, timeoutMs = 60000): Promise<ExecResult> {
  const r = await api('exec.run', { command, timeoutMs });
  if (!r || !r.ok) return { stdout: '', stderr: (r && r.error) || 'request failed', exitCode: -1 };
  return r.data as ExecResult;
}

// ---- connection (from app Settings via config.*) ----
async function loadConn(): Promise<Conn> {
  const r = await api('config.all');
  const c = (r.ok && r.data) ? r.data as Record<string, any> : {};
  const s = (k: string, d: string) => { const v = String(c[k] ?? '').trim(); return v || d; };
  return {
    host: s('pg.host', 'localhost'),
    port: s('pg.port', '5432'),
    user: s('pg.user', 'postgres'),
    password: String(c['pg.password'] ?? ''),
    database: s('pg.database', 'postgres'),
    sslmode: s('pg.sslmode', 'prefer'),
  };
}

// psql reads the password from PGPASSWORD; -w never prompts (fails instead of hanging).
// LC_ALL=C silences the "perl: warning: Setting locale failed" noise from Debian's pg_wrapper
// (the perl frontend that /usr/bin/psql, pg_dump, … really are) when the runtime has no generated
// locale — those warnings go to stderr and, merged via 2>&1, would otherwise pollute query output.
function pgEnv(c: Conn): string {
  return 'LC_ALL=C PGPASSWORD=' + sh(c.password) + ' PGCONNECT_TIMEOUT=15 PGSSLMODE=' + sh(c.sslmode) + ' ';
}
function psqlBase(c: Conn, db?: string): string {
  return pgEnv(c) + 'psql -h ' + sh(c.host) + ' -p ' + sh(c.port) + ' -U ' + sh(c.user) +
    ' -d ' + sh(db || c.database || 'postgres') + ' -w';
}

function isPgError(t: string): string {
  return /(^|\n)\s*(psql:|ERROR:|FATAL:|PANIC:|could not connect|could not translate host|connection to server|Connection refused|Connection reset|could not receive data|could not send data|password authentication failed|server closed the connection|terminating connection|timeout expired|database ".*" does not exist|role ".*" does not exist|(psql|sh):[^\n]*not found|No such file or directory)/i.test(t) ? t : '';
}

// Run a SELECT and parse psql's unaligned (-A -F␟) output: header␟header, then data rows, then a
// "(N rows)" footer we drop. Single-column results have no separator — that is expected.
async function queryGrid(c: Conn, sql: string, db?: string, timeoutMs = 120000): Promise<Grid> {
  const cmd = psqlBase(c, db) + PG_GRID_FLAGS + ' -c ' + sh(sql) + ' 2>&1';
  const raw = out(await exec(cmd, timeoutMs));
  const e = isPgError(raw);
  if (e) return { columns: [], rows: [], error: raw };
  // Strip only leading/trailing blank lines; DO NOT drop interior blanks — a single-column NULL/'' row
  // serializes to an empty (or NULLTOK-only) line, and blanket-filtering blanks would silently lose it.
  const all = raw.split('\n');
  let s = 0; while (s < all.length && all[s].trim() === '') s++;
  let en = all.length; while (en > s && all[en - 1].trim() === '') en--;
  const lines = all.slice(s, en);
  if (!lines.length) return { columns: [], rows: [], message: 'OK' };
  // A tuple result ends with a "(N rows)" footer (printed even in unaligned mode); anchor on it so interior
  // blank data rows are preserved. No footer ⇒ a non-SELECT command tag (CREATE TABLE, INSERT 0 1, …).
  const footerIdx = lines.findIndex((l) => /^\(\d+ rows?\)$/.test(l.trim()));
  if (footerIdx < 0) {
    const body = lines.filter((l) => l.trim() !== '');
    if (body.length === 1 && body[0].indexOf(SEP) < 0 &&
      /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET|GRANT|REVOKE|TRUNCATE|COPY|DO|COMMENT|VACUUM|ANALYZE|REINDEX|CLUSTER|LOCK|SAVEPOINT|RELEASE|SHOW)\b/i.test(body[0].trim())) {
      return { columns: [], rows: [], message: body[0].trim() };
    }
    return { columns: [], rows: [], message: raw || 'OK' };
  }
  const cell = (f: string) => (f === NULLTOK ? 'NULL' : f);
  const columns = lines[0].split(SEP);
  const rows = lines.slice(1, footerIdx).map((l) => l.split(SEP).map(cell));
  return { columns, rows };
}

// Run a one-column SELECT and return the values (for db / table lists). -t = tuples only.
async function scalarList(c: Conn, sql: string, db?: string): Promise<{ values: string[]; error?: string }> {
  const cmd = psqlBase(c, db) + PG_SCALAR_FLAGS + ' -c ' + sh(sql) + ' 2>&1';
  const raw = out(await exec(cmd, 60000));
  const e = isPgError(raw);
  if (e) return { values: [], error: raw };
  const values = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  return { values };
}

// Postgres identifier / literal quoting.
const pgId = (name: string) => '"' + String(name).replace(/"/g, '""') + '"';
const pgQualified = (name: string) => String(name).split('.').filter(Boolean).map(pgId).join('.');
const pgStr = (v: string) => "'" + String(v).replace(/'/g, "''") + "'";

// ---- modal ----
interface FormField { key: string; label: string; value?: string; placeholder?: string; type?: string }
function showModal(opts: {
  title: string; body?: string; fields?: FormField[]; confirmLabel: string; danger?: boolean;
  onConfirm: (values: Record<string, string>) => void;
}) {
  const back = document.createElement('div'); back.className = 'modal-scrim';
  const dlg = document.createElement('div'); dlg.className = 'modal';
  let html = '<div class="modal-title">' + esc(opts.title) + '</div>';
  if (opts.body) html += '<div class="modal-body">' + opts.body + '</div>';
  (opts.fields || []).forEach((f) => {
    const ctrl = f.type === 'textarea'
      ? '<textarea id="__f_' + f.key + '" rows="6"></textarea>'
      : '<input id="__f_' + f.key + '" type="' + (f.type || 'text') + '">';
    html += '<div class="field"><label>' + esc(f.label) + '</label>' + ctrl + '</div>';
  });
  html += '<div class="modal-actions"><button class="btn ghost" id="__cancel">Cancel</button>' +
    '<button class="btn ' + (opts.danger ? 'dfill' : 'primary') + '" id="__ok">' + esc(opts.confirmLabel) + '</button></div>';
  dlg.innerHTML = html; back.appendChild(dlg); document.body.appendChild(back);
  (opts.fields || []).forEach((f) => {
    const inp = $('__f_' + f.key) as HTMLInputElement | HTMLTextAreaElement;
    inp.value = f.value ?? ''; (inp as HTMLInputElement).placeholder = f.placeholder ?? '';
    inp.autocapitalize = 'none'; inp.spellcheck = false;
    // Enter confirms (except in a textarea) — so the dialog is usable even when the on-screen
    // keyboard leaves no room to reach the buttons.
    if (f.type !== 'textarea') {
      inp.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); ($('__ok') as HTMLButtonElement).click(); }
      });
    }
  });
  // Keep the focused field centered in the visible viewport. The on-screen keyboard opens AFTER the
  // field is focused (and can leave very little room in landscape), so a one-shot scroll runs too
  // early — re-scroll on every viewport resize (keyboard show/animation) while the dialog is open.
  const scrollFocused = () => {
    const el = dlg.querySelector('input:focus, textarea:focus') as HTMLElement | null;
    if (el) { try { el.scrollIntoView({ block: 'center' }); } catch { /* noop */ } }
  };
  const vv = window.visualViewport;
  window.addEventListener('resize', scrollFocused);
  if (vv) vv.addEventListener('resize', scrollFocused);
  const first = opts.fields && opts.fields[0] ? ($('__f_' + opts.fields[0].key) as HTMLElement) : null;
  if (first) setTimeout(() => { first.focus(); scrollFocused(); }, 40);
  const close = () => {
    window.removeEventListener('resize', scrollFocused);
    if (vv) vv.removeEventListener('resize', scrollFocused);
    back.remove();
  };
  $('__cancel').onclick = close;
  $('__ok').onclick = () => {
    const values: Record<string, string> = {};
    (opts.fields || []).forEach((f) => { values[f.key] = ($('__f_' + f.key) as HTMLInputElement).value; });
    close();
    opts.onConfirm(values);
  };
  back.onclick = (e) => { if (e.target === back) close(); };
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t && t.remove(); }, 3400);
}

// SVG glyphs
const IC_DB = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 1c3.3 0 6 .9 6 2v10c0 1.1-2.7 2-6 2s-6-.9-6-2V3c0-1.1 2.7-2 6-2zm0 1.5C5.5 2.5 3.5 3 3.5 3.5S5.5 4.5 8 4.5s4.5-.5 4.5-1S10.5 2.5 8 2.5zM3.5 6.2v2.1C3.5 8.8 5.5 9.3 8 9.3s4.5-.5 4.5-1V6.2C11.3 6.8 9.7 7 8 7s-3.3-.2-4.5-.8zm0 4v2.3c0 .5 2 1 4.5 1s4.5-.5 4.5-1v-2.3c-1.2.6-2.8.8-4.5.8s-3.3-.2-4.5-.8z"/></svg>';
const IC_TABLE = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9A1.5 1.5 0 0112.5 14h-9A1.5 1.5 0 012 12.5v-9zm1.5 0V6h9V3.5h-9zm0 4V10H7V7.5H3.5zm5 0V10h4V7.5h-4zM3.5 11.5v1h3.5v-1H3.5zm5 0v1h4v-1h-4z"/></svg>';
const IC_CHEV = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
const IC_PLUS = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M7.25 2.75h1.5V7.25h4.5v1.5h-4.5v4.5h-1.5v-4.5h-4.5v-1.5h4.5z"/></svg>';
const IC_REFRESH = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 3a5 5 0 104.546 2.914.75.75 0 011.364-.626A6.5 6.5 0 118 1.5V.31c0-.28.32-.44.55-.28l2.3 1.65c.18.13.18.4 0 .53l-2.3 1.65a.35.35 0 01-.55-.28V3z"/></svg>';
const IC_EDIT = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.1 1.9a1.5 1.5 0 012.1 2.1l-.8.8-2.1-2.1.8-.8zM10.2 3.8l2.1 2.1-6.8 6.8-2.6.6.6-2.6 6.7-6.9z"/></svg>';
const IC_TRASH = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 1.5h3a1 1 0 011 1V3H13v1.5h-1V13A1.5 1.5 0 0110.5 14.5h-5A1.5 1.5 0 014 13V4.5H3V3h2.5v-.5a1 1 0 011-1zm.5 1.5v.5h2V3H7zM5.5 4.5V13h5V4.5h-5zm1.5 1.5h1v5H7V6zm2 0h1v5H9V6z"/></svg>';
const IC_PLAY = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M4.5 2.6v10.8a.6.6 0 0 0 .92.5l8.4-5.4a.6.6 0 0 0 0-1l-8.4-5.4a.6.6 0 0 0-.92.5z"/></svg>';
const IC_KEBAB = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 3.6A1.3 1.3 0 1 1 8 1a1.3 1.3 0 0 1 0 2.6zm0 5.7a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zM8 15a1.3 1.3 0 1 1 0-2.6A1.3 1.3 0 0 1 8 15z"/></svg>';
const IC_COLLAPSE = '<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M10 3.5 5.5 8 10 12.5"/></svg>';
const IC_EXPAND = '<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M6 3.5 10.5 8 6 12.5"/></svg>';
const IC_CHEVDOWN = '<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M3.5 6 8 10.5 12.5 6"/></svg>';
// Restore-from-file: a down-arrow dropping into an open tray (import a dump).
const IC_RESTORE = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M7.25 1.5h1.5v6.19l2.22-2.22 1.06 1.06L8 10.56 3.97 6.53l1.06-1.06 2.22 2.22V1.5zM2.5 10.5H4v3h8v-3h1.5v3A1.5 1.5 0 0 1 12 15H4a1.5 1.5 0 0 1-1.5-1.5v-3z"/></svg>';
// Back-up-to-file: a floppy-disk save glyph.
const IC_SAVE = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2H11l3 3v7.5A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-9zm2 0v3h6v-2.7l-.3-.3H4zm.5 5.5A.5.5 0 0 0 4 9.5v3h8v-3a.5.5 0 0 0-.5-.5h-7z"/></svg>';
// Databases the client never renames/drops from the UI.
const SYSTEM_DBS = ['postgres', 'template0', 'template1'];

// ==========================================================================
// SQL EDITOR — syntax highlighting + schema-aware completion (PostgreSQL) for the Query box
// ==========================================================================
const SQL_KEYWORDS = ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'alter', 'drop', 'table', 'view', 'materialized', 'index', 'sequence', 'function', 'procedure', 'trigger', 'database', 'schema', 'extension', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'lateral', 'natural', 'on', 'using', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'exists', 'between', 'like', 'ilike', 'similar', 'order', 'by', 'group', 'having', 'distinct', 'limit', 'offset', 'fetch', 'with', 'recursive', 'union', 'all', 'except', 'intersect', 'case', 'when', 'then', 'else', 'end', 'begin', 'commit', 'rollback', 'savepoint', 'grant', 'revoke', 'add', 'column', 'constraint', 'primary', 'key', 'foreign', 'references', 'unique', 'check', 'default', 'cascade', 'restrict', 'asc', 'desc', 'nulls', 'first', 'last', 'only', 'over', 'partition', 'window', 'returning', 'conflict', 'do', 'nothing', 'generated', 'always', 'identity', 'temporary', 'temp', 'unlogged', 'if', 'analyze', 'vacuum', 'explain', 'copy', 'truncate', 'comment', 'owner', 'role', 'login', 'password', 'true', 'false', 'array', 'collate', 'tablespace', 'concurrently'];
const SQL_FUNCS = ['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least', 'cast', 'now', 'current_date', 'current_time', 'current_timestamp', 'localtime', 'localtimestamp', 'age', 'date_part', 'date_trunc', 'extract', 'to_char', 'to_date', 'to_timestamp', 'to_number', 'length', 'char_length', 'substring', 'substr', 'position', 'strpos', 'replace', 'regexp_replace', 'regexp_matches', 'split_part', 'trim', 'ltrim', 'rtrim', 'btrim', 'lpad', 'rpad', 'upper', 'lower', 'initcap', 'concat', 'concat_ws', 'format', 'abs', 'ceil', 'ceiling', 'floor', 'round', 'trunc', 'power', 'sqrt', 'mod', 'random', 'gen_random_uuid', 'uuid_generate_v4', 'row_number', 'rank', 'dense_rank', 'ntile', 'lead', 'lag', 'first_value', 'last_value', 'string_agg', 'array_agg', 'json_agg', 'jsonb_agg', 'jsonb_build_object', 'json_build_object', 'to_json', 'to_jsonb', 'array_length', 'unnest', 'generate_series', 'nextval', 'currval', 'setval', 'pg_typeof', 'version'];
const SQL_TYPESET = ['integer', 'int', 'int2', 'int4', 'int8', 'smallint', 'bigint', 'serial', 'bigserial', 'smallserial', 'boolean', 'bool', 'numeric', 'decimal', 'real', 'double', 'precision', 'float', 'float4', 'float8', 'money', 'char', 'character', 'varchar', 'text', 'bytea', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'xml', 'cidr', 'inet', 'macaddr', 'bit', 'varbit', 'point', 'line', 'box', 'polygon', 'tsvector', 'tsquery', 'oid', 'regclass', 'name'];
const KW_SET = new Set(SQL_KEYWORDS);
const FN_SET = new Set(SQL_FUNCS);
const TY_SET = new Set(SQL_TYPESET);

interface Suggest { label: string; insert: string; kind: string; meta?: string }
const KW_SUGGESTS: Suggest[] = SQL_KEYWORDS.map((k) => ({ label: k.toUpperCase(), insert: k.toUpperCase(), kind: 'kw' }))
  .concat(SQL_FUNCS.map((k) => ({ label: k, insert: k, kind: 'fn' })))
  .concat(SQL_TYPESET.map((k) => ({ label: k, insert: k, kind: 'ty' })));

// Tokenize SQL into colored <span>s for the highlight layer. Every emitted substring is HTML-escaped;
// gaps the regex skips (odd chars) are emitted as plain escaped text, so output always equals the input
// verbatim (caret in the transparent textarea above stays aligned with the visible colored text).
function highlightSql(code: string): string {
  const nl = code.charAt(code.length - 1) === '\n' ? ' ' : ''; // keep the final empty line's height (both paths)
  if (code.length > 20000) return esc(code) + nl; // guard: don't re-tokenize very large text on every keystroke
  const re = /(\/\*[\s\S]*?\*\/|--[^\n]*)|([eE]'(?:[^'\\]|''|\\.)*'|(?:[bBxX])?'(?:[^']|'')*')|("(?:[^"]|"")*")|(\$\d+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|([-+*/%<>=!~^&|.,;()\[\]:@#?]+)/g;
  let html = '', last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) html += esc(code.slice(last, m.index));
    const t = m[0];
    if (m[1]) html += '<span class="tk-cm">' + esc(t) + '</span>';
    else if (m[2]) html += '<span class="tk-str">' + esc(t) + '</span>';
    else if (m[3]) html += '<span class="tk-br">' + esc(t) + '</span>';
    else if (m[4]) html += '<span class="tk-var">' + esc(t) + '</span>';
    else if (m[5]) html += '<span class="tk-num">' + esc(t) + '</span>';
    else if (m[6]) {
      const lw = t.toLowerCase();
      const cls = KW_SET.has(lw) ? 'tk-kw' : TY_SET.has(lw) ? 'tk-ty' : FN_SET.has(lw) ? 'tk-fn' : '';
      html += cls ? '<span class="' + cls + '">' + esc(t) + '</span>' : esc(t);
    } else html += '<span class="tk-op">' + esc(t) + '</span>';
    last = m.index + t.length;
  }
  if (last < code.length) html += esc(code.slice(last));
  return html + nl;
}

// Pixel position of the caret inside a textarea (mirror-div technique) — used to anchor the completion
// popup. Returns coords relative to the textarea's own top-left (padding + border included).
const CARET_PROPS = ['direction', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace', 'wordBreak', 'overflowWrap'];
function getCaretCoordinates(el: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const div = document.createElement('div');
  document.body.appendChild(div);
  const style = div.style as unknown as Record<string, string>;
  const computed = getComputedStyle(el) as unknown as Record<string, string>;
  const padL = parseFloat(computed.paddingLeft) || 0, padR = parseFloat(computed.paddingRight) || 0;
  style.position = 'absolute'; style.visibility = 'hidden'; style.whiteSpace = 'pre-wrap'; style.wordWrap = 'break-word';
  style.boxSizing = 'content-box'; style.width = (el.clientWidth - padL - padR) + 'px';
  CARET_PROPS.forEach((p) => { style[p] = computed[p]; });
  div.textContent = el.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = el.value.slice(position) || '.';
  div.appendChild(span);
  const coords = {
    top: span.offsetTop + (parseInt(computed.borderTopWidth) || 0),
    left: span.offsetLeft + (parseInt(computed.borderLeftWidth) || 0),
    height: parseInt(computed.lineHeight) || Math.round((parseFloat(computed.fontSize) || 12) * 1.5),
  };
  document.body.removeChild(div);
  return coords;
}

// ==========================================================================
// DRAWER VIEW — connection status + database list
// ==========================================================================
async function renderDrawer() {
  document.body.className = '';
  $('root').innerHTML =
    '<div class="body"><div id="cli"></div>' +
    '<div class="statrow"><div id="conn"></div>' +
    '<button class="ic" id="refresh" title="Reconnect">' + IC_REFRESH + '</button></div>' +
    '<div id="dbs"></div><div id="local"></div></div>';
  $('refresh').onclick = () => void boot();
  if (!(await ensureCli())) return;
  const c = await loadConn();
  await connectAndList(c);
  await renderLocal();
}

// Show psql status; offer an install button when it is missing. Returns true when psql is ready.
async function ensureCli(): Promise<boolean> {
  const box = $('cli');
  const ver = out(await exec('command -v psql >/dev/null 2>&1 && psql --version 2>&1 | head -1 || echo __NONE__', 10000));
  if (ver.indexOf('__NONE__') >= 0 || ver === '') {
    box.innerHTML =
      '<div class="notice"><b>psql</b> is not installed. It is the ARM64 PostgreSQL client this extension uses.' +
      '<div style="margin-top:10px"><button class="btn primary" id="cliInstall">Install psql</button></div>' +
      '<pre class="log" id="cliOut" style="display:none"></pre></div>';
    $('cliInstall').onclick = () => void installCli();
    return false;
  }
  box.innerHTML = '';
  return true;
}

async function installCli() {
  const btn = $('cliInstall') as HTMLButtonElement;
  const log = $('cliOut'); log.style.display = 'block'; log.textContent = 'Installing postgresql-client …';
  btn.disabled = true;
  // PostgreSQL is fully ARM64-native, so the client is a plain apt package (psql + pg_dump + pg_restore).
  const script = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y 2>&1 | tail -2',
    'apt-get install -y -o DPkg::Lock::Timeout=180 postgresql-client 2>&1 | tail -6',
    'psql --version 2>&1 | head -1',
  ].join('\n');
  const r = await exec(script, 900000);
  log.textContent = out(r) || r.error || '(no output)';
  btn.disabled = false;
  if (out(r).toLowerCase().indexOf('psql (postgresql)') >= 0 || /psql.*\d+\.\d+/i.test(out(r))) { toast('psql installed.'); void boot(); }
}

// ==========================================================================
// LOCAL NATIVE SERVER — run PostgreSQL in the runtime (no VM), using the
// bundled libandroshm LD_PRELOAD shim to work around Android's missing SysV IPC.
// ==========================================================================
const LOCAL = {
  data: '/var/lib/postgresql/jcode',
  shim: '/usr/local/lib/libandroshm.so',
  svc: 'pglocal',
  port: '5432',
  sock: '/tmp',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function genPw(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return 'jc_' + Array.from(a).map((x) => (x % 36).toString(36)).join('');
}

async function pgBinDir(): Promise<string> {
  return out(await exec('ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1', 10000)).trim();
}
async function serviceRunning(id: string): Promise<boolean> {
  const r = await api('service.status', { id });
  return !!(r.ok && r.data && (r.data as any).running);
}
interface LocalState { serverInstalled: boolean; initialized: boolean; running: boolean }
async function localState(): Promise<LocalState> {
  const probe = out(await exec(
    'echo "BIN=$(ls /usr/lib/postgresql/*/bin/postgres 2>/dev/null | head -1)"; ' +
    'echo "INIT=$(test -f ' + sh(LOCAL.data + '/PG_VERSION') + ' && echo yes)"', 12000));
  return {
    serverInstalled: /BIN=\/usr/.test(probe),
    initialized: /INIT=yes/.test(probe),
    running: await serviceRunning(LOCAL.svc),
  };
}

// The command that launches the server: run as the (non-root) postgres user via su — proot's
// fake-id0 gives su a real non-zero euid so postgres won't refuse — with the shm shim preloaded
// (set INSIDE the -c string; su strips LD_PRELOAD from the inherited environment).
function pgStartCmd(bin: string): string {
  return 'su postgres -c "LC_ALL=C LD_PRELOAD=' + LOCAL.shim + ' ' + bin + '/postgres -D ' + LOCAL.data + '"';
}

// Stop the postmaster the proper way — via its own pidfile — because it is launched through `su`
// (a session/pgroup boundary), so killing the service wrapper doesn't reliably signal it. Then tear
// down the (now-exited) service wrapper. Safe to call when nothing is running.
async function stopServerProcess(bin: string, mode: string) {
  out(await exec('su postgres -c "LC_ALL=C ' + bin + '/pg_ctl -D ' + LOCAL.data + ' stop -m ' + mode + ' -w -t 20" 2>/dev/null; true', 30000));
  await api('service.stop', { id: LOCAL.svc });
}

async function renderLocal() {
  const el = $('local'); if (!el) return;
  const st = await localState();
  if (!st.initialized && !st.running) {
    el.innerHTML =
      '<div class="sec-ttl" style="margin-top:8px">Local server</div>' +
      '<div class="notice">Run <b>PostgreSQL natively</b> in the runtime — no remote server or VM needed.' +
      '<div style="margin-top:10px"><button class="btn primary" id="locSetup">Set up local PostgreSQL</button></div>' +
      '<pre class="log" id="locLog" style="display:none"></pre></div>';
    $('locSetup').onclick = () => void setupLocalServer();
    return;
  }
  const label = st.running ? 'Running · 127.0.0.1:' + LOCAL.port : 'Stopped';
  el.innerHTML =
    '<div class="sec-ttl" style="margin-top:8px">Local server</div>' +
    '<div class="status" style="padding:2px 8px 8px">' +
      '<span class="pill ' + (st.running ? 'ok' : 'bad') + '"><span class="dot"></span> ' + label + '</span>' +
      '<span style="flex:1"></span>' +
      (st.running
        ? '<button class="btn sm" id="locStop">Stop</button>'
        : '<button class="btn sm primary" id="locStart">Start</button>') +
    '</div><pre class="log" id="locLog" style="display:none"></pre>';
  if (st.running) $('locStop').onclick = () => void stopLocalServer();
  else $('locStart').onclick = () => void startLocalServer();
}

async function setupLocalServer() {
  const log = $('locLog'); if (!log) return;
  log.style.display = 'block'; log.textContent = '';
  const step = (m: string) => { log.textContent += m + '\n'; log.scrollTop = log.scrollHeight; };
  document.querySelectorAll<HTMLButtonElement>('#local .btn').forEach((b) => { b.disabled = true; });

  let st = await localState();
  if (!st.serverInstalled) {
    step('Installing PostgreSQL server (native ARM64)…');
    out(await exec('export DEBIAN_FRONTEND=noninteractive; apt-get install -y -o DPkg::Lock::Timeout=180 postgresql 2>&1 | tail -3', 900000));
  }
  const bin = await pgBinDir();
  if (!bin) { step('ERROR: postgres binaries not found.'); return; }

  step('Installing shared-memory shim…');
  const dep = out(await exec(
    'mkdir -p /usr/local/lib && printf %s ' + sh(SHIM_GZ_B64) + ' | base64 -d | gzip -dc > ' + sh(LOCAL.shim) +
    ' && chmod 644 ' + sh(LOCAL.shim) + ' && echo OK $(stat -c%s ' + sh(LOCAL.shim) + ')', 30000));
  if (dep.indexOf('OK') < 0) { step('ERROR installing shim: ' + dep); return; }

  st = await localState();
  if (!st.initialized) {
    step('Initializing database cluster…');
    const init = out(await exec(
      'rm -rf ' + sh(LOCAL.data) + ' && mkdir -p ' + sh(LOCAL.data) +
      ' && chown postgres:postgres ' + sh(LOCAL.data) + ' && chmod 700 ' + sh(LOCAL.data) +
      ' && su postgres -c "LC_ALL=C LD_PRELOAD=' + LOCAL.shim + ' ' + bin +
      '/initdb -D ' + LOCAL.data + ' -U postgres --locale=C --auth-host=scram-sha-256 --auth-local=trust --no-instructions --no-sync" 2>&1 | tail -4; ' +
      'test -f ' + sh(LOCAL.data + '/PG_VERSION') + ' && echo INITDB_OK', 180000));
    if (init.indexOf('INITDB_OK') < 0) { step('ERROR: initdb failed:\n' + init); return; }
    await exec('cat >> ' + sh(LOCAL.data + '/postgresql.conf') + " <<'CFG'\n" +
      "listen_addresses = '127.0.0.1'\nport = " + LOCAL.port + "\nunix_socket_directories = '" + LOCAL.sock + "'\n" +
      'shared_memory_type = mmap\ndynamic_shared_memory_type = mmap\nshared_buffers = 32MB\nmax_connections = 50\nCFG', 15000);
  }

  step('Starting server…');
  await stopServerProcess(bin, 'immediate');
  const sr = await api('service.start', { id: LOCAL.svc, command: pgStartCmd(bin) });
  if (!(sr.ok && (sr.data as any).running)) { step('ERROR: service failed to start.'); return; }

  step('Waiting for the server…');
  let ready = false;
  for (let i = 0; i < 25; i++) {
    const ping = out(await exec('su postgres -c "LC_ALL=C psql -h ' + LOCAL.sock + ' -p ' + LOCAL.port + ' -d postgres -Atc \\"SELECT 1\\"" 2>/dev/null', 8000));
    if (ping.trim() === '1') { ready = true; break; }
    await sleep(1500);
  }
  if (!ready) { step('Server did not answer in time — check again in a moment.'); }

  // Set a fresh password for the postgres role (via the trusted local socket) and store it as the client config.
  const pw = genPw();
  out(await exec('su postgres -c ' + sh("LC_ALL=C psql -h " + LOCAL.sock + " -p " + LOCAL.port + " -d postgres -Atc \"ALTER USER postgres PASSWORD '" + pw + "'\"") + ' 2>&1', 15000));
  await api('config.set', { key: 'pg.host', value: '127.0.0.1' });
  await api('config.set', { key: 'pg.port', value: LOCAL.port });
  await api('config.set', { key: 'pg.user', value: 'postgres' });
  await api('config.set', { key: 'pg.password', value: pw });
  await api('config.set', { key: 'pg.database', value: 'postgres' });
  await api('config.set', { key: 'pg.sslmode', value: 'disable' });
  step('Done.');
  toast('Local PostgreSQL is running.');
  await boot();
}

async function startLocalServer() {
  const bin = await pgBinDir();
  if (!bin) { toast('postgres is not installed.'); return; }
  await stopServerProcess(bin, 'immediate');
  const r = await api('service.start', { id: LOCAL.svc, command: pgStartCmd(bin) });
  toast(r.ok && (r.data as any).running ? 'Local server started.' : 'Failed to start.');
  await sleep(2000);
  await boot();
}
async function stopLocalServer() {
  const bin = await pgBinDir();
  if (bin) await stopServerProcess(bin, 'fast');
  else await api('service.stop', { id: LOCAL.svc });
  toast('Local server stopped.');
  await boot();
}

async function connectAndList(c: Conn) {
  const conn = $('conn');
  conn.className = 'status';
  const target = c.host + ':' + c.port;
  if (!c.password) {
    conn.innerHTML = '<span class="pill bad"><span class="dot"></span> Not configured</span>' +
      '<span class="note">Set up a local server below, or set a remote host &amp; password in <b>Settings</b>.</span>';
    $('dbs').innerHTML = '';
    return;
  }
  conn.innerHTML = '<span class="pill"><span class="dot"></span> Connecting to ' + esc(target) + '…</span>';
  const res = await scalarList(c, 'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
  if (res.error) {
    conn.innerHTML = '<span class="pill bad"><span class="dot"></span> ' + esc(target) + '</span>';
    $('dbs').innerHTML = '<div class="notice" style="color:var(--bad)">' + esc(res.error) +
      '<div style="margin-top:10px"><button class="btn primary" id="retry">Retry</button></div></div>';
    $('retry').onclick = () => void boot();
    return;
  }
  if (!res.values.length) {
    // pg_database always includes the built-in 'postgres' DB, so an empty result means the query
    // didn't really run (the server is still starting, or the exec timed out) — not "0 databases".
    conn.innerHTML = '<span class="pill bad"><span class="dot"></span> ' + esc(target) + '</span>';
    $('dbs').innerHTML = '<div class="notice" style="color:var(--bad)">Could not read databases; the server may still be starting.' +
      '<div style="margin-top:10px"><button class="btn primary" id="retry">Retry</button></div></div>';
    $('retry').onclick = () => void boot();
    return;
  }
  conn.innerHTML = '<span class="pill ok"><span class="dot"></span> Connected</span>' +
    '<span class="note">' + esc(c.user) + ' @ ' + esc(target) + '</span>';
  const dbs = $('dbs');
  dbs.innerHTML = '<div class="sec-ttl">Databases <span class="count">' + res.values.length + '</span>' +
    '<span style="flex:1"></span>' +
    '<button class="ic" id="restoreDb" title="Restore a database from a dump file">' + IC_RESTORE + '</button>' +
    '<button class="ic" id="newDb" title="New database">' + IC_PLUS + '</button></div>' +
    '<div id="dblist"></div>';
  $('newDb').onclick = createDatabase;
  $('restoreDb').onclick = () => void restoreDatabase();
  const list = $('dblist');
  res.values.forEach((name) => {
    const low = name.toLowerCase();
    const sys = SYSTEM_DBS.indexOf(low) >= 0;
    const canBk = low !== 'template0' && low !== 'template1'; // templates aren't meaningfully dumpable
    const row = document.createElement('div');
    row.className = 'dbrow';
    row.innerHTML = '<span class="dbi">' + IC_DB + '</span><span class="dbname">' + esc(name) + '</span>' +
      (canBk ? '<button class="ic dba" data-a="backup" title="Back up to file">' + IC_SAVE + '</button>' : '') +
      (sys ? '' : '<button class="ic dba" data-a="rename" title="Rename">' + IC_EDIT + '</button>' +
        '<button class="ic dba" data-a="drop" title="Drop">' + IC_TRASH + '</button>') +
      '<span class="chev ic">' + IC_CHEV + '</span>';
    row.onclick = () => void api('workbench.openView', { view: 'studio:' + name });
    row.querySelectorAll<HTMLElement>('[data-a]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = b.getAttribute('data-a');
        if (a === 'backup') void backupDatabase(name);
        else if (a === 'rename') renameDatabase(name);
        else dropDatabase(name);
      };
    });
    list.appendChild(row);
  });
}

// ---- database CRUD (from the drawer). DDL runs against the maintenance db (can't be connected to the target). ----
async function dbDdl(sql: string, done: string): Promise<boolean> {
  const conn = await loadConn();
  const r = out(await exec(psqlBase(conn, conn.database) + ' -q -c ' + sh(sql) + ' 2>&1', 120000));
  const e = isPgError(r);
  toast(e ? (e.split('\n').filter(Boolean).pop() || 'Error') : done);
  return !e;
}

function createDatabase() {
  showModal({
    title: 'New database', fields: [{ key: 'name', label: 'Database name', placeholder: 'my_database' }],
    confirmLabel: 'Create',
    onConfirm: async (v) => {
      const name = (v.name || '').trim(); if (!name) return;
      if (await dbDdl('CREATE DATABASE ' + pgId(name), 'Created "' + name + '".')) void boot();
    },
  });
}

function renameDatabase(name: string) {
  showModal({
    title: 'Rename database', body: 'Rename <b>' + esc(name) + '</b> to:',
    fields: [{ key: 'to', label: 'New name', value: name }], confirmLabel: 'Rename',
    onConfirm: async (v) => {
      const to = (v.to || '').trim(); if (!to || to === name) return;
      if (await dbDdl('ALTER DATABASE ' + pgId(name) + ' RENAME TO ' + pgId(to), 'Renamed to "' + to + '".')) void boot();
    },
  });
}

function dropDatabase(name: string) {
  showModal({
    title: 'Drop database', body: 'Drop <b>' + esc(name) + '</b> and all its data? This cannot be undone.',
    confirmLabel: 'Drop', danger: true,
    onConfirm: async () => {
      // WITH (FORCE) terminates other sessions first (PostgreSQL 13+).
      if (await dbDdl('DROP DATABASE ' + pgId(name) + ' WITH (FORCE)', 'Dropped "' + name + '".')) void boot();
    },
  });
}

// ---- back up / restore a database to/from a device file (pg_dump / pg_restore via the SAF file bridge) ----
const safeName = (s: string) => (s.replace(/[^A-Za-z0-9._-]/g, '_') || 'db');
function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// Back up <name> with pg_dump -Fc into the shared /jcode-transfer dir, then hand the file to the app's
// SAF "save as" bridge so the user picks where on device storage to keep it.
async function backupDatabase(name: string) {
  const c = await loadConn();
  if (!c.password) { toast('Configure the connection first.'); return; }
  const file = '/jcode-transfer/' + safeName(name) + '.dump';
  toast('Backing up "' + name + '"…');
  const cmd = 'mkdir -p /jcode-transfer && ' + pgEnv(c) + 'pg_dump -h ' + sh(c.host) + ' -p ' + sh(c.port) +
    ' -U ' + sh(c.user) + ' -w -Fc -f ' + sh(file) + ' ' + sh(name) + ' 2>&1; echo "EXIT:$?"';
  const r = out(await exec(cmd, 600000));
  if (!/EXIT:0\b/.test(r) || isPgError(r)) {
    await exec('rm -f ' + sh(file), 10000);
    toast('Backup failed: ' + (r.split('\n').filter(Boolean).pop() || 'error'));
    return;
  }
  const exp = await api('file.export', { path: file, name: safeName(name) + '.dump' });
  await exec('rm -f ' + sh(file), 10000);
  if (exp.ok) toast('Saved backup of "' + name + '".');
  else if (exp.error && exp.error !== 'cancelled') toast('Save failed: ' + exp.error);
}

// Restore a device dump into a (new or existing) database — auto-detecting a pg_dump custom-format
// archive (pg_restore) vs a plain .sql dump (psql -f) via `pg_restore -l`.
function restoreDatabase(): void {
  void loadConn().then((c) => {
    if (!c.password) { toast('Configure the connection first.'); return; }
    const back = document.createElement('div'); back.className = 'modal-scrim';
    const dlg = document.createElement('div'); dlg.className = 'modal';
    dlg.innerHTML =
      '<div class="modal-title">Restore database</div>' +
      '<div class="modal-body">Pick a PostgreSQL dump from device storage — a <b>pg_dump -Fc</b> archive or a plain <b>.sql</b> file. It is restored into the named database (created if it doesn’t exist).</div>' +
      '<div class="field"><label>Dump file</label><button class="btn" id="__pick" type="button">Choose dump file…</button>' +
        '<div id="__fname" class="note" style="margin-top:6px;color:var(--muted)">No file selected.</div></div>' +
      '<div class="field"><label>Restore as</label><input id="__name" type="text" placeholder="database name"></div>' +
      '<pre class="log" id="__rlog" style="display:none"></pre>' +
      '<div class="modal-actions"><button class="btn ghost" id="__cancel">Cancel</button>' +
      '<button class="btn primary" id="__ok" disabled>Restore</button></div>';
    back.appendChild(dlg); document.body.appendChild(back);
    const close = () => back.remove();
    ($('__cancel') as HTMLButtonElement).onclick = close;
    back.onclick = (e) => { if (e.target === back) close(); };
    let imported: { path: string; name: string; size: number } | null = null;
    const pickBtn = $('__pick') as HTMLButtonElement;
    pickBtn.onclick = async () => {
      const label = pickBtn.textContent; pickBtn.disabled = true; pickBtn.textContent = 'Importing…';
      const rr = await api('file.import', {});
      pickBtn.disabled = false; pickBtn.textContent = label;
      if (!rr.ok) { if (rr.error && rr.error !== 'cancelled') toast(rr.error); return; }
      imported = rr.data as { path: string; name: string; size: number };
      $('__fname').textContent = imported.name + ' · ' + fmtBytes(imported.size);
      const nameInp = $('__name') as HTMLInputElement;
      if (!nameInp.value) nameInp.value = imported.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '');
      ($('__ok') as HTMLButtonElement).disabled = false;
    };
    ($('__ok') as HTMLButtonElement).onclick = async () => {
      const name = ($('__name') as HTMLInputElement).value.trim().replace(/[^A-Za-z0-9_]/g, '');
      if (!imported) { toast('Choose a dump file.'); return; }
      if (!name) { toast('Enter a database name (letters, digits, underscore).'); return; }
      const ok = $('__ok') as HTMLButtonElement, cancel = $('__cancel') as HTMLButtonElement;
      ok.disabled = true; cancel.disabled = true;
      const logEl = $('__rlog'); logEl.style.display = 'block';
      const err = await runRestore(c, imported.path, name, (s) => { logEl.textContent = s; });
      if (err) { logEl.textContent = err; ok.disabled = false; cancel.disabled = false; toast('Restore failed.'); }
      else { close(); toast('Restored "' + name + '".'); void boot(); }
    };
  });
}

async function runRestore(c: Conn, srcPath: string, name: string, log: (s: string) => void): Promise<string | undefined> {
  const cleanup = () => exec('rm -f ' + sh(srcPath), 10000);
  // Create the target database if it doesn't exist (DDL runs against the maintenance db).
  const exists = await scalarList(c, 'SELECT 1 FROM pg_database WHERE datname=' + pgStr(name), c.database);
  if (exists.error) { await cleanup(); return 'Could not read databases:\n' + exists.error; }
  if (!exists.values.length) {
    log('Creating database "' + name + '"…');
    const cr = out(await exec(psqlBase(c, c.database) + ' -q -c ' + sh('CREATE DATABASE ' + pgId(name)) + ' 2>&1', 60000));
    if (isPgError(cr)) { await cleanup(); return 'Create database failed:\n' + cr; }
  }
  log('Restoring "' + name + '"…');
  // `pg_restore -l` lists the TOC of a custom/tar/dir archive (exit 0); it errors on a plain-SQL dump.
  const probe = out(await exec(pgEnv(c) + 'pg_restore -l ' + sh(srcPath) + ' >/dev/null 2>&1; echo "EXIT:$?"', 60000));
  const isArchive = /EXIT:0\b/.test(probe);
  const cmd = isArchive
    ? pgEnv(c) + 'pg_restore -h ' + sh(c.host) + ' -p ' + sh(c.port) + ' -U ' + sh(c.user) +
      ' -w --no-owner --no-acl -d ' + sh(name) + ' ' + sh(srcPath) + ' 2>&1; echo "EXIT:$?"'
    : psqlBase(c, name) + ' -f ' + sh(srcPath) + ' 2>&1; echo "EXIT:$?"';
  const r = out(await exec(cmd, 900000));
  await cleanup();
  if (!/EXIT:0\b/.test(r)) return 'Restore reported errors:\n' + r;
  return undefined;
}

// ==========================================================================
// STUDIO VIEW — per-database editor tab (Tables / Diagram / Security / Backup)
// ==========================================================================
let studioDb = '';
let studioConn: Conn | null = null;
type Pane = 'tables' | 'diagram' | 'security' | 'backup';
let pane: Pane = 'tables';
let selTable = '';
let railCollapsed = false;
let queryCollapsed = false;
let queryText = '';
// Editable-grid (Edit 1000) state; `dirty` maps "row:col" -> the new cell text.
interface EditState { table: string; pk: string; pkIdx: number; cols: string[]; orig: string[][] }
let edit: EditState | null = null;
const dirty: Record<string, string> = {};
// Diagram: only tables the user has manually added to the canvas.
let diagramTables: string[] = [];
// Schema index for editor completion (loaded once per studio open, off the render path).
interface SchemaIdx { tables: string[]; colsByTable: Record<string, string[]> }
let schema: SchemaIdx = { tables: [], colsByTable: {} };
// Completion popup state.
let acEl: HTMLElement | null = null;
let acList: Suggest[] = [];
let acSel = 0;
let acRange: { start: number; end: number } | null = null;
let acTa: HTMLTextAreaElement | null = null;

async function renderStudio(db: string) {
  studioDb = db;
  document.body.className = 'studiopage';
  selTable = ''; edit = null; Object.keys(dirty).forEach((k) => delete dirty[k]);
  closeAcbox(); schema = { tables: [], colsByTable: {} };
  $('root').innerHTML =
    '<div class="studio">' +
    '<div class="sbar"><span class="dbn"><span class="dbi">' + IC_DB + '</span>' + esc(db) + '</span>' +
      '<span id="sconn" class="condot" title="Checking…"></span>' +
      '<div class="tabrow">' +
        tabBtn('tables', 'Tables') + tabBtn('diagram', 'Diagram') + tabBtn('security', 'Security') + tabBtn('backup', 'Backup') +
      '</div>' +
      '<span class="spacer"></span>' +
      '<div class="tabacts" id="tabacts">' +
        '<button class="btn xs primary" id="applyGrid" title="Apply grid edits" disabled>Apply</button>' +
        '<button class="btn xs" id="newQuery" title="New query">' + IC_PLUS + 'Query</button>' +
        '<button class="ic run" id="runQuery" title="Execute (Ctrl+Enter)">' + IC_PLAY + '</button>' +
      '</div>' +
      '<button class="ic" id="srefresh" title="Reconnect / refresh">' + IC_REFRESH + '</button></div>' +
    '<div class="spane" id="spane"></div></div>';
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
    t.onclick = () => { pane = t.getAttribute('data-p') as Pane; void selectPane(); };
  });
  $('srefresh').onclick = () => { void pingConn(); void selectPane(); };
  $('newQuery').onclick = newQuery;
  $('runQuery').onclick = () => void runQuery();
  $('applyGrid').onclick = () => void applyEdits();
  studioConn = await loadConn();
  await pingConn();
  await selectPane();
}

function tabBtn(p: string, label: string): string {
  return '<div class="tab' + (pane === p ? ' active' : '') + '" data-p="' + p + '">' + esc(label) + '</div>';
}

async function pingConn() {
  const el = $('sconn'); if (!el || !studioConn) return;
  const r = await scalarList(studioConn, 'SELECT 1', studioDb);
  const okConn = !r.error;
  el.className = 'condot ' + (okConn ? 'ok' : 'bad');
  el.title = okConn ? 'Connected' : 'Offline';
}

async function selectPane() {
  closeAcbox();
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) =>
    t.classList.toggle('active', t.getAttribute('data-p') === pane));
  // The query / run / apply toolbar only applies to the data (Tables) pane.
  const acts = $('tabacts'); if (acts) acts.style.display = pane === 'tables' ? 'flex' : 'none';
  const host = $('spane');
  if (pane === 'tables') await renderTablesPane(host);
  else if (pane === 'diagram') await renderDiagramPane(host);
  else if (pane === 'security') await renderSecurityPane(host);
  else renderBackupPane(host);
}

// Show a button as busy (spinner + disabled) while an async op runs — keeps the UI responsive-looking.
async function withBusy<T>(btn: HTMLElement | null, fn: () => Promise<T>): Promise<T> {
  const b = btn as HTMLButtonElement | null;
  if (b) { b.classList.add('busy'); b.disabled = true; }
  try { return await fn(); } finally { if (b) { b.classList.remove('busy'); b.disabled = false; } }
}

// ---- shared grid renderer ----
function gridHtml(g: Grid): string {
  if (g.error) return '<div class="gridmsg err">' + esc(g.error) + '</div>';
  if (!g.columns.length) return '<div class="gridmsg">' + esc(g.message || 'OK') + '</div>';
  let h = '<table class="grid"><thead><tr>';
  g.columns.forEach((c2) => { h += '<th>' + esc(c2) + '</th>'; });
  h += '</tr></thead><tbody>';
  if (!g.rows.length) h += '<tr><td colspan="' + g.columns.length + '" class="null">(0 rows)</td></tr>';
  g.rows.forEach((r) => {
    h += '<tr>';
    for (let i = 0; i < g.columns.length; i++) {
      const v = r[i] ?? '';
      h += v === 'NULL' ? '<td class="null">NULL</td>' : '<td>' + esc(v) + '</td>';
    }
    h += '</tr>';
  });
  return h + '</tbody></table>';
}

const c = () => studioConn as Conn;

// ---- editor: highlight sync + completion ----
// Load table + column names for completion. Compact chr(31)-delimited output (not the aligned grid) so a
// large schema stays small enough to pass through the JS bridge without blocking the UI thread.
async function loadSchemaIndex() {
  const t = await scalarList(c(), "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1", studioDb);
  if (!t.error && t.values.length) schema.tables = t.values;
  const cg = await scalarList(c(), "SELECT table_schema || '.' || table_name || chr(31) || column_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position", studioDb);
  if (!cg.error) {
    const cbt: Record<string, string[]> = {};
    cg.values.forEach((line) => {
      const i = line.indexOf(SEP); if (i < 0) return;
      const k = line.slice(0, i).toLowerCase();
      (cbt[k] = cbt[k] || []).push(line.slice(i + 1));
    });
    schema.colsByTable = cbt;
  }
}

function syncHighlight() {
  const ta = $('q') as HTMLTextAreaElement | null, hl = $('qhl');
  if (!ta || !hl) return;
  hl.innerHTML = highlightSql(ta.value);
  hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
}

function initSqlEditor(ta: HTMLTextAreaElement) {
  const hl = $('qhl');
  syncHighlight();
  ta.addEventListener('input', () => { queryText = ta.value; syncHighlight(); updateCompletion(ta, false); });
  ta.addEventListener('scroll', () => { if (hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; } if (isAcOpen()) positionAcbox(ta); });
  ta.addEventListener('keydown', onEditorKeydown);
  ta.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf((e as KeyboardEvent).key) >= 0) updateCompletion(ta, false); });
  ta.addEventListener('blur', () => setTimeout(closeAcbox, 160));
  ta.addEventListener('pointerdown', () => closeAcbox());
}

function onEditorKeydown(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  const ke = e as KeyboardEvent;
  if (isAcOpen()) {
    if (ke.key === 'ArrowDown') { e.preventDefault(); moveSel(1); return; }
    if (ke.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); return; }
    // Only a BARE Enter/Tab accepts; Ctrl/Cmd+Enter must fall through to run the query below.
    if ((ke.key === 'Enter' || ke.key === 'Tab') && !ke.ctrlKey && !ke.metaKey) { e.preventDefault(); acceptSel(); return; }
    if (ke.key === 'Escape') { e.preventDefault(); closeAcbox(); return; }
  }
  if ((ke.ctrlKey || ke.metaKey) && ke.key === 'Enter') { e.preventDefault(); closeAcbox(); void runQuery(); return; }
  if ((ke.ctrlKey || ke.metaKey) && (ke.key === ' ' || ke.key === 'Spacebar' || ke.code === 'Space')) { e.preventDefault(); updateCompletion(ta, true); }
}

// Quote a single identifier only when it isn't a plain lowercase word or is a reserved keyword, so inserted
// completions are always valid (PostgreSQL folds unquoted names to lowercase — a mixed-case or spaced name
// must be double-quoted). qtable does the same per component of a schema.table.
function qid(n: string): string { return /^[a-z_][a-z0-9_]*$/.test(n) && !KW_SET.has(n.toLowerCase()) ? n : pgId(n); }
function qtable(full: string): string { return full.split('.').map(qid).join('.'); }

// Blank out comment / string spans (preserving newlines) so FROM/JOIN scanning can't be fooled by text inside them.
function stripSqlNoise(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|[eE]'(?:[^'\\]|''|\\.)*'|'(?:[^']|'')*'/g, (mm) => mm.replace(/[^\n]/g, ' '));
}
// Non-keyword clause starters that must never be captured as a table alias.
const ALIAS_STOP = new Set(['for']);

// Resolve a written table reference (bare or schema.table, possibly quoted) to a canonical schema.table.
function resolveTableName(raw: string): string {
  const parts = raw.split('.').map((p) => p.replace(/"/g, '').trim()).filter(Boolean);
  if (!parts.length) return '';
  const bare = parts[parts.length - 1].toLowerCase();
  const sch = parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : '';
  for (const full of schema.tables) {
    const tp = full.split('.');
    const tb = tp[tp.length - 1].toLowerCase();
    const ts = tp.length >= 2 ? tp[tp.length - 2].toLowerCase() : 'public';
    if (tb === bare && (!sch || ts === sch)) return full;
  }
  return '';
}

const TREF = '((?:"[^"]+"|[A-Za-z_]\\w*)(?:\\.(?:"[^"]+"|[A-Za-z_]\\w*)){0,2})';
function tablesInQuery(text: string): string[] {
  const clean = stripSqlNoise(text);
  const re = new RegExp('\\b(?:from|join|update|into)\\s+' + TREF, 'gi');
  const found: string[] = []; let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) { const full = resolveTableName(m[1]); if (full && found.indexOf(full) < 0) found.push(full); }
  return found;
}
function aliasMap(text: string): Record<string, string> {
  const clean = stripSqlNoise(text);
  // `(?!\s*\()` rejects a following call/clause; the KW_SET/ALIAS_STOP guard rejects clause words.
  const re = new RegExp('\\b(?:from|join)\\s+' + TREF + '\\s+(?:as\\s+)?([A-Za-z_]\\w*)(?!\\s*\\()', 'gi');
  const map: Record<string, string> = {}; let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const full = resolveTableName(m[1]), al = m[2].toLowerCase();
    if (full && !KW_SET.has(al) && !ALIAS_STOP.has(al)) map[al] = full;
  }
  return map;
}
function columnsOf(tableFull: string): string[] { return schema.colsByTable[tableFull.toLowerCase()] || []; }
function tableSuggests(): Suggest[] { return schema.tables.map((t) => ({ label: t, insert: qtable(t), kind: 'tb' })); }

// The identifier fragment ending at the caret. An unclosed `"...` is treated as one token (so `t1."Ord`
// keeps the `"` in the replaced range and the dot-context is detected from the char before the `"`); `word`
// is always the quote-stripped text used for prefix filtering.
function currentWord(text: string, pos: number): { word: string; start: number } {
  const before = text.slice(0, pos);
  const mb = /"([^"]*)$/.exec(before);
  if (mb) return { word: mb[1], start: pos - mb[0].length };
  const m = /[A-Za-z_][\w$]*$/.exec(before);
  return m ? { word: m[0], start: pos - m[0].length } : { word: '', start: pos };
}

function updateCompletion(ta: HTMLTextAreaElement, force: boolean) {
  if (ta.selectionStart !== ta.selectionEnd) { closeAcbox(); return; }
  const text = ta.value, pos = ta.selectionStart;
  const { word, start } = currentWord(text, pos);
  const wl = word.toLowerCase();
  const dotBefore = start > 0 && text.charAt(start - 1) === '.';
  let items: Suggest[];
  if (dotBefore) {
    const qm = /("[^"]*"|[A-Za-z_][\w$]*)\.$/.exec(text.slice(0, start));
    const qual = qm ? qm[1] : '';
    const full = aliasMap(text)[qual.replace(/"/g, '').toLowerCase()] || resolveTableName(qual);
    if (full) items = columnsOf(full).map((col) => ({ label: col, insert: qid(col), kind: 'co', meta: full.split('.').pop() }));
    else {
      const s = qual.replace(/"/g, '').toLowerCase();
      items = schema.tables.filter((t) => (t.split('.')[0] || '').toLowerCase() === s)
        .map((t) => { const n = t.split('.').pop() as string; return { label: n, insert: qid(n), kind: 'tb' }; });
    }
  } else {
    if (!word && !force) { closeAcbox(); return; }
    const cols: Suggest[] = []; const seen: Record<string, boolean> = {};
    tablesInQuery(text).forEach((t) => columnsOf(t).forEach((col) => {
      const k = col.toLowerCase(); if (!seen[k]) { seen[k] = true; cols.push({ label: col, insert: qid(col), kind: 'co', meta: t.split('.').pop() }); }
    }));
    items = cols.concat(tableSuggests()).concat(KW_SUGGESTS);
  }
  if (wl) {
    const starts = items.filter((s) => s.label.toLowerCase().startsWith(wl));
    const incl = items.filter((s) => { const l = s.label.toLowerCase(); return !l.startsWith(wl) && l.indexOf(wl) >= 0; });
    items = starts.concat(incl);
  }
  const list: Suggest[] = []; const dseen: Record<string, boolean> = {};
  for (const s of items) {
    const k = s.kind + ':' + s.label.toLowerCase();
    if (!dseen[k]) { dseen[k] = true; list.push(s); }
    if (list.length >= 50) break;
  }
  if (!list.length) { closeAcbox(); return; }
  openAcbox(ta, list, start, pos);
}

function isAcOpen(): boolean { return !!acEl; }
function openAcbox(ta: HTMLTextAreaElement, list: Suggest[], start: number, end: number) {
  acList = list; acSel = 0; acRange = { start, end }; acTa = ta;
  if (!acEl) { acEl = document.createElement('div'); acEl.className = 'acbox'; document.body.appendChild(acEl); }
  renderAcbox();
  positionAcbox(ta);
}
const AC_KIND: Record<string, [string, string]> = { kw: ['kw', 'K'], fn: ['fn', 'ƒ'], ty: ['ty', 'T'], tb: ['tb', '▦'], co: ['co', '◇'] };
function renderAcbox() {
  if (!acEl) return;
  acEl.innerHTML = acList.map((s, i) => {
    const kd = AC_KIND[s.kind] || ['id', '·'];
    return '<div class="acitem' + (i === acSel ? ' sel' : '') + '" data-i="' + i + '">' +
      '<span class="aci ' + kd[0] + '">' + kd[1] + '</span>' +
      '<span class="acl">' + esc(s.label) + '</span>' +
      (s.meta ? '<span class="acmeta">' + esc(s.meta) + '</span>' : '') + '</div>';
  }).join('');
  acEl.querySelectorAll<HTMLElement>('.acitem').forEach((el) => {
    // preventDefault on pointerdown keeps the textarea focused (no blur); accept on CLICK so the item
    // consumes the tap itself — removing the popup on pointerdown would let the click fall through to
    // whatever sits beneath (e.g. a pane tab).
    el.addEventListener('pointerdown', (e) => e.preventDefault());
    el.addEventListener('click', () => { acSel = +(el.getAttribute('data-i') as string); acceptSel(); });
  });
}
function positionAcbox(ta: HTMLTextAreaElement) {
  if (!acEl) return;
  const cc = getCaretCoordinates(ta, ta.selectionEnd);
  const rect = ta.getBoundingClientRect();
  const vw = window.innerWidth, vv = window.visualViewport;
  const availBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const bw = acEl.offsetWidth, bh = acEl.offsetHeight;
  let x = rect.left + cc.left - ta.scrollLeft;
  let y = rect.top + cc.top - ta.scrollTop + cc.height + 2;
  if (x + bw + 8 > vw) x = vw - bw - 8;
  if (x < 8) x = 8;
  if (y + bh + 6 > availBottom) {
    const up = rect.top + cc.top - ta.scrollTop - bh - 2;
    const top = vv ? vv.offsetTop + 8 : 8; // clamp to the VISIBLE top, consistent with availBottom
    y = up > top ? up : Math.max(top, availBottom - bh - 6);
  }
  acEl.style.left = Math.round(x) + 'px';
  acEl.style.top = Math.round(y) + 'px';
}
function moveSel(d: number) {
  if (!acEl || !acList.length) return;
  acSel = (acSel + d + acList.length) % acList.length;
  renderAcbox();
  const sel = acEl.querySelector('.acitem.sel') as HTMLElement | null;
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function acceptSel() {
  const s = acList[acSel];
  if (!acTa || !acRange || !s) { closeAcbox(); return; }
  const ta = acTa, { start, end } = acRange;
  ta.value = ta.value.slice(0, start) + s.insert + ta.value.slice(end);
  const caret = start + s.insert.length;
  ta.setSelectionRange(caret, caret);
  queryText = ta.value; syncHighlight();
  closeAcbox();
  ta.focus();
}
function closeAcbox() {
  if (acEl) { acEl.remove(); acEl = null; }
  acList = []; acRange = null; acTa = null; acSel = 0;
}

// ---- Tables / data pane: rail (collapsible) + query row (collapsible) + result/editable grid ----
async function renderTablesPane(host: HTMLElement) {
  host.innerHTML =
    '<div class="tpane">' +
    '<div class="srail" id="srail">' +
      '<div class="rhd"><button class="ic" id="railToggle" title="Collapse">' + IC_COLLAPSE + '</button>' +
        '<span class="rttl">Tables</span>' +
        '<button class="ic" id="newTbl" title="New table">' + IC_PLUS + '</button></div>' +
      '<div class="list" id="tlist"><div class="empty">Loading…</div></div>' +
    '</div>' +
    '<button class="railshow ic" id="railShow" title="Show tables">' + IC_EXPAND + '</button>' +
    '<div class="tmain">' +
      '<div class="qrow" id="qrow">' +
        '<div class="qrowhd"><button class="ic" id="qToggle" title="Collapse/expand query">' + IC_CHEVDOWN + '</button>' +
          '<span class="qttl">Query</span><span class="qhint">Ctrl+Enter or ▷ to run</span></div>' +
        '<div class="qbox" id="qbox"><pre class="qhl" id="qhl" aria-hidden="true"></pre>' +
          '<textarea id="q" spellcheck="false" autocapitalize="none" autocomplete="off" autocorrect="off" placeholder="Write SQL, or use a table&#39;s ⋮ menu…"></textarea></div>' +
      '</div>' +
      '<div class="gridwrap" id="tgrid"><div class="gridmsg">Open a table&#39;s ⋮ menu (Select / Edit), or write a query and press ▷.</div></div>' +
    '</div></div>';
  applyRail(); applyQueryCollapse();
  $('railToggle').onclick = () => { railCollapsed = true; applyRail(); };
  $('railShow').onclick = () => { railCollapsed = false; applyRail(); };
  $('newTbl').onclick = newTable;
  $('qToggle').onclick = () => { queryCollapsed = !queryCollapsed; applyQueryCollapse(); };
  const ta = $('q') as HTMLTextAreaElement;
  ta.value = queryText;
  initSqlEditor(ta);
  await loadTables();
}

function applyRail() {
  const rail = $('srail'), show = $('railShow');
  if (rail) rail.style.display = railCollapsed ? 'none' : 'flex';
  if (show) show.style.display = railCollapsed ? 'inline-flex' : 'none';
}
function applyQueryCollapse() {
  const qrow = $('qrow'), tg = $('qToggle');
  if (qrow) qrow.classList.toggle('collapsed', queryCollapsed);
  if (tg) tg.innerHTML = queryCollapsed ? IC_EXPAND : IC_CHEVDOWN;
}

async function loadTables() {
  const list = $('tlist'); if (!list) return;
  void loadSchemaIndex(); // refresh the completion index too (also catches create/drop/rename)
  const res = await scalarList(c(),
    "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1", studioDb);
  if (res.error) { list.innerHTML = '<div class="gridmsg err">' + esc(res.error) + '</div>'; return; }
  if (!res.values.length) { list.innerHTML = '<div class="empty">No tables.</div>'; return; }
  list.innerHTML = '';
  res.values.forEach((name) => {
    const row = document.createElement('div');
    row.className = 'rrow' + (selTable === name ? ' active' : '');
    row.innerHTML = '<span class="ti">' + IC_TABLE + '</span><span class="tn">' + esc(name) + '</span>' +
      '<button class="ic kebab" title="Table actions">' + IC_KEBAB + '</button>';
    const mark = () => { selTable = name; document.querySelectorAll('.rrow').forEach((x) => x.classList.remove('active')); row.classList.add('active'); };
    row.onclick = mark;
    (row.querySelector('.kebab') as HTMLElement).onclick = (e) => { e.stopPropagation(); mark(); openTableMenu(name, e as MouseEvent); };
    list.appendChild(row);
  });
}

// Per-table ⋮ menu — tapping a table never loads data; every action is explicit here.
function openTableMenu(name: string, ev: MouseEvent) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'popmenu'; m.id = '__menu';
  const items: Array<[string, boolean, () => void]> = [
    ['Select 1000 (new to old)', false, () => void selectTable(name, false)],
    ['Edit 1000 (new to old)', false, () => void selectTable(name, true)],
    ['Design', false, () => void designTable(name)],
    ['Rename', false, () => renameTable(name)],
    ['Delete', true, () => dropTable(name)],
  ];
  items.forEach(([label, danger, fn]) => {
    const it = document.createElement('div');
    it.className = 'popitem' + (danger ? ' danger' : '');
    it.textContent = label;
    it.onclick = (e) => { e.stopPropagation(); closeMenu(); fn(); };
    m.appendChild(it);
  });
  document.body.appendChild(m);
  const mw = m.offsetWidth || 210, mh = m.offsetHeight || 200;
  m.style.left = Math.max(6, Math.min(ev.clientX, window.innerWidth - mw - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(ev.clientY, window.innerHeight - mh - 6)) + 'px';
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { const m = $('__menu'); if (m) m.remove(); }

function splitName(name: string): [string, string] {
  const p = name.split('.');
  return p.length > 1 ? [p[0], p.slice(1).join('.')] : ['public', p[0]];
}

// The column to order "new to old" by: the primary key's first column.
async function primaryOrderCol(name: string): Promise<string> {
  const [sch, tbl] = splitName(name);
  const pk = await scalarList(c(),
    "SELECT kcu.column_name FROM information_schema.table_constraints tc " +
    "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema " +
    "WHERE tc.constraint_type='PRIMARY KEY' AND kcu.table_schema=" + pgStr(sch) + " AND kcu.table_name=" + pgStr(tbl) +
    " ORDER BY kcu.ordinal_position", studioDb);
  return pk.values[0] || '';
}

function setQuery(t: string) { queryText = t; const ta = $('q') as HTMLTextAreaElement | null; if (ta) { ta.value = t; syncHighlight(); } }

async function selectTable(name: string, editable: boolean) {
  selTable = name;
  if (queryCollapsed) { queryCollapsed = false; applyQueryCollapse(); }
  const col = await primaryOrderCol(name);
  // ctid DESC gives a reasonable "newest physical row first" when the table has no primary key.
  const ord = col ? ' ORDER BY ' + pgId(col) + ' DESC' : ' ORDER BY ctid DESC';
  setQuery('SELECT * FROM ' + pgQualified(name) + ord + ' LIMIT 1000;');
  if (editable) await loadEditGrid(name, col);
  else { edit = null; refreshApplyBtn(); await runQuery(); }
}

async function runQuery() {
  const wrap = $('tgrid'); if (!wrap) return;
  const ta = $('q') as HTMLTextAreaElement | null;
  const sql = (ta ? ta.value : queryText).trim();
  if (!sql) { toast('Write a query first.'); return; }
  edit = null; Object.keys(dirty).forEach((k) => delete dirty[k]); refreshApplyBtn();
  await withBusy($('runQuery'), async () => {
    wrap.innerHTML = '<div class="gridmsg"><span class="spin"></span> Running…</div>';
    const g = await queryGrid(c(), sql, studioDb, 300000);
    wrap.innerHTML = gridHtml(g);
  });
}

// ---- editable grid (Edit 1000): edit cells, then Apply commits UPDATEs keyed by the PK ----
async function loadEditGrid(name: string, pkCol: string) {
  const wrap = $('tgrid'); if (!wrap) return;
  if (!pkCol) {
    edit = null; refreshApplyBtn();
    wrap.innerHTML = '<div class="gridmsg err">Cannot edit <b>' + esc(name) + '</b> — it has no primary key to key rows on. Use “Select” to view.</div>';
    return;
  }
  Object.keys(dirty).forEach((k) => delete dirty[k]);
  await withBusy($('applyGrid'), async () => {
    wrap.innerHTML = '<div class="gridmsg"><span class="spin"></span> Loading…</div>';
    const g = await queryGrid(c(), 'SELECT * FROM ' + pgQualified(name) + ' ORDER BY ' + pgId(pkCol) + ' DESC LIMIT 1000', studioDb, 300000);
    if (g.error) { wrap.innerHTML = gridHtml(g); edit = null; refreshApplyBtn(); return; }
    const pkIdx = g.columns.findIndex((cc) => cc.toLowerCase() === pkCol.toLowerCase());
    if (pkIdx < 0) { wrap.innerHTML = '<div class="gridmsg err">Key column not in result.</div>'; edit = null; refreshApplyBtn(); return; }
    edit = { table: name, pk: pkCol, pkIdx, cols: g.columns, orig: g.rows.map((r) => r.slice()) };
    wrap.innerHTML = editGridHtml(g, pkIdx);
    wrap.querySelectorAll<HTMLElement>('td[contenteditable]').forEach((td) => {
      td.oninput = () => {
        const ri = td.getAttribute('data-r') as string, ci = td.getAttribute('data-c') as string;
        const key = ri + ':' + ci;
        const now = td.textContent ?? '';
        const was = edit ? (edit.orig[+ri][+ci] ?? '') : '';
        if (now === was) delete dirty[key]; else dirty[key] = now;
        td.classList.toggle('dirty', key in dirty);
        refreshApplyBtn();
      };
    });
    refreshApplyBtn();
  });
}

function editGridHtml(g: Grid, pkIdx: number): string {
  let h = '<table class="grid editable"><thead><tr>';
  g.columns.forEach((cc, i) => { h += '<th>' + esc(cc) + (i === pkIdx ? ' 🔑' : '') + '</th>'; });
  h += '</tr></thead><tbody>';
  g.rows.forEach((r, ri) => {
    h += '<tr>';
    for (let ci = 0; ci < g.columns.length; ci++) {
      const v = r[ci] ?? '';
      h += ci === pkIdx
        ? '<td class="pkcell">' + (v === 'NULL' ? 'NULL' : esc(v)) + '</td>'
        : '<td contenteditable="true" data-r="' + ri + '" data-c="' + ci + '">' + (v === 'NULL' ? 'NULL' : esc(v)) + '</td>';
    }
    h += '</tr>';
  });
  return h + '</tbody></table>';
}

function refreshApplyBtn() {
  const b = $('applyGrid') as HTMLButtonElement | null; if (!b) return;
  const n = Object.keys(dirty).length;
  b.disabled = !edit || n === 0;
  b.textContent = n > 0 ? 'Apply (' + n + ')' : 'Apply';
}

// The grid shows a SQL NULL as the literal token 'NULL' (queryGrid maps psql's null sentinel to it), so type
// NULL into a cell to store SQL NULL; every other value — including an empty string — is sent as a quoted
// literal (PostgreSQL coerces the unknown-typed literal to the column type).
function pgVal(v: string): string { return v === 'NULL' ? 'NULL' : "'" + v.replace(/'/g, "''") + "'"; }

async function applyEdits() {
  if (!edit) return;
  const cur = edit;
  const keys = Object.keys(dirty); if (!keys.length) return;
  const byRow: Record<string, string[]> = {};
  keys.forEach((k) => { const r = k.split(':')[0]; (byRow[r] = byRow[r] || []).push(k); });
  const stmts = Object.keys(byRow).map((r) => {
    const sets = byRow[r].map((k) => pgId(cur.cols[+k.split(':')[1]]) + ' = ' + pgVal(dirty[k]));
    return 'UPDATE ' + pgQualified(cur.table) + ' SET ' + sets.join(', ') + ' WHERE ' + pgId(cur.pk) + ' = ' + pgVal(cur.orig[+r][cur.pkIdx]) + ';';
  });
  await withBusy($('applyGrid'), async () => {
    const r = out(await exec(psqlBase(c(), studioDb) + ' -q -c ' + sh(stmts.join('\n')) + ' 2>&1', 120000));
    const e = isPgError(r);
    if (e) { toast(e.split('\n').filter(Boolean).pop() || 'Apply failed.'); }
    else { toast('Applied ' + stmts.length + ' change' + (stmts.length > 1 ? 's' : '') + '.'); await loadEditGrid(cur.table, cur.pk); }
  });
}

function newQuery() {
  if (pane !== 'tables') { pane = 'tables'; void selectPane().then(afterNewQuery); return; }
  afterNewQuery();
}
function afterNewQuery() {
  queryCollapsed = false; applyQueryCollapse();
  edit = null; Object.keys(dirty).forEach((k) => delete dirty[k]); refreshApplyBtn();
  setQuery('');
  const ta = $('q') as HTMLTextAreaElement | null; if (ta) ta.focus();
  const wrap = $('tgrid'); if (wrap) wrap.innerHTML = '<div class="gridmsg">Write a query and press ▷ (or Ctrl+Enter).</div>';
}

// ---- Design (table structure) ----
async function designTable(name: string) {
  selTable = name; edit = null; refreshApplyBtn();
  const wrap = $('tgrid'); if (!wrap) return;
  const [sch, tbl] = splitName(name);
  wrap.innerHTML =
    '<div class="stoolbar"><span class="name">' + IC_TABLE + esc(name) + ' · structure</span>' +
    '<button class="btn xs" id="addCol">' + IC_PLUS + ' Column</button></div>' +
    '<div class="gridwrap2" id="structg"><div class="gridmsg"><span class="spin"></span> Loading…</div></div>';
  $('addCol').onclick = () => addColumn(name);
  const g = await queryGrid(c(),
    "SELECT ordinal_position AS pos, column_name AS name, data_type AS type, " +
    "coalesce(character_maximum_length::text, '') AS length, is_nullable AS nullable, " +
    "coalesce(column_default, '') AS default FROM information_schema.columns " +
    "WHERE table_schema=" + pgStr(sch) + " AND table_name=" + pgStr(tbl) + " ORDER BY ordinal_position", studioDb);
  const sg = $('structg'); if (sg) sg.innerHTML = gridHtml(g);
}

function addColumn(name: string) {
  showModal({
    title: 'Add column to ' + name,
    fields: [
      { key: 'name', label: 'Column name', placeholder: 'my_column' },
      { key: 'type', label: 'Type (e.g. text, integer, varchar(100))', value: 'text' },
    ],
    confirmLabel: 'Add',
    onConfirm: async (v) => {
      const col = (v.name || '').trim(), ty = (v.type || '').trim();
      if (!col || !ty) return;
      const r = out(await exec(psqlBase(c(), studioDb) + ' -q -c ' + sh('ALTER TABLE ' + pgQualified(name) + ' ADD COLUMN ' + pgId(col) + ' ' + ty) + ' 2>&1', 60000));
      const e = isPgError(r);
      toast(e ? (e.split('\n').filter(Boolean).pop() || 'Failed.') : 'Column added.');
      if (!e) void designTable(name);
    },
  });
}

// ---- New table: a visual column builder (no hand-written DDL) ----
const SQL_TYPES = ['integer', 'bigint', 'smallint', 'boolean', 'numeric(12,2)', 'real', 'double precision', 'text', 'varchar(100)', 'date', 'timestamptz', 'time', 'uuid', 'jsonb', 'bytea'];
function newTable() {
  const back = document.createElement('div'); back.className = 'modal-scrim';
  const dlg = document.createElement('div'); dlg.className = 'modal wide';
  dlg.innerHTML =
    '<div class="modal-title">New table</div>' +
    '<div class="field"><label>Table name</label><input id="__tn" type="text" placeholder="public.my_table"></div>' +
    '<div class="collabel">Columns</div><div class="colbuild" id="__cols"></div>' +
    '<button class="btn xs" id="__addc" type="button">' + IC_PLUS + ' Add column</button>' +
    '<pre class="log" id="__tlog" style="display:none"></pre>' +
    '<div class="modal-actions"><button class="btn ghost" id="__cancel">Cancel</button>' +
    '<button class="btn primary" id="__ok">Create</button></div>';
  back.appendChild(dlg); document.body.appendChild(back);
  const colsEl = dlg.querySelector('#__cols') as HTMLElement;
  const addColRow = (nm: string, ty: string, pk: boolean, nn: boolean) => {
    const row = document.createElement('div'); row.className = 'colrow';
    row.innerHTML =
      '<input class="cn" type="text" placeholder="column" value="' + esc(nm) + '">' +
      '<select class="cty">' + SQL_TYPES.map((t) => '<option' + (t === ty ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>' +
      '<label class="ck"><input type="checkbox" class="cpk"' + (pk ? ' checked' : '') + '> PK</label>' +
      '<label class="ck"><input type="checkbox" class="cnn"' + (nn ? ' checked' : '') + '> NOT NULL</label>' +
      '<button class="ic cdel" type="button" title="Remove column">' + IC_TRASH + '</button>';
    (row.querySelector('.cdel') as HTMLElement).onclick = () => row.remove();
    colsEl.appendChild(row);
  };
  addColRow('id', 'integer', true, true);
  (dlg.querySelector('#__addc') as HTMLElement).onclick = () => addColRow('', 'text', false, false);
  const close = () => back.remove();
  (dlg.querySelector('#__cancel') as HTMLElement).onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  (dlg.querySelector('#__ok') as HTMLButtonElement).onclick = async () => {
    const tn = (dlg.querySelector('#__tn') as HTMLInputElement).value.trim();
    if (!tn) { toast('Enter a table name.'); return; }
    const defs: string[] = []; const pks: string[] = [];
    dlg.querySelectorAll('.colrow').forEach((r) => {
      const cn = (r.querySelector('.cn') as HTMLInputElement).value.trim();
      if (!cn) return;
      const ty = (r.querySelector('.cty') as HTMLSelectElement).value;
      const pk = (r.querySelector('.cpk') as HTMLInputElement).checked;
      const nn = (r.querySelector('.cnn') as HTMLInputElement).checked;
      // A PK integer becomes serial/bigserial (auto-increment); serial is implicitly NOT NULL.
      let coltype = ty;
      if (pk && /^(integer|int|int4|bigint|int8)$/i.test(ty)) coltype = /big|int8/i.test(ty) ? 'bigserial' : 'serial';
      const nullable = (nn || pk) && !/serial/i.test(coltype) ? ' NOT NULL' : '';
      defs.push('  ' + pgId(cn) + ' ' + coltype + nullable);
      if (pk) pks.push(pgId(cn));
    });
    if (!defs.length) { toast('Add at least one column.'); return; }
    let ddl = 'CREATE TABLE ' + pgQualified(tn) + ' (\n' + defs.join(',\n');
    if (pks.length) ddl += ',\n  PRIMARY KEY (' + pks.join(', ') + ')';
    ddl += '\n);';
    const okBtn = dlg.querySelector('#__ok') as HTMLButtonElement, log = dlg.querySelector('#__tlog') as HTMLElement;
    okBtn.disabled = true; log.style.display = 'block'; log.textContent = 'Creating…';
    const r = out(await exec(psqlBase(c(), studioDb) + ' -q -c ' + sh(ddl) + ' 2>&1', 60000));
    const e = isPgError(r);
    if (e) { log.textContent = r; okBtn.disabled = false; toast('Create failed.'); }
    else { close(); toast('Table created.'); await loadTables(); }
  };
}

function renameTable(name: string) {
  showModal({
    title: 'Rename table', body: 'Rename <b>' + esc(name) + '</b> to:',
    fields: [{ key: 'to', label: 'New name (without schema)', placeholder: 'new_name' }],
    confirmLabel: 'Rename',
    onConfirm: async (v) => {
      const to = (v.to || '').trim(); if (!to) return;
      const newName = to.indexOf('.') >= 0 ? to.split('.').pop() as string : to;
      const r = out(await exec(psqlBase(c(), studioDb) + ' -q -c ' + sh('ALTER TABLE ' + pgQualified(name) + ' RENAME TO ' + pgId(newName)) + ' 2>&1', 60000));
      const e = isPgError(r);
      toast(e ? (e.split('\n').filter(Boolean).pop() || 'Error') : 'Renamed.');
      if (!e) { if (selTable === name) selTable = ''; await loadTables(); }
    },
  });
}

function dropTable(name: string) {
  showModal({
    title: 'Delete table', body: 'Delete <b>' + esc(name) + '</b> and all its data? This cannot be undone.',
    confirmLabel: 'Delete', danger: true,
    onConfirm: async () => {
      const r = out(await exec(psqlBase(c(), studioDb) + ' -q -c ' + sh('DROP TABLE ' + pgQualified(name)) + ' 2>&1', 60000));
      const e = isPgError(r);
      toast(e ? (e.split('\n').filter(Boolean).pop() || 'Error') : 'Deleted.');
      if (!e) { if (selTable === name) selTable = ''; await loadTables(); const w = $('tgrid'); if (w) w.innerHTML = '<div class="gridmsg">Table deleted.</div>'; }
    },
  });
}

// ---- Diagram pane ----
interface DCol { name: string; type: string; pk: boolean; fk: boolean }
async function renderDiagramPane(host: HTMLElement) {
  host.innerHTML =
    '<div class="diagram">' +
    '<div class="dtoolbar"><button class="btn xs" id="dAdd">' + IC_PLUS + ' Add table</button>' +
    '<button class="btn xs" id="dClear">Clear</button><span class="dhint"></span></div>' +
    '<div class="dcanvas" id="dcanvas"></div></div>';
  $('dAdd').onclick = () => void addToDiagram();
  $('dClear').onclick = () => { diagramTables = []; void drawDiagram(); };
  await drawDiagram();
}

async function addToDiagram() {
  const res = await scalarList(c(), "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1", studioDb);
  if (res.error) { toast(res.error.split('\n')[0]); return; }
  const avail = res.values.filter((t) => diagramTables.indexOf(t) < 0);
  if (!avail.length) { toast(res.values.length ? 'All tables are on the canvas.' : 'No tables.'); return; }
  const back = document.createElement('div'); back.className = 'modal-scrim';
  const dlg = document.createElement('div'); dlg.className = 'modal';
  dlg.innerHTML = '<div class="modal-title">Add table to diagram</div><div class="pick" id="__pick"></div>' +
    '<div class="modal-actions"><button class="btn ghost" id="__cancel">Close</button></div>';
  back.appendChild(dlg); document.body.appendChild(back);
  const pick = dlg.querySelector('#__pick') as HTMLElement;
  avail.forEach((t) => {
    const it = document.createElement('div'); it.className = 'pickrow';
    it.innerHTML = '<span class="ti">' + IC_TABLE + '</span><span>' + esc(t) + '</span>';
    it.onclick = () => { diagramTables.push(t); back.remove(); void drawDiagram(); };
    pick.appendChild(it);
  });
  const close = () => back.remove();
  (dlg.querySelector('#__cancel') as HTMLElement).onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
}

async function drawDiagram() {
  const canvas = $('dcanvas'); if (!canvas) return;
  const hint = document.querySelector('.dhint'); if (hint) hint.textContent = diagramTables.length + ' table(s) on canvas';
  if (!diagramTables.length) {
    canvas.innerHTML = '<div class="gridmsg">Empty canvas — tap <b>+ Add table</b> to place tables and see their relationships.</div>';
    return;
  }
  canvas.innerHTML = '<div class="gridmsg"><span class="spin"></span> Building…</div>';
  // Only fetch columns/FKs for the tables ON the canvas — querying the whole schema returns a huge payload
  // that (through the JS bridge) blocks the UI thread and ANRs the app on a large database.
  const set: Record<string, boolean> = {}; diagramTables.forEach((t) => { set[t] = true; });
  const inList = diagramTables.map((t) => pgStr(t)).join(',');
  const colsG = await queryGrid(c(),
    "SELECT c.table_schema || '.' || c.table_name AS t, c.column_name AS n, c.data_type AS ty, " +
    "CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS pk, " +
    "CASE WHEN fk.column_name IS NOT NULL THEN 1 ELSE 0 END AS fk FROM information_schema.columns c " +
    "LEFT JOIN (SELECT kcu.table_schema, kcu.table_name, kcu.column_name FROM information_schema.table_constraints tc " +
    "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema " +
    "WHERE tc.constraint_type='PRIMARY KEY') pk ON pk.table_schema=c.table_schema AND pk.table_name=c.table_name AND pk.column_name=c.column_name " +
    "LEFT JOIN (SELECT kcu.table_schema, kcu.table_name, kcu.column_name FROM information_schema.table_constraints tc " +
    "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema " +
    "WHERE tc.constraint_type='FOREIGN KEY') fk ON fk.table_schema=c.table_schema AND fk.table_name=c.table_name AND fk.column_name=c.column_name " +
    "WHERE (c.table_schema || '.' || c.table_name) IN (" + inList + ") ORDER BY c.table_schema, c.table_name, c.ordinal_position", studioDb);
  if (colsG.error) { canvas.innerHTML = '<div class="gridmsg err">' + esc(colsG.error) + '</div>'; return; }
  const tables: Record<string, DCol[]> = {};
  colsG.rows.forEach((r) => {
    if (!set[r[0]]) return;
    if (!tables[r[0]]) tables[r[0]] = [];
    tables[r[0]].push({ name: r[1], type: r[2], pk: r[3] === '1', fk: r[4] === '1' });
  });
  const fkG = await queryGrid(c(),
    "SELECT DISTINCT tc.table_schema || '.' || tc.table_name AS ft, ccu.table_schema || '.' || ccu.table_name AS tt " +
    "FROM information_schema.table_constraints tc " +
    "JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name AND tc.table_schema=ccu.table_schema " +
    "WHERE tc.constraint_type='FOREIGN KEY' AND (tc.table_schema || '.' || tc.table_name) IN (" + inList + ") AND (ccu.table_schema || '.' || ccu.table_name) IN (" + inList + ")", studioDb);
  const edges = (fkG.rows || []).map((r) => ({ from: r[0], to: r[1] })).filter((e) => e.from !== e.to && set[e.from] && set[e.to]);

  let html = '<svg class="dsvg" id="dsvg"></svg>';
  diagramTables.forEach((t) => {
    html += '<div class="dtable" data-t="' + esc(t) + '"><div class="dh">' + IC_TABLE + esc(t) +
      '<button class="ic dremove" data-rt="' + esc(t) + '" title="Remove from canvas">' + IC_TRASH + '</button></div>';
    (tables[t] || []).forEach((col) => {
      const kind = col.pk ? '<span class="k pk">PK</span>' : col.fk ? '<span class="k fk">FK</span>' : '';
      html += '<div class="dc"><span class="cn">' + esc(col.name) + '</span><span class="ct">' + esc(col.type) + '</span>' + kind + '</div>';
    });
    html += '</div>';
  });
  canvas.innerHTML = html;
  canvas.querySelectorAll<HTMLElement>('.dremove').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const t = b.getAttribute('data-rt') as string; diagramTables = diagramTables.filter((x) => x !== t); void drawDiagram(); };
  });
  requestAnimationFrame(() => drawEdges(canvas, edges));
}

function drawEdges(canvas: HTMLElement, edges: { from: string; to: string }[]) {
  const svg = document.getElementById('dsvg'); if (!svg) return;
  const cards: Record<string, HTMLElement> = {};
  canvas.querySelectorAll<HTMLElement>('.dtable').forEach((el) => { cards[el.getAttribute('data-t') as string] = el; });
  const w = Math.max(canvas.scrollWidth, canvas.clientWidth);
  const h = Math.max(canvas.scrollHeight, canvas.clientHeight);
  svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  let paths = '';
  edges.forEach((e) => {
    const a = cards[e.from], b = cards[e.to];
    if (!a || !b) return;
    const ax = a.offsetLeft + a.offsetWidth / 2, ay = a.offsetTop + a.offsetHeight / 2;
    const bx = b.offsetLeft + b.offsetWidth / 2, by = b.offsetTop + b.offsetHeight / 2;
    const mx = (ax + bx) / 2;
    paths += '<path d="M ' + ax + ' ' + ay + ' C ' + mx + ' ' + ay + ' ' + mx + ' ' + by + ' ' + bx + ' ' + by + '"/>';
    paths += '<circle cx="' + ax + '" cy="' + ay + '" r="3" fill="var(--accent)"/>';
    paths += '<circle cx="' + bx + '" cy="' + by + '" r="3" fill="var(--accent)"/>';
  });
  svg.innerHTML = paths;
}

// ---- Security pane ----
async function renderSecurityPane(host: HTMLElement) {
  host.innerHTML = '<div class="cols" id="sec"><div class="gridmsg">Loading…</div></div>';
  const sec = $('sec');
  const roles = await queryGrid(c(),
    "SELECT rolname AS role, CASE WHEN rolcanlogin THEN 'yes' ELSE 'no' END AS can_login, " +
    "CASE WHEN rolsuper THEN 'yes' ELSE 'no' END AS superuser, " +
    "CASE WHEN rolcreatedb THEN 'yes' ELSE 'no' END AS create_db FROM pg_roles ORDER BY rolname", studioDb);
  const grants = await queryGrid(c(),
    "SELECT grantee, table_schema || '.' || table_name AS \"table\", privilege_type AS privilege " +
    "FROM information_schema.role_table_grants " +
    "WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY grantee, \"table\" LIMIT 500", studioDb);
  sec.innerHTML =
    '<div class="sec-ttl">Roles</div>' + gridHtml(roles) +
    '<div class="sec-ttl" style="margin-top:16px">Table privileges</div>' + gridHtml(grants);
}

// ---- Backup pane (pg_dump / pg_restore) ----
function renderBackupPane(host: HTMLElement) {
  const def = '/root/pgdumps/' + studioDb + '.dump';
  host.innerHTML =
    '<div class="cols">' +
    '<div class="sec-ttl">Backup / Restore</div>' +
    '<div class="sqlhint" style="padding:0 0 10px">Dumps and restores run in the Linux runtime with <b>pg_dump</b> / <b>pg_restore</b>. ' +
    'The path is a file inside the runtime, not on the server.</div>' +
    '<div class="field"><label>Dump file path</label><input id="bkpath"></div>' +
    '<div class="stoolbar" style="border:0;padding:0 0 10px">' +
      '<button class="btn sm primary" id="bkdo">Back up (pg_dump -Fc)</button>' +
      '<button class="btn sm danger" id="rsdo">Restore (pg_restore)</button></div>' +
    '<pre class="log" id="bklog" style="display:none"></pre>' +
    '</div>';
  ($('bkpath') as HTMLInputElement).value = def;
  $('bkdo').onclick = () => void doBackup();
  $('rsdo').onclick = restorePrompt;
}

async function doBackup() {
  const path = ($('bkpath') as HTMLInputElement).value.trim(); if (!path) return;
  const log = $('bklog'); log.style.display = 'block'; log.textContent = 'Backing up ' + studioDb + ' → ' + path + ' …';
  const dir = path.replace(/\/[^/]*$/, '') || '.';
  const cmd = 'mkdir -p ' + sh(dir) + ' && ' + pgEnv(c()) + 'pg_dump -h ' + sh(c().host) + ' -p ' + sh(c().port) +
    ' -U ' + sh(c().user) + ' -w -Fc -f ' + sh(path) + ' ' + sh(studioDb) + ' 2>&1 && ls -la ' + sh(path);
  const r = out(await exec(cmd, 600000));
  log.textContent = r || 'Backup complete.';
  toast(isPgError(r) ? 'Backup failed.' : 'Backed up to ' + path);
}

function restorePrompt() {
  const path = ($('bkpath') as HTMLInputElement).value.trim(); if (!path) return;
  showModal({
    title: 'Restore database',
    body: 'Restore <b>' + esc(studioDb) + '</b> from <b>' + esc(path) + '</b>? Existing objects are dropped and recreated (--clean).',
    confirmLabel: 'Restore', danger: true,
    onConfirm: async () => {
      const log = $('bklog'); log.style.display = 'block'; log.textContent = 'Restoring ' + studioDb + ' from ' + path + ' …';
      const cmd = pgEnv(c()) + 'pg_restore -h ' + sh(c().host) + ' -p ' + sh(c().port) + ' -U ' + sh(c().user) +
        ' -w -d ' + sh(studioDb) + ' --clean --if-exists --no-owner ' + sh(path) + ' 2>&1; echo "exit:$?"';
      const r = out(await exec(cmd, 600000));
      log.textContent = r || 'Restore complete.';
      // pg_restore's echoed exit code is authoritative (benign --clean/--if-exists warnings still exit 0).
      const bad = isPgError(r) || /(^|\n)exit:[1-9]/.test(r);
      toast(bad ? 'Restore failed — see the log.' : 'Restore complete.');
    },
  });
}

// ==========================================================================
// ROUTER
// ==========================================================================
async function boot() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.indexOf('studio:') === 0) await renderStudio(hash.slice('studio:'.length));
  else await renderDrawer();
}

void boot();
