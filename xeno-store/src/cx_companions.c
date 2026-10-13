/*
 * cx_companions.c — see cx_companions.h.
 */
#include "cx_companions.h"
#include "cx_common.h"
#include "cx_feeds.h"
#include "cx_jobs.h"
#include "http_client.h"
#include "log.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LOADER_PORT_DEFAULT 9021
#define ELF_MAX_BYTES (64LL << 20)
#define COMP_MAX 64

static pthread_mutex_t comp_mu = PTHREAD_MUTEX_INITIALIZER;
static const char *const PAYLOAD_HOSTS[] = {"github.com", "githubusercontent.com", "raw.githubusercontent.com"};

typedef struct comp {
  char id[48], name[96], version[32], url[1024], sha256[65], notes[256], kind[24], homepage[256], filename[128];
  int64_t size;
} comp;

static int loader_port(void) { return cx_local_port("LOADER", LOADER_PORT_DEFAULT); }

static void payload_path(const char *id, char *out, size_t cap) { xsnprintf(out, cap, "%s/payloads/%s.elf", cx_data_dir(), id); }
static void installed_path(char *out, size_t cap) { xsnprintf(out, cap, "%s/payloads/installed.json", cx_data_dir()); }

static int load_feed(comp *out, int max) {
  jdoc *d = cx_feed_doc(CX_FEED_COMPANIONS);
  if (!d) return 0;
  jv root = json_root(d);
  jv arr = jv_get(root, "payloads");
  if (jv_type(arr) != JV_ARR) arr = jv_get(root, "companions");
  if (jv_type(arr) != JV_ARR && jv_type(root) == JV_ARR) arr = root;
  int n = 0;
  JV_FOREACH(it, arr) {
    if (n >= max) break;
    comp *c = &out[n];
    memset(c, 0, sizeof *c);
    const char *id = jv_get_str(it, "id", "");
    const char *name = jv_get_str(it, "name", "");
    const char *url = jv_get_str(it, "url", "");
    char derived[48] = "";
    if (!*id && *name) {
      size_t o = 0;
      for (const char *p = name; *p && o + 1 < sizeof derived; p++) {
        char ch = *p;
        if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) derived[o++] = ch;
        else if (ch >= 'A' && ch <= 'Z') derived[o++] = (char)(ch + 32);
        else if (o && derived[o - 1] != '-') derived[o++] = '-';
      }
      derived[o] = 0;
      id = derived;
    }
    if (!cx_id_valid(id, 47) || !*name || !util_istarts_with(url, "http")) continue;
    xstrlcpy(c->id, id, sizeof c->id);
    xstrlcpy(c->name, name, sizeof c->name);
    xstrlcpy(c->version, jv_get_str(it, "version", ""), sizeof c->version);
    xstrlcpy(c->url, url, sizeof c->url);
    xstrlcpy(c->sha256, jv_get_str(it, "sha256", ""), sizeof c->sha256);
    util_lower(c->sha256);
    xstrlcpy(c->notes, jv_get_str(it, "notes", jv_get_str(it, "description", "")), sizeof c->notes);
    xstrlcpy(c->kind, jv_get_str(it, "kind", "payload"), sizeof c->kind);
    xstrlcpy(c->homepage, jv_get_str(it, "homepage", ""), sizeof c->homepage);
    xstrlcpy(c->filename, jv_get_str(it, "filename", ""), sizeof c->filename);
    c->size = jv_get_i64(it, "size", 0);
    n++;
  }
  json_free(d);
  return n;
}

static int find_comp(const char *id, comp *out) {
  comp *all = calloc(COMP_MAX, sizeof *all);
  if (!all) return -1;
  int n = load_feed(all, COMP_MAX);
  int rc = -1;
  for (int i = 0; i < n; i++) if (strcmp(all[i].id, id) == 0) { *out = all[i]; rc = 0; break; }
  free(all);
  return rc;
}

static jdoc *installed_doc(void) {
  char p[700];
  installed_path(p, sizeof p);
  return cx_json_file(p, 1 << 20, 5000);
}

