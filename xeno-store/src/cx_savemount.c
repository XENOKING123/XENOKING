/*
 * cx_savemount.c — see cx_savemount.h.
 *
 * Native tier ABI: the SceSaveData structs below follow the public PS4
 * layout that the PS5 Apollo / Save-Mounter family uses unchanged (title id
 * 10+6, dir name 32, fingerprint 65+15, mount point 16). Every Sony return
 * code is logged; any failure unmounts and reports instead of guessing.
 */
#include "cx_savemount.h"
#include "cx_accounts.h"
#include "cx_common.h"
#include "log.h"
#include "settings.h"
#include "storage.h"
#include "util.h"
#include "zip.h"

#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define GARLIC_PORT_DEFAULT 8082
#define SAVE_MAX_BYTES (4LL << 30)
#define SAVE_MAX_ENTRIES 4096

/* ---- native tier (PS5) -------------------------------------------------- */
#ifndef XENO_HOST
#include <dlfcn.h>

typedef struct { char data[32]; } SceSaveDataDirName;
typedef struct { char data[10]; char padding[6]; } SceSaveDataTitleId;
typedef struct { char data[65]; char padding[15]; } SceSaveDataFingerprint;
typedef struct { char data[16]; } SceSaveDataMountPoint;
typedef struct {
  SceSaveDataMountPoint mountPoint;
  uint64_t requiredBlocks;
  uint32_t mountStatus;
  uint8_t reserved[28];
  int32_t pad;
} SceSaveDataMountResult;
typedef struct {
  int32_t userId;
  int32_t pad0;
  const SceSaveDataDirName *dirName;
  uint64_t blocks;
  uint32_t mountMode;
  uint8_t reserved[32];
  int32_t pad1;
} SceSaveDataMount2;
typedef struct {
  int32_t userId;
  int32_t pad0;
  const SceSaveDataTitleId *titleId;
  const SceSaveDataDirName *dirName;
  uint8_t reserved[32];
  int32_t pad1;
} SceSaveDataDelete;

#define SCE_SAVE_DATA_MOUNT_MODE_RDONLY 1
#define SCE_SAVE_DATA_MOUNT_MODE_RDWR 2
#define SCE_SAVE_DATA_MOUNT_MODE_CREATE 4
#define SCE_SAVE_DATA_MOUNT_MODE_DESTRUCT_OFF 8
#define SCE_SAVE_DATA_MOUNT_MODE_CREATE2 32
#define SCE_SAVE_DATA_BLOCKS_DEFAULT 32768   /* 32 MiB-ish at 32 KiB blocks */

typedef int (*sd_init3_fn)(void *);
typedef int (*sd_tmount_fn)(int userId, const SceSaveDataTitleId *, const SceSaveDataDirName *, const SceSaveDataFingerprint *, SceSaveDataMountResult *);
typedef int (*sd_mount2_fn)(const SceSaveDataMount2 *, SceSaveDataMountResult *);
typedef int (*sd_umount_fn)(const SceSaveDataMountPoint *);
typedef int (*sd_delete_fn)(const SceSaveDataDelete *);
typedef int (*sd_getparam_fn)(const SceSaveDataMountPoint *, uint32_t type, void *buf, size_t size, size_t *got);
typedef int (*sd_setparam_fn)(const SceSaveDataMountPoint *, uint32_t type, const void *buf, size_t size);

static struct {
  int resolved, available;
  sd_init3_fn init3;
  sd_tmount_fn tmount;
  sd_mount2_fn mount2;
  sd_umount_fn umount;
  sd_delete_fn del;
  sd_getparam_fn getparam;
  sd_setparam_fn setparam;
  char missing[160];
} sd;
static pthread_mutex_t sd_mu = PTHREAD_MUTEX_INITIALIZER;

static void *sd_sym(void *lib, const char *name, int required) {
  void *p = lib ? dlsym(lib, name) : NULL;
  if (!p) p = dlsym(RTLD_DEFAULT, name);
  if (!p && required) {
    if (sd.missing[0]) xstrlcat(sd.missing, ", ", sizeof sd.missing);
    xstrlcat(sd.missing, name, sizeof sd.missing);
  }
  return p;
}

