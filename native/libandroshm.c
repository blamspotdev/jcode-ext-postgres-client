/*
 * libandroshm — a minimal SysV shared-memory shim for Android kernels that lack
 * CONFIG_SYSVIPC (shmget/shmat/shmdt/shmctl return ENOSYS). Backs each SysV segment
 * with an anonymous memfd + MAP_SHARED mmap, so forked children inherit the mapping.
 *
 * Scope: exactly what PostgreSQL needs on Linux (fork model, POSIX semaphores).
 * It does NOT support attach-by-key from an unrelated (non-forked) process — PG only
 * needs that for its cross-postmaster interlock, which we intentionally treat as
 * "no other instance" (postmaster.pid flock still protects the data dir).
 *
 * LD_PRELOAD this .so for initdb and postgres.
 */
#define _GNU_SOURCE
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>

#define MAX_SEG 64
#define MAX_ATT 512

struct seg { int used, shmid, marked, nattch; key_t key; size_t size; int memfd; pid_t cpid; };
struct att { int used, shmid; void *addr; size_t size; };

static struct seg segs[MAX_SEG];
static struct att atts[MAX_ATT];
static int next_id = 1000;
static pthread_mutex_t lk = PTHREAD_MUTEX_INITIALIZER;

static FILE *logf = NULL;
static int log_ready = 0;
static void lg(const char *fmt, ...) {
    if (!log_ready) {
        const char *p = getenv("ANDROSHM_LOG");
        if (p && *p) logf = fopen(p, "a");
        log_ready = 1;
    }
    if (!logf) return;
    va_list ap; va_start(ap, fmt);
    vfprintf(logf, fmt, ap);
    va_end(ap); fputc('\n', logf); fflush(logf);
}

static struct seg *by_id(int id){ for(int i=0;i<MAX_SEG;i++) if(segs[i].used && segs[i].shmid==id) return &segs[i]; return NULL; }
static struct seg *by_key(key_t k){ if(k==IPC_PRIVATE) return NULL; for(int i=0;i<MAX_SEG;i++) if(segs[i].used && segs[i].key==k) return &segs[i]; return NULL; }

int shmget(key_t key, size_t size, int shmflg){
    pthread_mutex_lock(&lk);
    struct seg *s = by_key(key);
    if (s) {
        if ((shmflg & IPC_CREAT) && (shmflg & IPC_EXCL)) { pthread_mutex_unlock(&lk); errno=EEXIST; lg("shmget key=%d EEXIST", (int)key); return -1; }
        int id=s->shmid; pthread_mutex_unlock(&lk); lg("shmget key=%d -> existing %d", (int)key, id); return id;
    }
    if (!(shmflg & IPC_CREAT)) { pthread_mutex_unlock(&lk); errno=ENOENT; lg("shmget key=%d ENOENT", (int)key); return -1; }
    int slot=-1; for(int i=0;i<MAX_SEG;i++) if(!segs[i].used){slot=i;break;}
    if (slot<0){ pthread_mutex_unlock(&lk); errno=ENOSPC; lg("shmget ENOSPC"); return -1; }
    int fd = memfd_create("androshm", 0);
    if (fd<0){ int e=errno; pthread_mutex_unlock(&lk); errno=e; lg("shmget memfd fail %d", e); return -1; }
    if (ftruncate(fd, (off_t)size)!=0){ int e=errno; close(fd); pthread_mutex_unlock(&lk); errno=e; lg("shmget ftruncate fail %d", e); return -1; }
    segs[slot].used=1; segs[slot].shmid=next_id++; segs[slot].key=key; segs[slot].size=size;
    segs[slot].memfd=fd; segs[slot].marked=0; segs[slot].nattch=0; segs[slot].cpid=getpid();
    int id=segs[slot].shmid;
    pthread_mutex_unlock(&lk);
    lg("shmget key=%d size=%zu -> new id=%d fd=%d", (int)key, size, id, fd);
    return id;
}

void *shmat(int shmid, const void *shmaddr, int shmflg){
    pthread_mutex_lock(&lk);
    struct seg *s = by_id(shmid);
    if (!s){ pthread_mutex_unlock(&lk); errno=EINVAL; lg("shmat id=%d EINVAL", shmid); return (void*)-1; }
    int prot = PROT_READ | ((shmflg & SHM_RDONLY)?0:PROT_WRITE);
    void *p = mmap((void*)shmaddr, s->size, prot, MAP_SHARED, s->memfd, 0);
    if (p==MAP_FAILED){ int e=errno; pthread_mutex_unlock(&lk); errno=e; lg("shmat id=%d mmap fail %d", shmid, e); return (void*)-1; }
    for(int i=0;i<MAX_ATT;i++) if(!atts[i].used){ atts[i].used=1; atts[i].addr=p; atts[i].size=s->size; atts[i].shmid=shmid; break; }
    s->nattch++;
    pthread_mutex_unlock(&lk);
    lg("shmat id=%d -> %p", shmid, p);
    return p;
}

int shmdt(const void *shmaddr){
    pthread_mutex_lock(&lk);
    for(int i=0;i<MAX_ATT;i++){
        if(atts[i].used && atts[i].addr==shmaddr){
            munmap(atts[i].addr, atts[i].size);
            int id=atts[i].shmid; atts[i].used=0;
            struct seg *s=by_id(id);
            if(s){ if(s->nattch>0) s->nattch--; if(s->marked && s->nattch<=0){ close(s->memfd); s->used=0; } }
            pthread_mutex_unlock(&lk); lg("shmdt %p (id=%d)", shmaddr, id); return 0;
        }
    }
    pthread_mutex_unlock(&lk); errno=EINVAL; lg("shmdt %p EINVAL", shmaddr); return -1;
}

int shmctl(int shmid, int cmd, struct shmid_ds *buf){
    pthread_mutex_lock(&lk);
    struct seg *s = by_id(shmid);
    if (cmd==IPC_STAT){
        if(!s){ pthread_mutex_unlock(&lk); errno=EINVAL; lg("shmctl STAT id=%d EINVAL", shmid); return -1; }
        if(buf){ memset(buf,0,sizeof(*buf)); buf->shm_segsz=s->size; buf->shm_nattch=s->nattch; buf->shm_cpid=s->cpid; buf->shm_lpid=getpid(); buf->shm_perm.uid=getuid(); buf->shm_perm.gid=getgid(); buf->shm_perm.cuid=getuid(); buf->shm_perm.cgid=getgid(); buf->shm_perm.mode=0600; }
        pthread_mutex_unlock(&lk); lg("shmctl STAT id=%d nattch=%d", shmid, s->nattch); return 0;
    }
    if (cmd==IPC_RMID){
        if(!s){ pthread_mutex_unlock(&lk); errno=EINVAL; lg("shmctl RMID id=%d EINVAL", shmid); return -1; }
        s->marked=1; if(s->nattch<=0){ close(s->memfd); s->used=0; }
        pthread_mutex_unlock(&lk); lg("shmctl RMID id=%d", shmid); return 0;
    }
    pthread_mutex_unlock(&lk);
    if (cmd==IPC_SET) return 0;
    if(!s){ errno=EINVAL; return -1; }
    return 0;
}