static void record_installed(const comp *c, const char *sha) {
  char p[700];
  installed_path(p, sizeof p);
  jdoc *d = installed_doc();
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  if (d) {
    JV_FOREACH(m, json_root(d)) {
      const char *k = jv_key(m);
      if (!k || strcmp(k, c->id) == 0) continue;
      jw_key(&w, k);
      jw_value(&w, m);
    }
    json_free(d);
  }
  jw_key(&w, c->id); jw_obj_begin(&w);
  jw_kv_str(&w, "version", c->version);
  jw_kv_str(&w, "sha256", sha);
  jw_kv_str(&w, "name", c->name);
  jw_kv_str(&w, "kind", c->kind);
  jw_kv_i64(&w, "installedAt", (int64_t)util_now());
  jw_obj_end(&w);
  jw_obj_end(&w);
  pthread_mutex_lock(&comp_mu);
  cx_write_json(p, &w);
  pthread_mutex_unlock(&comp_mu);
}

void cx_companions_init(void) {
  char dir[700];
  xsnprintf(dir, sizeof dir, "%s/payloads", cx_data_dir());
  util_mkdir_p(dir);
}

void cx_companions_json(jw *w) {
  comp *all = calloc(COMP_MAX, sizeof *all);
  int n = all ? load_feed(all, COMP_MAX) : 0;
  jdoc *inst = installed_doc();
  jw_key(w, "payloads");
  jw_arr_begin(w);
  for (int i = 0; i < n; i++) {
    comp *c = &all[i];
    char p[700];
    payload_path(c->id, p, sizeof p);
    int64_t sz = util_file_size(p);
    jv rec = inst ? jv_get(json_root(inst), c->id) : jv_get(json_root(inst), "");
    const char *iv = inst && jv_ok(rec) ? jv_get_str(rec, "version", "") : "";
    jw_obj_begin(w);
    jw_kv_str(w, "id", c->id);
    jw_kv_str(w, "name", c->name);
    jw_kv_str(w, "version", c->version);
    jw_kv_str(w, "url", c->url);
    jw_kv_str(w, "sha256", c->sha256);
    jw_kv_str(w, "notes", c->notes);
    jw_kv_str(w, "kind", c->kind);
    jw_kv_str(w, "homepage", c->homepage);
    jw_kv_i64(w, "size", c->size);
    jw_kv_bool(w, "installed", sz > 0);
    jw_kv_str(w, "localPath", sz > 0 ? p : "");
    jw_kv_i64(w, "localSize", sz > 0 ? sz : 0);
    jw_kv_str(w, "installedVersion", sz > 0 ? iv : "");
    jw_kv_bool(w, "updateAvailable", sz > 0 && iv[0] && c->version[0] && util_semver_cmp(c->version, iv) > 0);
    jw_obj_end(w);
  }
  jw_arr_end(w);
  if (inst) json_free(inst);
  free(all);
  jw_kv_int(w, "loaderPort", loader_port());
  jw_kv_bool(w, "loaderAvailable", cx_tcp_probe(loader_port(), 300));
  jw_kv_i64(w, "feedFetchedAt", (int64_t)cx_feed_fetched_at(CX_FEED_COMPANIONS));
  jw_kv_str(w, "note", "Payloads are downloaded to the console (sha256 checked) and sent to the local ELF loader on :9021. XENO STORE never loads code in-process.");
}

typedef struct inst_arg { comp c; char dest[700]; } inst_arg;

static int dl_cb(void *user, int64_t done, int64_t total) {
  cx_job *j = user;
  cx_job_progress(j, done, total, "Downloading");
  return cx_job_cancelled(j);
}