static void sd_resolve(void) {
  pthread_mutex_lock(&sd_mu);
  if (!sd.resolved) {
    sd.resolved = 1;
    void *lib = NULL;
    const char *const dirs[] = {"", "/system/common/lib/", "/system_ex/common/lib/"};
    for (size_t i = 0; i < XS_ARRAY_LEN(dirs) && !lib; i++) {
      char path[128];
      xsnprintf(path, sizeof path, "%slibSceSaveData.sprx", dirs[i]);
      lib = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    }
    if (!lib) LOGW("saves: libSceSaveData.sprx did not load (%s)", dlerror() ? dlerror() : "unknown");
    sd.init3 = (sd_init3_fn)sd_sym(lib, "sceSaveDataInitialize3", 1);
    sd.tmount = (sd_tmount_fn)sd_sym(lib, "sceSaveDataTransferringMount", 1);
    sd.mount2 = (sd_mount2_fn)sd_sym(lib, "sceSaveDataMount2", 1);
    sd.umount = (sd_umount_fn)sd_sym(lib, "sceSaveDataUmount", 1);
    sd.del = (sd_delete_fn)sd_sym(lib, "sceSaveDataDelete", 1);
    sd.getparam = (sd_getparam_fn)sd_sym(lib, "sceSaveDataGetParam", 0);
    sd.setparam = (sd_setparam_fn)sd_sym(lib, "sceSaveDataSetParam", 0);
    sd.available = sd.init3 && sd.tmount && sd.mount2 && sd.umount && sd.del;
    if (sd.available) {
      int rc = sd.init3(NULL);
      LOGI("saves: sceSaveDataInitialize3 -> 0x%08x", (unsigned)rc);
      if (rc != 0) { sd.available = 0; xsnprintf(sd.missing, sizeof sd.missing, "sceSaveDataInitialize3 failed 0x%08x", (unsigned)rc); }
    } else LOGW("saves: native engine unavailable, missing %s", sd.missing);
  }
  pthread_mutex_unlock(&sd_mu);
}

static int native_available(char *detail, size_t cap) {
  sd_resolve();
  if (detail) xstrlcpy(detail, sd.available ? "libSceSaveData resolved" : sd.missing, cap);
  return sd.available;
}

static int native_mount(cx_mount *m, char *err, size_t errcap) {
  sd_resolve();
  if (!sd.available) { xsnprintf(err, errcap, "native engine unavailable (%s)", sd.missing); return -1; }
  SceSaveDataTitleId tid;
  SceSaveDataDirName dn;
  SceSaveDataFingerprint fp;
  SceSaveDataMountResult res;
  memset(&tid, 0, sizeof tid); memset(&dn, 0, sizeof dn); memset(&fp, 0, sizeof fp); memset(&res, 0, sizeof res);
  xstrlcpy(tid.data, m->titleId, sizeof tid.data);
  xstrlcpy(dn.data, m->dirName, sizeof dn.data);
  int rc;
  if (m->rdwr) {
    SceSaveDataMount2 mt;
    memset(&mt, 0, sizeof mt);
    mt.userId = (int32_t)m->uid;
    mt.dirName = &dn;
    mt.blocks = SCE_SAVE_DATA_BLOCKS_DEFAULT;
    mt.mountMode = SCE_SAVE_DATA_MOUNT_MODE_RDWR | SCE_SAVE_DATA_MOUNT_MODE_CREATE2;
    rc = sd.mount2(&mt, &res);
    LOGI("saves: sceSaveDataMount2(%s/%s rdwr|create2) -> 0x%08x", m->titleId, m->dirName, (unsigned)rc);
  } else {
    rc = sd.tmount((int)m->uid, &tid, &dn, &fp, &res);
    LOGI("saves: sceSaveDataTransferringMount(%s/%s) -> 0x%08x", m->titleId, m->dirName, (unsigned)rc);
  }
  if (rc != 0) { xsnprintf(err, errcap, "save mount failed (0x%08x) — are the save patches (kstuff) loaded?", (unsigned)rc); return -1; }
  xstrlcpy(m->native_point, res.mountPoint.data, sizeof m->native_point);
  xstrlcpy(m->point, res.mountPoint.data, sizeof m->point);
  m->created = (res.mountStatus & 1) != 0;
  return 0;
}

static int native_umount(cx_mount *m) {
  SceSaveDataMountPoint mp;
  memset(&mp, 0, sizeof mp);
  xstrlcpy(mp.data, m->native_point, sizeof mp.data);
  int rc = sd.umount(&mp);
  LOGI("saves: sceSaveDataUmount(%s) -> 0x%08x", mp.data, (unsigned)rc);
  return rc == 0 ? 0 : -1;
}

static void native_set_params(cx_mount *m, const char *title, const char *subtitle, const char *detail) {
  if (!sd.setparam) return;
  SceSaveDataMountPoint mp;
  memset(&mp, 0, sizeof mp);
  xstrlcpy(mp.data, m->native_point, sizeof mp.data);
  if (title && *title) { int rc = sd.setparam(&mp, 1, title, strlen(title) + 1); LOGD("saves: SetParam(title) -> 0x%08x", (unsigned)rc); }
  if (subtitle && *subtitle) { int rc = sd.setparam(&mp, 2, subtitle, strlen(subtitle) + 1); LOGD("saves: SetParam(subtitle) -> 0x%08x", (unsigned)rc); }
  if (detail && *detail) { int rc = sd.setparam(&mp, 3, detail, strlen(detail) + 1); LOGD("saves: SetParam(detail) -> 0x%08x", (unsigned)rc); }
}
#else
static int native_available(char *detail, size_t cap) {
  if (detail) xstrlcpy(detail, "host simulation (temp-dir mounts)", cap);
  return 1;
}
#endif

