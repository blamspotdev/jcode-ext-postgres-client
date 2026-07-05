# jcode-ext-postgres-client

A **PostgreSQL** client and database studio for [JCode](https://github.com/blamspotdev).

Open it from the left drawer: **DB Managers → Postgres Client**. The drawer lists the databases on
the server configured in **Settings → Extensions → Postgres Client**; tap one to open a full studio
as an editor tab with **Tables / Query / Diagram / Security / Backup** panes.

It drives the ARM64-native `psql` / `pg_dump` / `pg_restore` tools (installed on first use from the
distro's own apt repo — `postgresql-client`). It connects to any reachable PostgreSQL server — a
remote host, a cloud instance, or a server on your network.

## Local server (native, no VM)

The drawer's **Local server** section can run a **native ARM64 PostgreSQL server right in the
runtime** — one click installs it, initializes a cluster, starts it, and points the client at it.
Android kernels ship without SysV IPC (`CONFIG_SYSVIPC` unset), which normally stops PostgreSQL
from starting; this extension bundles a tiny `LD_PRELOAD` shim (`libandroshm`, see `native/`) that
emulates the one SysV shared-memory segment PostgreSQL needs on top of `memfd`. The server runs as
the non-root `postgres` user (via `su`, so it doesn't refuse to start) and listens on
`127.0.0.1:5432`. Start/Stop it from the same section; the cluster is persistent.

## Build

```sh
npm install
npm run build        # tsc --noEmit, then esbuild src/ → www/
```

`jext pack .` (from [j-code-make-tools](https://github.com/blamspotdev)) runs the build and packages
the deployable `www/` into a `.jext`.

## Architecture

TypeScript bundled to `www/main.js` by esbuild; one bundle serves two surfaces by `location.hash`:

- **`#`** — the left-drawer database list (connection status + browse databases).
- **`#studio:<db>`** — a per-database studio opened as an editor tab via `workbench.openView`.

Connection settings (host, port, role, password, database, SSL mode) are declared in the manifest
`settings:` block and read via the `config.*` Extension API, so credentials live in app Settings and
are shared by the drawer and every studio tab. Queries run through `exec.run` (as root in the runtime).
