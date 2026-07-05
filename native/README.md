# libandroshm — native PostgreSQL on Android

Android kernels are built **without `CONFIG_SYSVIPC`**, so the SysV shared-memory
syscalls (`shmget`/`shmat`/`shmdt`/`shmctl`) return `ENOSYS`. PostgreSQL needs one small
SysV shared-memory segment (its postmaster interlock), so `initdb`/`postgres` die at
"running bootstrap script" with:

```
FATAL: could not create shared memory segment: Function not implemented
DETAIL: Failed system call was shmget(...).
```

`libandroshm.c` is an `LD_PRELOAD` shim that reimplements those four SysV shm functions
on top of an anonymous **`memfd` + `MAP_SHARED` mmap**, which forked backends inherit.
PostgreSQL 16 on Ubuntu uses **POSIX unnamed semaphores** (`sem_init`/`sem_wait`, futex-backed),
which already work on Android — so **no semaphore emulation is needed**, only shm.

It intentionally does not support attach-by-key from an unrelated (non-forked) process —
PostgreSQL only needs that for its cross-postmaster interlock, which we treat as
"no other instance" (the `postmaster.pid` flock still guards the data directory).

## Build (native aarch64, inside the runtime)

```sh
gcc -shared -fPIC -O2 -o libandroshm.so libandroshm.c -lpthread
```

## Use

The runtime's proot runs with fake-root (`-0`), but `postgres` refuses to run as (e)uid 0.
proot's fake-id0 tracks `setuid`, so `su <user>` yields a real non-zero euid. Run both
`initdb` and `postgres` as a non-root user with the shim preloaded (set `LD_PRELOAD`
*inside* the `su -c` string, since `su` strips it from the inherited environment):

```sh
su postgres -c "LD_PRELOAD=/path/libandroshm.so /usr/lib/postgresql/16/bin/initdb -D <data> -U pg -A trust"
su postgres -c "LD_PRELOAD=/path/libandroshm.so /usr/lib/postgresql/16/bin/postgres -D <data>"
```

Recommended `postgresql.conf`: `shared_memory_type = mmap` (keeps the shim segment tiny —
just the interlock), `dynamic_shared_memory_type = mmap` (file-backed; no `/dev/shm`).
Set `ANDROSHM_LOG=/path/log` to trace the shim's shm calls.

Device-verified on 2026-07-04 (AYN Odin2): PostgreSQL 16.14 aarch64, `initdb` + server +
`CREATE DATABASE`/`CREATE TABLE`/`INSERT`/`SELECT`, both as a bare non-root proot and via
`su` under the extension's normal fake-root runtime.