/* ---- garlic tier -------------------------------------------------------- */

static int garlic_port(void) { return cx_local_port("GARLIC", GARLIC_PORT_DEFAULT); }
static int garlic_available(void) { return cx_tcp_probe(garlic_port(), 300); }

/* Garlic Save Manager local API (ELF Arsenal worker): JSON POST with the
 * zip path; a 2xx answer with ok/success is a confirmed import. */
static int garlic_import(uint32_t uid, const char *titleId, const char *zipPath, char *err, size_t errcap) {
  char url[96];
  xsnprintf(url, sizeof url, "http://127.0.0.1:%d/api/import", garlic_port());
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_str(&w, "path", zipPath);
  jw_kv_str(&w, "titleId", titleId);
  jw_kv_i64(&w, "userId", uid);
  jw_kv_bool(&w, "resign", 1);
  jw_obj_end(&w);
  size_t bl;
  char *body = jw_detach(&w, &bl);
  if (!body) { xsnprintf(err, errcap, "out of memory"); return -1; }
  cx_http o = {0};
  o.method = "POST";
  o.headers = "Content-Type: application/json\r\n";
  o.body = body;
  o.body_len = bl;
  o.timeout_ms = 120000;
  int status = 0;
  size_t len = 0;
  char *resp = cx_fetch(url, &o, &status, &len, NULL);
  free(body);
  int ok = 0;
  if (resp && status >= 200 && status < 300) {
    jdoc *d = json_parse(resp, len, 1000, 8);
    ok = 1;
    if (d) { ok = jv_get_bool(json_root(d), "ok", jv_get_bool(json_root(d), "success", 1)); if (!ok) xsnprintf(err, errcap, "Garlic refused: %s", jv_get_str(json_root(d), "error", jv_get_str(json_root(d), "message", "unknown"))); json_free(d); }
  } else xsnprintf(err, errcap, "Garlic answered HTTP %d", status);
  free(resp);
  return ok ? 0 : -1;
}

/* ---- tier selection ----------------------------------------------------- */

void cx_savemount_init(void) {
  char d[160];
  int n = native_available(d, sizeof d);
  LOGI("saves: engine tier %s (%s)", cx_tier_name(cx_savemount_tier()), n ? d : d);
}

int cx_savemount_tier(void) {
  if (native_available(NULL, 0)) return CX_TIER_NATIVE;
  if (garlic_available()) return CX_TIER_GARLIC;
  return CX_TIER_RAW;
}

const char *cx_tier_name(int tier) { return tier == CX_TIER_NATIVE ? "native" : tier == CX_TIER_GARLIC ? "garlic" : "raw"; }

void cx_savemount_engine_json(jw *w) {
  char nd[160];
  int native = native_available(nd, sizeof nd);
  int garlic = garlic_available();
  int tier = native ? CX_TIER_NATIVE : garlic ? CX_TIER_GARLIC : CX_TIER_RAW;
  jw_kv_str(w, "tier", cx_tier_name(tier));
  const char *detail = tier == CX_TIER_NATIVE ? (cx_is_host() ? "Host simulation of the PS5 SaveData mount (temp directories)."
                                                              : "PS5 SaveData mount API (needs save patches such as kstuff): community saves are re-signed for this console.")
                       : tier == CX_TIER_GARLIC ? "Garlic Save Manager is running on this console: imports go through its re-sign API."
                       : "Raw copy only: restores and transfers work for saves made on this console. Community saves need the native engine (save patches) or Garlic Save Manager.";
  jw_kv_str(w, "detail", detail);
  jw_key(w, "native"); jw_obj_begin(w); jw_kv_bool(w, "available", native); jw_kv_str(w, "detail", nd); jw_obj_end(w);
  jw_key(w, "garlic"); jw_obj_begin(w); jw_kv_bool(w, "available", garlic); jw_kv_int(w, "port", garlic_port()); jw_obj_end(w);
  jw_key(w, "raw"); jw_obj_begin(w); jw_kv_bool(w, "available", 1); jw_kv_str(w, "detail", "Same console only"); jw_obj_end(w);
  jw_kv_bool(w, "simulated", cx_is_host());
}

/* ---- paths -------------------------------------------------------------- */

int cx_save_title_dir(uint32_t uid, const char *titleId, const char *kind, char *out, size_t cap, char *kind_out, size_t kcap) {
  char home[700];
  if (!cx_titleid_valid(titleId)) return -1;
  if (cx_user_home(uid, home, sizeof home) != 0) return -1;
  const char *k = kind && *kind ? kind : (titleId[0] == 'P' ? "ps5" : "ps4");
  if (strcmp(k, "ps5") != 0 && strcmp(k, "ps4") != 0) return -1;
  xsnprintf(out, cap, "%s/%s/%s", home, strcmp(k, "ps5") == 0 ? "savedata_prospero" : "savedata", titleId);
  if (kind_out) xstrlcpy(kind_out, k, kcap);
  return 0;
}

