// xenoking-mount-once.elf — XENO TOOL on-console mod loader (v3.2.29 MVP).
//
// One-shot payload. Sent to the PS5 via :9021 by the desktop app's
// "Apply Mods Now" button AFTER the user has launched Elden Ring. Reads the
// active-mods state file the desktop wrote to /data/xeno_mods/CUSA18000/
// state.json, finds the ER process's sandbox path, and unionfs-mounts each
// active mod's top-level subdirs (parts/, chr/, msg/, sfx/, action/script/)
// over the matching <sandbox>/app0/<subdir>/ inside the running game's jail.
//
// Why unionfs and not single-file nullfs: PS5 kernel is FreeBSD 11.0; the
// patch that landed support for single-file nullfs is FreeBSD 14 (D37478,
// Dec 2022). Per-directory unionfs with a sparse upper layer is the
// scene-proven workaround — BackPork (BestPig/BackPork) does exactly this
// for /lib backports. We swap the fstype to "unionfs" and the polarity to
// {from=src, fspath=dst}.
//
// Cleanup: there isn't any. When the ER process exits, SceShellCore tears
// down the entire sandbox mount stack including our overlays. The mounts
// are scoped to ONE game session — re-run "Apply Mods Now" each launch.

#include <sys/param.h>
#include <sys/mount.h>      // nmount, unmount, MNT_FORCE
#include <sys/uio.h>        // struct iovec
#include <sys/sysctl.h>     // sysctl, CTL_KERN, KERN_PROC, KERN_PROC_ALL
#include <sys/stat.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdarg.h>

// ps5-payload-dev SDK exposes the full ucred elevation API via
// <ps5/kernel.h>. The kernel-RW context auto-initializes on first call
// (no kernel_init_rw entry point in the public header). Real signatures:
//   uint64_t kernel_get_ucred_authid(pid_t pid)     — returns value
//   int      kernel_set_ucred_authid(pid_t, uint64) — 2 args
//   int      kernel_set_ucred_caps(pid_t, uint64)   — 2 args (single
//                                                     combined caps mask)
#include <ps5/kernel.h>

// Root-debugger authid. Same value every scene tool uses (SceShellCore +
// debug-authority bit). Combined with all-caps below this gives nmount the
// PRIV_VFS_MOUNT_NONUSER capability it needs to overlay onto /mnt/sandbox/.
#define ROOT_AUTHID 0x4800000000010003ULL

#define LOG_PATH       "/data/xeno_mods/mount-once.log"
#define STATE_FMT      "/data/xeno_mods/%s/state.json"
#define MOD_ROOT_FMT   "/data/xeno_mods/%s/%s"           // /data/xeno_mods/<title>/<mod_id>
#define SBX_PARENT     "/mnt/sandbox"
#define MAX_MODS       64
#define MAX_ID         96
#define MAX_PATH       1024
#define MAX_STATE_SZ   (64 * 1024)

// Sony's appinfo blob shape (the only stable bit we care about is title_id at
// offset 16). Taken verbatim from the BackPork / kstuff scene canon — Sony
// hasn't changed this layout in years.
typedef struct {
    uint32_t app_id;
    uint64_t unk1;
    char     title_id[14];
    char     padding[0x3c];
} app_info_t;

extern int sceKernelGetAppInfo(pid_t, app_info_t *);

// ──────────────────────────────────────────────────────────────────────
//  PS5 system notification (the top-right corner toast)
// ──────────────────────────────────────────────────────────────────────
//
// Same API CheatRunner / etaHEN / BackPork use. The notification text is
// rendered by SceShellCore which handles UTF-8, so emojis work. Layout is
// the canonical scene struct; only `message` matters for our use case.