static int install_worker(cx_job *j, void *p) {
  inst_arg *a = p;
  char host[256];
  util_url_host(a->c.url, host, sizeof host);
  if (!cx_host_in(host, PAYLOAD_HOSTS, XS_ARRAY_LEN(PAYLOAD_HOSTS)) && !cx_host_is_loopback(host)) { cx_job_fail(j, "forbidden", "Payload URL host is not allowed (GitHub releases only)"); return -1; }
  char err[256] = "";
  cx_job_progress(j, 0, a->c.size, "Downloading");
  if (cx_download_file(a->c.url, NULL, a->dest, a->c.sha256, ELF_MAX_BYTES, dl_cb, j, &j->cancel, err, sizeof err) != 0) { cx_job_fail(j, "download_failed", err); return -1; }
  /* must look like an ELF */
  int is_elf = 0;
  {
    unsigned char head[4] = {0, 0, 0, 0};
    FILE *f = fopen(a->dest, "rb");
    if (f) { is_elf = fread(head, 1, 4, f) == 4 && memcmp(head, "\x7f" "ELF", 4) == 0; fclose(f); }
  }
  if (!is_elf) { util_unlink_quiet(a->dest); cx_job_fail(j, "not_elf", "The downloaded file is not an ELF payload"); return -1; }
  char sha[65] = "";
  cx_sha256_file(a->dest, sha);
  record_installed(&a->c, sha);
  jw rw;
  jw_init(&rw);
  jw_obj_begin(&rw);
  jw_kv_str(&rw, "id", a->c.id);
  jw_kv_str(&rw, "localPath", a->dest);
  jw_kv_str(&rw, "sha256", sha);
  jw_kv_i64(&rw, "size", util_file_size(a->dest));
  jw_kv_bool(&rw, "verified", a->c.sha256[0] != 0);
  jw_obj_end(&rw);
  cx_job_set_result(j, &rw);
  cx_job_progress(j, 1, 1, "Ready to launch");
  LOGI("companions: installed %s (%s)", a->c.id, sha);
  return 0;
}

int cx_companions_install(const char *id, char *job_id, size_t idcap, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!cx_id_valid(id, 47)) { xsnprintf(err, errcap, "invalid payload id"); return -1; }
  inst_arg *a = calloc(1, sizeof *a);
  if (!a) { xstrlcpy(code, "oom", ccap); xsnprintf(err, errcap, "out of memory"); return -1; }
  if (find_comp(id, &a->c) != 0) { free(a); xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "unknown payload id (refresh the catalog to update the list)"); return -1; }
  if (!xhttp_available()) { free(a); xstrlcpy(code, "downloads_unavailable", ccap); xsnprintf(err, errcap, "network transport unavailable"); return -1; }
  payload_path(id, a->dest, sizeof a->dest);
  if (cx_job_start("payload-install", a->c.name, install_worker, a, job_id, idcap) != 0) { free(a); xstrlcpy(code, "busy", ccap); xsnprintf(err, errcap, "too many operations running"); return -1; }
  return 0;
}

int cx_companions_launch(const char *id, jw *w, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!cx_id_valid(id, 47)) { xsnprintf(err, errcap, "invalid payload id"); return -1; }
  char p[700];
  payload_path(id, p, sizeof p);
  size_t len = 0;
  char *data = util_read_file(p, &len, (size_t)ELF_MAX_BYTES);
  if (!data) { xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "payload is not installed yet"); return -1; }
  if (len < 4 || memcmp(data, "\x7f" "ELF", 4) != 0) { free(data); xstrlcpy(code, "not_elf", ccap); xsnprintf(err, errcap, "stored file is not an ELF"); return -1; }
  int port = loader_port();
  char e2[160];
  if (cx_tcp_send_all(port, data, len, 10000, e2, sizeof e2) != 0) {
    free(data);
    xstrlcpy(code, "loader_unavailable", ccap);
    xsnprintf(err, errcap, "ELF loader not answering on 127.0.0.1:%d — start your payload loader (etaHEN/elfldr) and try again", port);
    return -1;
  }
  free(data);
  jw_kv_str(w, "id", id);
  jw_kv_i64(w, "bytes", (int64_t)len);
  jw_kv_int(w, "port", port);
  jw_kv_bool(w, "sent", 1);
  LOGI("companions: sent %s (%zu bytes) to :%d", id, len, port);
  return 0;
}

int cx_companions_find_installed(const char *needle, char *id_out, size_t cap) {
  jdoc *inst = installed_doc();
  if (!inst) return -1;
  int rc = -1;
  JV_FOREACH(m, json_root(inst)) {
    const char *k = jv_key(m);
    if (!k) continue;
    if (util_strcasestr(k, needle) || util_strcasestr(jv_get_str(m, "name", ""), needle) || util_strcasestr(jv_get_str(m, "kind", ""), needle)) {
      char p[700];
      payload_path(k, p, sizeof p);
      if (util_file_exists(p)) { xstrlcpy(id_out, k, cap); rc = 0; break; }
    }
  }
  json_free(inst);
  return rc;
}