/* ---- param.sfo ---------------------------------------------------------- */

static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

/* Finds an entry; returns the data offset/len (0 when absent). */
static int sfo_find(const uint8_t *buf, size_t len, const char *key, uint32_t *doff, uint32_t *dlen, uint32_t *dmax, uint16_t *fmt) {
  if (len < 20 || memcmp(buf, "\0PSF", 4) != 0) return -1;
  uint32_t key_start = rd32(buf + 8), data_start = rd32(buf + 12), n = rd32(buf + 16);
  if (n > 512 || key_start > len || data_start > len) return -1;
  for (uint32_t i = 0; i < n; i++) {
    size_t e = 20 + (size_t)i * 16;
    if (e + 16 > len) return -1;
    uint16_t koff = rd16(buf + e), f = rd16(buf + e + 2);
    uint32_t l = rd32(buf + e + 4), mx = rd32(buf + e + 8), off = rd32(buf + e + 12);
    size_t kpos = (size_t)key_start + koff;
    if (kpos >= len) return -1;
    size_t klen = strnlen((const char *)buf + kpos, len - kpos);
    if (klen == strlen(key) && memcmp(buf + kpos, key, klen) == 0) {
      if ((size_t)data_start + off + mx > len) return -1;
      *doff = data_start + off; *dlen = l; *dmax = mx; *fmt = f;
      return 0;
    }
  }
  return -1;
}

int cx_sfo_set_account_id(uint8_t *buf, size_t len, uint64_t id) {
  uint32_t off, l, mx;
  uint16_t fmt;
  if (sfo_find(buf, len, "ACCOUNT_ID", &off, &l, &mx, &fmt) != 0) return -1;
  memset(buf + off, 0, mx);
  if (fmt == 0x0204) {               /* utf-8 string: hex id */
    char hex[20];
    xsnprintf(hex, sizeof hex, "%016llx", (unsigned long long)id);
    size_t n = strlen(hex);
    if (n + 1 > mx) n = mx > 0 ? mx - 1 : 0;
    memcpy(buf + off, hex, n);
  } else {                            /* binary / int: little-endian 8 bytes */
    for (int i = 0; i < 8 && (uint32_t)i < mx; i++) buf[off + i] = (uint8_t)(id >> (8 * i));
  }
  return 0;
}

int cx_sfo_get_str(const uint8_t *buf, size_t len, const char *key, char *out, size_t cap) {
  uint32_t off, l, mx;
  uint16_t fmt;
  out[0] = 0;
  if (sfo_find(buf, len, key, &off, &l, &mx, &fmt) != 0) return -1;
  if (fmt == 0x0404) { xsnprintf(out, cap, "%u", rd32(buf + off)); return 0; }
  size_t n = strnlen((const char *)buf + off, mx);
  if (n >= cap) n = cap - 1;
  memcpy(out, buf + off, n);
  out[n] = 0;
  return 0;
}

/* ---- mount / unmount ---------------------------------------------------- */

#ifdef XENO_HOST
static void sim_store_dir(const cx_mount *m, char *out, size_t cap) { xsnprintf(out, cap, "%s/.sim/%s", m->title_dir, m->dirName); }
#endif

int cx_savemount_open(uint32_t uid, const char *titleId, const char *dirName, int rdwr, cx_mount *m, char *err, size_t errcap) {
  memset(m, 0, sizeof *m);
  if (!cx_titleid_valid(titleId)) { xsnprintf(err, errcap, "invalid title id"); return -1; }
  if (!cx_dirname_valid(dirName)) { xsnprintf(err, errcap, "invalid save directory name"); return -1; }
  if (cx_user_find(uid, NULL) != 0) { xsnprintf(err, errcap, "unknown user"); return -1; }
  m->uid = uid;
  m->rdwr = rdwr;
  xstrlcpy(m->titleId, titleId, sizeof m->titleId);
  xstrlcpy(m->dirName, dirName, sizeof m->dirName);
  char kind[8];
  if (cx_save_title_dir(uid, titleId, "", m->title_dir, sizeof m->title_dir, kind, sizeof kind) != 0) { xsnprintf(err, errcap, "user home not found"); return -1; }
#ifdef XENO_HOST
  m->tier = CX_TIER_NATIVE;
  char store[1024], rnd[12];
  sim_store_dir(m, store, sizeof store);
  util_rand_hex(rnd, 8);
  xsnprintf(m->point, sizeof m->point, "%s/sim/savemount/%s-%s-%s", cx_data_dir(), titleId, dirName, rnd);
  if (util_mkdir_p(m->point) != 0) { xsnprintf(err, errcap, "cannot create mount directory"); return -1; }
  if (util_dir_exists(store)) { int64_t b = 0; if (cx_copy_tree(store, m->point, 8, &b) != 0) { xsnprintf(err, errcap, "cannot mirror the save"); return -1; } }
  else if (!rdwr) { cx_rm_rf(m->point, 4); xsnprintf(err, errcap, "save %s/%s not found", titleId, dirName); return -1; }
  else m->created = 1;
  return 0;
#else
  m->tier = CX_TIER_NATIVE;
  return native_mount(m, err, errcap);
#endif
}