// Canonical layout used by BinLoader / kpayload / BackPork etc — 45-byte
// header padding then a 3075-byte message buffer. Total size 0xc30 = 3120,
// which is the size value the kernel handler actually expects. v3.2.33 used
// sizeof() = 4144 with an extra trailer buffer; the kernel quietly rejects
// requests whose size doesn't match its expected 3120 so nothing rendered.
#define NOTIFY_SIZE 0xc30
typedef struct {
    char useless1[45];
    char message[3075];
} OrbisNotificationRequest;
_Static_assert(sizeof(OrbisNotificationRequest) == NOTIFY_SIZE, "notify struct size mismatch");

extern int sceKernelSendNotificationRequest(int, OrbisNotificationRequest *, size_t, int);

static void ps5_notify(const char *fmt, ...) {
    OrbisNotificationRequest req;
    memset(&req, 0, sizeof(req));
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(req.message, sizeof(req.message), fmt, ap);
    va_end(ap);
    sceKernelSendNotificationRequest(0, &req, NOTIFY_SIZE, 0);
}

// ──────────────────────────────────────────────────────────────────────
//  logging
// ──────────────────────────────────────────────────────────────────────
static FILE *g_log;

static void log_open(void) {
    g_log = fopen(LOG_PATH, "w");
}
static void llog(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    if (g_log) { vfprintf(g_log, fmt, ap); fputc('\n', g_log); fflush(g_log); }
    va_end(ap);
    // Also try stderr — etaHEN's payload runner sometimes catches it on the
    // klog ring, which makes remote debugging easier.
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}
static void log_close(void) {
    if (g_log) fclose(g_log);
}

// ──────────────────────────────────────────────────────────────────────
//  process discovery (BackPork pattern)
// ──────────────────────────────────────────────────────────────────────
//
// PS5 kernel keeps the FreeBSD kinfo_proc layout. Walk every process via
// sysctl(KERN_PROC_ALL), filter for td_name == "eboot.bin", confirm title id
// via sceKernelGetAppInfo. ki_pid and ki_tdname offsets are stable on every
// PS5 firmware.

#define KI_PID_OFFSET    72
#define KI_TDNAME_OFFSET 447

static pid_t find_game_pid(const char *want_title_id) {
    int mib[4] = { 1 /*CTL_KERN*/, 14 /*KERN_PROC*/, 8 /*KERN_PROC_ALL*/, 0 };
    size_t bufsz = 0;
    if (sysctl(mib, 4, NULL, &bufsz, NULL, 0) != 0) {
        llog("sysctl size: %s", strerror(errno));
        return -1;
    }
    uint8_t *buf = malloc(bufsz);
    if (!buf) return -1;
    if (sysctl(mib, 4, buf, &bufsz, NULL, 0) != 0) {
        llog("sysctl read: %s", strerror(errno));
        free(buf);
        return -1;
    }
    pid_t match = -1;
    for (uint8_t *p = buf; p < buf + bufsz;) {
        int struct_size = *(int *)p;
        if (struct_size <= 0) break;
        pid_t pid = *(pid_t *)(p + KI_PID_OFFSET);
        const char *tdname = (const char *)(p + KI_TDNAME_OFFSET);
        if (strcmp(tdname, "eboot.bin") == 0) {
            app_info_t ai = {0};
            if (sceKernelGetAppInfo(pid, &ai) == 0) {
                if (strncmp(ai.title_id, want_title_id, strlen(want_title_id)) == 0) {
                    match = pid;
                    break;
                }
            }
        }
        p += struct_size;
    }
    free(buf);
    return match;
}

// ──────────────────────────────────────────────────────────────────────
//  sandbox path resolution
// ──────────────────────────────────────────────────────────────────────
//
// Each game session gets a fresh /mnt/sandbox/<TITLE_ID>_<NNN>/<random>/
// directory tree containing app0/, common/, savedata/. The <NNN> counter
// increments across sessions; the <random> dir is per-mount. Scan
// /mnt/sandbox/ for the highest-numbered <TITLE_ID>_NNN dir, then enumerate
// its children for the random-hash subdir that contains "app0".