int cx_savemount_close(cx_mount *m, int commit) {
  if (!m->point[0]) return 0;
#ifdef XENO_HOST
  int rc = 0;
  if (commit) {
    char store[1024];
    sim_store_dir(m, store, sizeof store);
    cx_rm_rf(store, 8);
    util_mkdir_p(m->title_dir);
    int64_t b = 0;
    if (cx_copy_tree(m->point, store, 8, &b) != 0) rc = -1;
    /* raw-side image marker + sce_sys copy so the hub lists the save */
    char img[1200], sys_dir[1200];
    xsnprintf(img, sizeof img, "%s/sdimg_%s", m->title_dir, m->dirName);
    char marker[96];
    xsnprintf(marker, sizeof marker, "XENO-SIM-IMAGE %lld\n", (long long)b);
    util_write_file_atomic(img, marker, strlen(marker));
    xsnprintf(sys_dir, sizeof sys_dir, "%s/sce_sys/%s", m->title_dir, m->dirName);
    util_mkdir_p(sys_dir);
    char sfo_src[1200], sfo_dst[1300];
    xsnprintf(sfo_src, sizeof sfo_src, "%s/sce_sys/param.sfo", m->point);
    xsnprintf(sfo_dst, sizeof sfo_dst, "%s/param.sfo", sys_dir);
    if (util_file_exists(sfo_src)) cx_copy_file(sfo_src, sfo_dst);
  }
  cx_rm_rf(m->point, 8);
  m->point[0] = 0;
  return rc;
#else
  (void)commit;
  int rc = native_umount(m);
  m->point[0] = 0;
  return rc;
#endif
}

/* ---- import ------------------------------------------------------------- */

static int zip_style(const char *zipPath, char *dirName, size_t dcap, int *entries, char *err, size_t errcap) {
  zip_entry_info *list = calloc(SAVE_MAX_ENTRIES, sizeof *list);
  if (!list) { xsnprintf(err, errcap, "out of memory"); return -1; }
  zip_stats st;
  int n = zip_list(zipPath, list, SAVE_MAX_ENTRIES, &st);
  if (n < 0) { xsnprintf(err, errcap, "cannot read zip: %s", st.error); free(list); return -1; }
  int raw = 0, decrypted = 0;
  for (int i = 0; i < n; i++) {
    const char *nm = list[i].name;
    if (util_starts_with(nm, "sdimg_") || strstr(nm, "/sdimg_")) { raw = 1; if (!dirName[0]) { const char *p = strstr(nm, "sdimg_"); xstrlcpy(dirName, p + 6, dcap); char *s = strchr(dirName, '/'); if (s) *s = 0; } }
    else if (strcmp(nm, "xeno-backup.json") == 0) raw = 1;
    else if (!list[i].is_dir && !util_starts_with(nm, "sce_sys/") && !strchr(nm, '/') && strcmp(nm, "xeno-save.json") != 0) decrypted = 1;
  }
  free(list);
  if (entries) *entries = n;
  if (n == 0) { xsnprintf(err, errcap, "the zip is empty"); return -1; }
  return raw ? 1 : (decrypted || n > 0 ? 0 : -1);
}

static int do_pre_backup(uint32_t uid, const char *title_dir, const char *titleId, const char *kind, const char *backup_dir, char *out, size_t cap) {
  out[0] = 0;
  if (!util_dir_exists(title_dir) || cx_count_files(title_dir, 8) == 0) return 0;
  cx_user u;
  if (cx_user_find(uid, &u) != 0) return -1;
  char uname[64];
  if (storage_sanitize_filename(u.name, uname, sizeof uname) != 0) xsnprintf(uname, sizeof uname, "user-%x", (unsigned)uid);
  char dir[1100], stamp[24];
  xsnprintf(dir, sizeof dir, "%s/%s", backup_dir, uname);
  if (util_mkdir_p(dir) != 0) return -1;
  cx_stamp(stamp, sizeof stamp);
  xsnprintf(out, cap, "%s/%s_%s_%s.pre-restore.zip", dir, titleId, kind, stamp);
  zip_stats st;
  if (zip_create_from_dir(out, title_dir, NULL, NULL, &st) != 0) { LOGW("saves: pre-backup failed: %s", st.error); out[0] = 0; return -1; }
  LOGI("saves: pre-backup %s", out);
  return 0;
}

int cx_savemount_import_zip(uint32_t uid, const char *titleId, const char *dirName, const char *zipPath,
                            int backup_first, const char *backup_dir, cx_import_result *out,
                            char *code, size_t ccap, char *err, size_t errcap) {
  memset(out, 0, sizeof *out);
  xstrlcpy(code, "import_failed", ccap);
  char title_dir[1024], kind[8];
  if (!cx_titleid_valid(titleId)) { xstrlcpy(code, "bad_request", ccap); xsnprintf(err, errcap, "invalid title id"); return -1; }
  if (cx_save_title_dir(uid, titleId, "", title_dir, sizeof title_dir, kind, sizeof kind) != 0) { xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "user home not found"); return -1; }
  char dn[32] = "";
  if (dirName && *dirName) xstrlcpy(dn, dirName, sizeof dn);
  /* manifest (xeno-save.json) may name the dir */
  void *mf = NULL;
  size_t mflen = 0;
  if (zip_extract_to_memory(zipPath, "xeno-save.json", &mf, &mflen, 64 << 10) == 0) {
    jdoc *d = json_parse(mf, mflen, 2000, 8);
    if (d) {
      const char *mt = jv_get_str(json_root(d), "titleId", "");
      if (*mt && strcmp(mt, titleId) != 0) { json_free(d); free(mf); xstrlcpy(code, "title_mismatch", ccap); xsnprintf(err, errcap, "this save is for %s, not %s", mt, titleId); return -1; }
      if (!dn[0]) xstrlcpy(dn, jv_get_str(json_root(d), "dirName", ""), sizeof dn);
      json_free(d);
    }
    free(mf);
  }
  int entries = 0;
  int style = zip_style(zipPath, dn, sizeof dn, &entries, err, errcap);
  if (style < 0) return -1;
  xstrlcpy(out->style, style == 1 ? "raw" : "decrypted", sizeof out->style);
  if (backup_first && do_pre_backup(uid, title_dir, titleId, kind, backup_dir, out->preBackup, sizeof out->preBackup) != 0) {
    xsnprintf(err, errcap, "could not back up the current save first — nothing was changed");
    return -1;
  }
  if (style == 1) {
    /* raw backup made on this console: restore the title folder as-is */
    xstrlcpy(out->tier, "raw", sizeof out->tier);
    char tmp[1100];
    xsnprintf(tmp, sizeof tmp, "%s.restore-tmp", title_dir);
    cx_rm_rf(tmp, 8);
    zip_stats st;
    if (zip_extract_to_dir(zipPath, tmp, (uint64_t)SAVE_MAX_BYTES, NULL, NULL, &st) != 0) { cx_rm_rf(tmp, 8); xsnprintf(err, errcap, "extract failed: %s", st.error); return -1; }
    char manifest[1200];
    xsnprintf(manifest, sizeof manifest, "%s/xeno-backup.json", tmp);
    util_unlink_quiet(manifest);
    cx_rm_rf(title_dir, 8);
    if (rename(tmp, title_dir) != 0) { xsnprintf(err, errcap, "cannot move the restored save into place: %s", strerror(errno)); return -1; }
    out->files = st.extracted;
    out->bytes = (int64_t)st.bytes;
    return 0;
  }
  if (!dn[0]) xstrlcpy(dn, "SAVEDATA00", sizeof dn);
  int tier = cx_savemount_tier();
  if (tier == CX_TIER_RAW) {
    xstrlcpy(code, "engine_unavailable", ccap);
    xsnprintf(err, errcap, "This save needs the native engine (save patches such as kstuff) or Garlic Save Manager: a decrypted save cannot be copied raw");
    return -1;
  }
  if (tier == CX_TIER_GARLIC) {
    xstrlcpy(out->tier, "garlic", sizeof out->tier);
    if (garlic_import(uid, titleId, zipPath, err, errcap) != 0) return -1;
    out->files = entries;
    return 0;
  }
  xstrlcpy(out->tier, "native", sizeof out->tier);
  char stage[1100];
  xsnprintf(stage, sizeof stage, "%s/sim/stage-%s-%s", cx_data_dir(), titleId, dn);
#ifndef XENO_HOST
  xsnprintf(stage, sizeof stage, "%s/stage/%s-%s", cx_data_dir(), titleId, dn);