static int resolve_sandbox_app0(const char *title_id, char *out, size_t outsz) {
    DIR *d = opendir(SBX_PARENT);
    if (!d) { llog("opendir %s: %s", SBX_PARENT, strerror(errno)); return -1; }
    char best_prefix[MAX_PATH] = {0};
    int  best_n = -1;
    size_t tid_len = strlen(title_id);
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (strncmp(e->d_name, title_id, tid_len) != 0) continue;
        if (e->d_name[tid_len] != '_') continue;
        int n = atoi(e->d_name + tid_len + 1);
        if (n > best_n) {
            best_n = n;
            snprintf(best_prefix, sizeof(best_prefix), "%s/%s", SBX_PARENT, e->d_name);
        }
    }
    closedir(d);
    if (best_n < 0) { llog("no /mnt/sandbox/%s_* — is ER running?", title_id); return -1; }
    llog("  best sandbox dir: %s", best_prefix);

    // v3.2.34: don't probe access(F_OK) — on PS5 BC sandboxes it returns
    // EACCES even on a clearly-valid path because the userspace VFS check
    // refuses to traverse through the BC's unionfs/jail boundary. The
    // kernel-side nmount() syscall has no such limitation. We construct the
    // canonical PS4-BC path and hand it back; the mount loop will report
    // the real errno (ENOENT, EBUSY, EPERM …) from nmount itself, which is
    // the only thing that matters anyway. Trying to "validate" the path
    // first just throws away signal.
    snprintf(out, outsz, "%s/app0", best_prefix);
    llog("  using PS4-BC direct layout: %s (nmount will be the source of truth)", out);
    return 0;
}

// ──────────────────────────────────────────────────────────────────────
//  state.json parse (tiny, no full JSON dep)
// ──────────────────────────────────────────────────────────────────────
//
// Expected shape (written by commands/mods.rs::mods_active_save then pushed
// to PS5 by the desktop app):
//   { "title_id": "CUSA18000", "active": ["naruto-six-paths", ...] }