#endif
  cx_rm_rf(stage, 8);
  zip_stats st;
  if (zip_extract_to_dir(zipPath, stage, (uint64_t)SAVE_MAX_BYTES, NULL, NULL, &st) != 0) { cx_rm_rf(stage, 8); xsnprintf(err, errcap, "extract failed: %s", st.error); return -1; }
  /* never carry sealed keys / manifests into the mounted save */
  char p[1200];
  xsnprintf(p, sizeof p, "%s/xeno-save.json", stage); util_unlink_quiet(p);
  xsnprintf(p, sizeof p, "%s/sce_sys/sealedkey", stage); util_unlink_quiet(p);
  xsnprintf(p, sizeof p, "%s/sce_sys/keystone", stage); util_unlink_quiet(p);
  /* ACCOUNT_ID → this user's account id (0 when PSN-less and not activated) */
  char acct[20] = "";
  cx_user_account_id(uid, acct, sizeof acct);
  uint64_t aid = acct[0] ? strtoull(acct, NULL, 16) : 0;
  xstrlcpy(out->accountId, acct[0] ? acct : "0", sizeof out->accountId);
  char sfo_path[1200];
  xsnprintf(sfo_path, sizeof sfo_path, "%s/sce_sys/param.sfo", stage);
  char sfo_title[128] = "", sfo_sub[128] = "", sfo_detail[256] = "";
  size_t sl = 0;
  char *sfo = util_read_file(sfo_path, &sl, 1 << 20);
  if (sfo) {
    if (cx_sfo_set_account_id((uint8_t *)sfo, sl, aid) == 0) util_write_file_atomic(sfo_path, sfo, sl);
    cx_sfo_get_str((uint8_t *)sfo, sl, "MAINTITLE", sfo_title, sizeof sfo_title);
    cx_sfo_get_str((uint8_t *)sfo, sl, "SUBTITLE", sfo_sub, sizeof sfo_sub);
    cx_sfo_get_str((uint8_t *)sfo, sl, "DETAIL", sfo_detail, sizeof sfo_detail);
    free(sfo);
  }
  cx_mount m;
  if (cx_savemount_open(uid, titleId, dn, 1, &m, err, errcap) != 0) { cx_rm_rf(stage, 8); return -1; }
  /* replace the mounted content with the staged files (sce_sys handled by the system on PS5) */
  int64_t bytes = 0;
  int rc = 0;
  DIR *d = opendir(m.point);
  if (d) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0 || strcmp(e->d_name, "sce_sys") == 0) continue;
      char q[1200];
      xsnprintf(q, sizeof q, "%s/%s", m.point, e->d_name);
      cx_rm_rf(q, 8);
    }
    closedir(d);
  }
  d = opendir(stage);
  if (!d) rc = -1;
  else {
    struct dirent *e;
    while (rc == 0 && (e = readdir(d)) != NULL) {
      if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
      char src[1200], dst[1200];
      xsnprintf(src, sizeof src, "%s/%s", stage, e->d_name);
      xsnprintf(dst, sizeof dst, "%s/%s", m.point, e->d_name);
      struct stat sb;
      if (lstat(src, &sb) != 0) continue;
      if (S_ISDIR(sb.st_mode)) {
        if (strcmp(e->d_name, "sce_sys") == 0 && !cx_is_host()) continue;   /* PS5: managed by the save system */
        if (cx_copy_tree(src, dst, 8, &bytes) != 0) rc = -1;
      } else if (S_ISREG(sb.st_mode)) {
        if (cx_copy_file(src, dst) != 0) rc = -1; else { bytes += (int64_t)sb.st_size; out->files++; }
      }
    }
    closedir(d);
  }
#ifndef XENO_HOST
  if (rc == 0) native_set_params(&m, sfo_title, sfo_sub, sfo_detail);
#else
  (void)sfo_title; (void)sfo_sub; (void)sfo_detail;
#endif
  if (rc != 0) xsnprintf(err, errcap, "copying files into the mounted save failed");
  if (cx_savemount_close(&m, rc == 0) != 0 && rc == 0) { rc = -1; xsnprintf(err, errcap, "unmount failed — the save may be incomplete"); }
  cx_rm_rf(stage, 8);
  out->bytes = bytes;
  return rc;
}

/* ---- export ------------------------------------------------------------- */

static int hash_tree(const char *root, const char *rel, jw *w, int depth, int *files) {
  if (depth > 8) return 0;
  char dir[1100];
  if (rel[0]) xsnprintf(dir, sizeof dir, "%s/%s", root, rel); else xstrlcpy(dir, root, sizeof dir);
  DIR *d = opendir(dir);
  if (!d) return -1;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char relp[1024], full[1200];
    if (rel[0]) xsnprintf(relp, sizeof relp, "%s/%s", rel, e->d_name); else xstrlcpy(relp, e->d_name, sizeof relp);
    xsnprintf(full, sizeof full, "%s/%s", root, relp);
    struct stat sb;
    if (lstat(full, &sb) != 0) continue;
    if (S_ISDIR(sb.st_mode)) { hash_tree(root, relp, w, depth + 1, files); continue; }
    if (!S_ISREG(sb.st_mode)) continue;
    char hex[65] = "";
    cx_sha256_file(full, hex);
    jw_obj_begin(w);
    jw_kv_str(w, "path", relp);
    jw_kv_i64(w, "size", (int64_t)sb.st_size);
    jw_kv_str(w, "sha256", hex);
    jw_obj_end(w);
    (*files)++;
  }
  closedir(d);
  return 0;
}