static int parse_state(
    const char *path,
    char title_id[16],
    char active[MAX_MODS][MAX_ID],
    int *n_active
) {
    *n_active = 0;
    title_id[0] = '\0';
    FILE *f = fopen(path, "rb");
    if (!f) { llog("open %s: %s", path, strerror(errno)); return -1; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    if (sz <= 0 || sz > MAX_STATE_SZ) { fclose(f); llog("state.json size bad: %ld", sz); return -1; }
    fseek(f, 0, SEEK_SET);
    char *buf = malloc(sz + 1);
    if (!buf) { fclose(f); return -1; }
    if (fread(buf, 1, sz, f) != (size_t)sz) { free(buf); fclose(f); return -1; }
    buf[sz] = '\0';
    fclose(f);

    // title_id — one too many strchr() steps in v3.2.34 made this empty
    // (we were memcpy'ing the JSON whitespace between the value's closing
    // quote and the NEXT key's opening quote). Fixed: just find the opening
    // quote of the value, then its closing quote.
    const char *tk = strstr(buf, "\"title_id\"");
    if (tk) {
        const char *open_q = strchr(tk + 10, '"');           // opening quote of value
        if (open_q) {
            const char *close_q = strchr(open_q + 1, '"');   // closing quote of value
            if (close_q && close_q - open_q - 1 < 15) {
                memcpy(title_id, open_q + 1, close_q - open_q - 1);
                title_id[close_q - open_q - 1] = '\0';
            }
        }
    }
    // active[]
    const char *ak = strstr(buf, "\"active\"");
    if (ak) {
        const char *lb = strchr(ak, '[');
        const char *rb = lb ? strchr(lb, ']') : NULL;
        if (lb && rb) {
            const char *p = lb + 1;
            while (p < rb && *n_active < MAX_MODS) {
                const char *q = strchr(p, '"');
                if (!q || q > rb) break;
                const char *end = strchr(q + 1, '"');
                if (!end || end > rb) break;
                size_t len = end - q - 1;
                if (len < MAX_ID) {
                    memcpy(active[*n_active], q + 1, len);
                    active[*n_active][len] = '\0';
                    (*n_active)++;
                }
                p = end + 1;
            }
        }
    }
    free(buf);
    return 0;
}

// ──────────────────────────────────────────────────────────────────────
//  unionfs overlay (BackPork's mount2)
// ──────────────────────────────────────────────────────────────────────
//
// Stacks src on top of dst — reads fall through to dst when src has no
// shadowing entry. Flags=0; MNT_RDONLY does not apply to overlay mounts.

#define IOVE(s) { (s) ? (char *)(s) : NULL, (s) ? strlen(s) + 1 : 0 }

static int union_overlay(const char *src, const char *dst) {
    struct iovec iov[] = {
        IOVE("fstype"),  IOVE("unionfs"),
        IOVE("from"),    IOVE(src),
        IOVE("fspath"),  IOVE(dst),
    };
    return nmount(iov, sizeof(iov) / sizeof(iov[0]), 0);
}

// ──────────────────────────────────────────────────────────────────────
//  enumerate top-level subdirs of a mod (parts/, chr/, msg/, sfx/, action/, …)
//  and unionfs each over the corresponding sandbox <app0>/<subdir>
// ──────────────────────────────────────────────────────────────────────

static int apply_one_mod(
    const char *mod_root,
    const char *sandbox_app0,
    int *mounts_out
) {
    llog("    opendir(%s)", mod_root);
    DIR *d = opendir(mod_root);
    if (!d) {
        llog("    open failed: %s", strerror(errno));
        return -1;
    }
    llog("    opendir ok, iterating");
    int n = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.') continue;
        llog("    > entry: %s", e->d_name);
        char src[MAX_PATH], dst[MAX_PATH];
        snprintf(src, sizeof(src), "%s/%s", mod_root, e->d_name);
        snprintf(dst, sizeof(dst), "%s/%s", sandbox_app0, e->d_name);
        llog("    > src=%s", src);
        llog("    > dst=%s", dst);

        struct stat sst;
        if (stat(src, &sst) != 0 || !S_ISDIR(sst.st_mode)) {
            llog("      skip non-dir (stat errno=%d): %s", errno, e->d_name);
            continue;
        }
        // v3.2.34: don't stat(dst) — same EACCES problem as resolve_sandbox_app0.
        // The BC sandbox refuses userspace stat() on a path nmount() will
        // happily traverse. Let nmount tell us if the dst doesn't exist.
        llog("      calling union_overlay …");
        int rc = union_overlay(src, dst);
        int saved_errno = errno;
        if (rc == 0) {
            llog("      ✓ unionfs %s -> %s", e->d_name, dst);
            n++;
        } else {
            llog("      ✗ unionfs %s -> %s: rc=%d errno=%d (%s)", e->d_name, dst, rc, saved_errno, strerror(saved_errno));
        }
    }
    closedir(d);
    *mounts_out = n;
    return 0;
}

// Walk /data/xeno_mods/CUSA*/ and find the first one whose title_id has a
// matching running process. v3.2.29 hardcoded CUSA18000 (PS4 NA Elden Ring)
// which silently no-op'd for everyone on the PS4 EU disc (CUSA18581), PS5
// native ER (CUSA20850), and any other regional release. With auto-detect,
// the user just stages mods under whichever CUSA folder they want and Apply
// Mods Now picks the right one as long as the game is running.
static int auto_discover_target(char *out_title, size_t outsz, pid_t *out_pid) {
    DIR *d = opendir("/data/xeno_mods");
    if (!d) { llog("opendir /data/xeno_mods: %s", strerror(errno)); return -1; }
    struct dirent *e;
    int candidates = 0;
    while ((e = readdir(d)) != NULL) {
        if (strncmp(e->d_name, "CUSA", 4) != 0) continue;
        if (strlen(e->d_name) < 9) continue;
        candidates++;
        pid_t pid = find_game_pid(e->d_name);
        if (pid >= 0) {
            snprintf(out_title, outsz, "%s", e->d_name);
            *out_pid = pid;
            closedir(d);
            return 0;
        }
        llog("  - %s staged but no running process", e->d_name);
    }
    closedir(d);
    if (candidates == 0) {
        llog("no CUSA* subdirs under /data/xeno_mods — stage at least one mod first.");
    } else {
        llog("none of the %d staged title(s) are running. Launch the game and re-apply.", candidates);
    }
    return -1;
}

int main(int argc, char *argv[]) {
    (void)argc; (void)argv;

    log_open();
    llog("xenoking-mount-once · build %s %s", __DATE__, __TIME__);
    // Inject confirmation — user sees this in the PS5 corner the moment
    // they hit NetCat-GUI's Inject button. No more "did it even work?".
    ps5_notify("⚔ XENO TOOL · mod loader injected\nscanning /data/xeno_mods …");

    // ucred elevation. v3.2.35 reached `calling union_overlay …` and the
    // kernel SIGKILL'd us before nmount could return — etaHEN's payload
    // runner gives us exec but not PRIV_VFS_MOUNT_NONUSER, which is what
    // nmount onto /mnt/sandbox needs. Escalate via the SDK's ucred API
    // (kernel-RW context auto-inits on first call; no explicit init).
    pid_t my_pid = getpid();
    uint64_t before_authid = kernel_get_ucred_authid(my_pid);
    // Compiler error history pinned the real signatures:
    //   set_ucred_authid(pid, uint64_t)        — value, not pointer
    //   set_ucred_caps(pid, const uint8_t *)   — pointer to 32-byte caps
    //                                            buffer (4× u64 = the
    //                                            full FreeBSD priv vector)
    int auth_rc = kernel_set_ucred_authid(my_pid, ROOT_AUTHID);
    uint64_t all_caps[4] = {
        0xFFFFFFFFFFFFFFFFULL,
        0xFFFFFFFFFFFFFFFFULL,
        0xFFFFFFFFFFFFFFFFULL,
        0xFFFFFFFFFFFFFFFFULL,
    };
    int caps_rc = kernel_set_ucred_caps(my_pid, (const uint8_t *)all_caps);
    uint64_t after_authid = kernel_get_ucred_authid(my_pid);
    llog("ucred authid: 0x%llx -> 0x%llx (set_authid rc=%d set_caps rc=%d)",
         (unsigned long long)before_authid, (unsigned long long)after_authid,
         auth_rc, caps_rc);
    if (after_authid != ROOT_AUTHID) {
        ps5_notify("⚠ XENO TOOL · ucred elevation failed\nauthid stayed 0x%llx — is kstuff-lite ≥1.07 loaded?", (unsigned long long)after_authid);
        // Continue anyway — the mount may still work if etaHEN already
        // elevated us via another mechanism.
    } else {
        llog("✓ root-debugger ucred + all caps acquired");
    }

    // Jail escape. v3.2.36 had root authid + all caps but nmount STILL
    // SIGKILL'd onto /mnt/sandbox/CUSA18723_000/app0/parts/. That's because
    // FreeBSD's mount permission check also walks the calling thread's
    // cr_prison and the proc's rootdir/jaildir vnodes — a jailed process
    // can mount onto ITS own paths but not onto another sandbox's. Copy
    // init's prison (= prison0, the un-jailed root) onto our ucred and
    // point our rootdir/jaildir at the kernel's root vnode.
    uint64_t prison0 = kernel_get_ucred_prison(1);   // init is always in prison0
    uint64_t root_vnode = kernel_get_root_vnode();
    int prison_rc = kernel_set_ucred_prison(my_pid, prison0);
    int rootdir_rc = kernel_set_proc_rootdir(my_pid, root_vnode);
    int jaildir_rc = kernel_set_proc_jaildir(my_pid, root_vnode);
    llog("jail escape: prison0=0x%llx root_vnode=0x%llx (set_prison rc=%d rootdir rc=%d jaildir rc=%d)",
         (unsigned long long)prison0, (unsigned long long)root_vnode,
         prison_rc, rootdir_rc, jaildir_rc);
    if (prison_rc == 0 && rootdir_rc == 0 && jaildir_rc == 0) {
        llog("✓ jail escaped — can mount onto any sandbox");
    } else {
        ps5_notify("⚠ XENO TOOL · jail escape failed\nprison rc=%d rootdir rc=%d", prison_rc, rootdir_rc);
    }

    // Auto-detect the running ER title id from whichever CUSA folder is
    // staged AND has a matching running process.
    char title_id[16];
    pid_t pid = -1;
    if (auto_discover_target(title_id, sizeof(title_id), &pid) != 0) {
        ps5_notify("⚠ XENO TOOL · no staged game is running\nlaunch ER first, then re-inject");
        log_close();
        return 2;
    }
    llog("matched %s pid=%d", title_id, pid);
    llog("entering resolve_sandbox_app0(%s)", title_id);
    ps5_notify("⚔ XENO TOOL · matched %s\nresolving sandbox …", title_id);

    char sbx_app0[MAX_PATH];
    if (resolve_sandbox_app0(title_id, sbx_app0, sizeof(sbx_app0)) != 0) {
        llog("could not resolve sandbox /app0 — bailing.");
        ps5_notify("⚠ XENO TOOL · couldn't find /app0\nbring ER to the foreground and re-inject");
        log_close();
        return 3;
    }
    llog("sandbox app0: %s", sbx_app0);

    char state_path[MAX_PATH];
    snprintf(state_path, sizeof(state_path), STATE_FMT, title_id);
    char state_title[16];
    char active[MAX_MODS][MAX_ID];
    int n_active = 0;
    if (parse_state(state_path, state_title, active, &n_active) != 0) {
        llog("no/invalid state.json at %s — bailing.", state_path);
        ps5_notify("⚠ XENO TOOL · no state.json for %s\nstage a mod from XENO TOOL first", title_id);
        log_close();
        return 4;
    }
    llog("state: title=%s active=%d", state_title, n_active);
    if (n_active == 0) {
        llog("no active mods — nothing to do.");
        ps5_notify("⚠ XENO TOOL · no mods enabled\ntoggle Enable on a mod in My Mods");
        log_close();
        return 0;
    }

    int total_mounts = 0;
    int total_mods = 0;
    for (int i = 0; i < n_active; i++) {
        char mod_root[MAX_PATH];
        snprintf(mod_root, sizeof(mod_root), MOD_ROOT_FMT, title_id, active[i]);
        struct stat st;
        if (stat(mod_root, &st) != 0 || !S_ISDIR(st.st_mode)) {
            llog("- mod %s: not staged at %s (skip)", active[i], mod_root);
            continue;
        }
        llog("- mod %s:", active[i]);
        int n = 0;
        apply_one_mod(mod_root, sbx_app0, &n);
        total_mounts += n;
        total_mods++;
    }
    llog("done · %d mod(s) · %d unionfs mount(s) live until %s exits.", total_mods, total_mounts, title_id);
    if (total_mounts > 0) {
        // Hero notification — the one we actually want users to see.
        ps5_notify(
            "✅ XENO TOOL · %d mod%s live on %s\n%d overlay%s mounted · equip them in inventory · stays until you quit the game",
            total_mods, total_mods == 1 ? "" : "s",
            title_id,
            total_mounts, total_mounts == 1 ? "" : "s"
        );
    } else {
        ps5_notify(
            "⚠ XENO TOOL · 0 overlays mounted on %s\n%d mod(s) tried but every mount errored — check /data/xeno_mods/mount-once.log",
            title_id, total_mods
        );
    }
    log_close();
    return total_mounts > 0 ? 0 : 5;
}