int cx_savemount_export(uint32_t uid, const char *titleId, const char *dirName, const char *dest_zip,
                        cx_export_result *out, char *err, size_t errcap) {
  memset(out, 0, sizeof *out);
  char title_dir[1024], kind[8];
  if (cx_save_title_dir(uid, titleId, "", title_dir, sizeof title_dir, kind, sizeof kind) != 0) { xsnprintf(err, errcap, "user home not found"); return -1; }
  if (!util_dir_exists(title_dir)) { xsnprintf(err, errcap, "no save for %s on this profile", titleId); return -1; }
  int tier = cx_savemount_tier();
  char stage[1100];
  xsnprintf(stage, sizeof stage, "%s/%s/export-%s", cx_data_dir(), cx_is_host() ? "sim" : "stage", titleId);
  cx_rm_rf(stage, 8);
  if (util_mkdir_p(stage) != 0) { xsnprintf(err, errcap, "cannot create staging directory"); return -1; }
  int64_t bytes = 0;
  int decrypted = 0;
  if (tier == CX_TIER_NATIVE && dirName && *dirName) {
    cx_mount m;
    if (cx_savemount_open(uid, titleId, dirName, 0, &m, err, errcap) == 0) {
      if (cx_copy_tree(m.point, stage, 8, &bytes) == 0) decrypted = 1;
      cx_savemount_close(&m, 0);
    } else LOGW("saves: native export mount failed (%s), falling back to raw", err);
  }
  if (!decrypted) {
    cx_rm_rf(stage, 8);
    if (cx_copy_tree(title_dir, stage, 8, &bytes) != 0) { xsnprintf(err, errcap, "cannot copy the save folder"); cx_rm_rf(stage, 8); return -1; }
    char sim[1200];
    xsnprintf(sim, sizeof sim, "%s/.sim", stage);
    cx_rm_rf(sim, 8);
  }
  /* strip sealed keys and the account id */
  char p[1200];
  xsnprintf(p, sizeof p, "%s/sce_sys/sealedkey", stage); util_unlink_quiet(p);
  xsnprintf(p, sizeof p, "%s/sce_sys/keystone", stage); util_unlink_quiet(p);
  if (decrypted) {
    xsnprintf(p, sizeof p, "%s/sce_sys/param.sfo", stage);
    size_t sl = 0;
    char *sfo = util_read_file(p, &sl, 1 << 20);
    if (sfo) {
      if (cx_sfo_set_account_id((uint8_t *)sfo, sl, 0) == 0) { util_write_file_atomic(p, sfo, sl); out->accountIdStripped = 1; }
      free(sfo);
    } else out->accountIdStripped = 1;   /* nothing to strip */
  }
  jw mw;
  jw_init(&mw);
  jw_obj_begin(&mw);
  jw_kv_str(&mw, "titleId", titleId);
  jw_kv_str(&mw, "dirName", dirName ? dirName : "");
  jw_kv_str(&mw, "kind", kind);
  jw_kv_str(&mw, "format", decrypted ? "xeno-save-zip" : "xeno-raw-zip");
  jw_kv_bool(&mw, "accountIdStripped", out->accountIdStripped);
  jw_kv_bool(&mw, "sameConsoleOnly", !decrypted);
  jw_kv_str(&mw, "createdBy", "XENO STORE " XENO_VERSION);
  char iso[40];
  util_iso8601(util_now(), iso, sizeof iso);
  jw_kv_str(&mw, "createdAt", iso);
  jw_key(&mw, "files"); jw_arr_begin(&mw);
  int files = 0;
  hash_tree(stage, "", &mw, 0, &files);
  jw_arr_end(&mw);
  jw_obj_end(&mw);
  size_t ml;
  char *mtxt = jw_detach(&mw, &ml);
  if (mtxt) {
    xsnprintf(p, sizeof p, "%s/xeno-save.json", stage);
    util_write_file_atomic(p, mtxt, ml);
    if (ml < sizeof out->manifest) memcpy(out->manifest, mtxt, ml + 1); else xstrlcpy(out->manifest, "{}", sizeof out->manifest);
    free(mtxt);
  }
  storage_ensure_parent_dir(dest_zip);
  zip_stats st;
  if (zip_create_from_dir(dest_zip, stage, NULL, NULL, &st) != 0) { xsnprintf(err, errcap, "zip failed: %s", st.error); cx_rm_rf(stage, 8); return -1; }
  cx_rm_rf(stage, 8);
  xstrlcpy(out->tier, decrypted ? cx_tier_name(CX_TIER_NATIVE) : "raw", sizeof out->tier);
  xstrlcpy(out->zipPath, dest_zip, sizeof out->zipPath);
  xstrlcpy(out->format, decrypted ? "xeno-save-zip" : "xeno-raw-zip", sizeof out->format);
  out->size = util_file_size(dest_zip);
  out->files = files;
  cx_sha256_file(dest_zip, out->sha256);
  return 0;
}
