/*
 * update.c — see update.h.
 *
 * Feed format (Payload Manager repository, SPEC §12):
 *   {"payloads":[{"name","version","filename","url","sha256","minFw","notes"}], ...}
 * The entry whose filename is xeno-store.elf (or the first entry) wins.
 * Fallback: GitHub Releases "latest" — tag xeno-store-v<ver>, asset
 * xeno-store.elf, and SHA256SUMS when present for the hash.
 */
#include "update.h"
#include "config.h"
#include "http_client.h"
#include "log.h"
#include "settings.h"
#include "sha256.h"
#include "util.h"

#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define GITHUB_LATEST "https://api.github.com/repos/XENOKING123/XENOKING/releases/latest"

static pthread_mutex_t update_mu = PTHREAD_MUTEX_INITIALIZER;
static char data_dir[512];
static struct {
  char latest[32], url[1024], sha256[65], notes[512];
  time_t checkedAt;
  int available;
} U;

void update_init(const char *dir) {
  xstrlcpy(data_dir, dir, sizeof data_dir);
  xstrlcpy(U.latest, XENO_VERSION, sizeof U.latest);
}

static char *fetch(const char *url, int timeout_ms, size_t max, size_t *len, xhttp_resp *resp) {
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.url = url;
  r.range_start = r.range_end = -1;
  r.follow_redirects = 5;
  r.connect_timeout_ms = timeout_ms;
  r.recv_timeout_ms = timeout_ms;
  r.extra_headers = "Accept: application/json\r\nCache-Control: no-cache\r\n";
  return xhttp_fetch(&r, resp, max, len);
}

/* Parses the Payload Manager feed into U (caller holds update_mu). */
static int parse_feed(const char *txt, size_t len) {
  jdoc *d = json_parse(txt, len, 5000, 16);
  if (!d) return -1;
  jv best = { NULL, 0xFFFFFFFFu };
  JV_FOREACH(p, jv_get(json_root(d), "payloads")) {
    const char *fn = jv_get_str(p, "filename", "");
    if (!jv_ok(best) || strcmp(fn, "xeno-store.elf") == 0) best = p;
    if (strcmp(fn, "xeno-store.elf") == 0) break;
  }
  if (!jv_ok(best)) { json_free(d); return -1; }
  xstrlcpy(U.latest, jv_get_str(best, "version", XENO_VERSION), sizeof U.latest);
  xstrlcpy(U.url, jv_get_str(best, "url", ""), sizeof U.url);
  xstrlcpy(U.sha256, jv_get_str(best, "sha256", ""), sizeof U.sha256);
  xstrlcpy(U.notes, jv_get_str(best, "notes", ""), sizeof U.notes);
  util_lower(U.sha256);
  json_free(d);
  return 0;
}

/* Parses GitHub's releases/latest JSON into U (caller holds update_mu). */
static int parse_github(const char *txt, size_t len) {
  jdoc *d = json_parse(txt, len, 50000, 16);
  if (!d) return -1;
  const char *tag = jv_get_str(json_root(d), "tag_name", "");
  const char *v = util_starts_with(tag, "xeno-store-v") ? tag + 12 : tag[0] == 'v' ? tag + 1 : tag;
  if (!*v) { json_free(d); return -1; }
  xstrlcpy(U.latest, v, sizeof U.latest);
  xstrlcpy(U.notes, jv_get_str(json_root(d), "body", ""), sizeof U.notes);
  U.url[0] = 0;
  U.sha256[0] = 0;
  char sums_url[1024] = "";
  JV_FOREACH(a, jv_get(json_root(d), "assets")) {
    const char *name = jv_get_str(a, "name", "");
    if (strcmp(name, "xeno-store.elf") == 0) xstrlcpy(U.url, jv_get_str(a, "browser_download_url", ""), sizeof U.url);
    if (strcmp(name, "SHA256SUMS") == 0) xstrlcpy(sums_url, jv_get_str(a, "browser_download_url", ""), sizeof sums_url);
  }
  json_free(d);
  if (sums_url[0]) {
    xhttp_resp resp;
    size_t sl;
    char *sums = fetch(sums_url, 15000, 64 << 10, &sl, &resp);
    if (sums && resp.status == 200) {
      /* "<hex>  xeno-store.elf" per line */
      for (char *line = strtok(sums, "\n"); line; line = strtok(NULL, "\n")) {
        if (strstr(line, "xeno-store.elf") && !strstr(line, "browser") && strlen(line) > 64) {
          memcpy(U.sha256, line, 64);
          U.sha256[64] = 0;
          util_lower(U.sha256);
          break;
        }
      }
    }
    free(sums);
  }
  return U.url[0] ? 0 : -1;
}

int update_check(char *err, size_t errcap) {
  settings_t s;
  settings_get(&s);
  err[0] = 0;
  if (!xhttp_available()) { xsnprintf(err, errcap, "network transport unavailable"); return -1; }
  xhttp_resp resp;
  size_t len = 0;
  int rc = -1;
  pthread_mutex_lock(&update_mu);
  if (s.updatesFeed[0]) {
    char *txt = fetch(s.updatesFeed, 20000, 1 << 20, &len, &resp);
    if (txt && resp.status == 200) rc = parse_feed(txt, len);
    if (!txt) LOGW("update: feed fetch failed: %s", xhttp_last_error());
    else if (resp.status != 200) LOGW("update: feed returned HTTP %d", resp.status);
    free(txt);
  }
  if (rc != 0) {
    char *txt = fetch(GITHUB_LATEST, 20000, 4 << 20, &len, &resp);
    if (txt && resp.status == 200) rc = parse_github(txt, len);
    else if (!txt) xsnprintf(err, errcap, "Update check failed: %s", xhttp_last_error());
    else xsnprintf(err, errcap, "GitHub returned HTTP %d", resp.status);
    free(txt);
  }
  if (rc == 0) {
    U.checkedAt = util_now();
    U.available = util_semver_cmp(U.latest, XENO_VERSION) > 0;
    LOGI("update: latest %s (current %s) %s", U.latest, XENO_VERSION, U.available ? "AVAILABLE" : "up to date");
  } else if (!err[0]) {
    xsnprintf(err, errcap, "Could not read the update feed");
  }
  pthread_mutex_unlock(&update_mu);
  settings_touch_updates_check();
  return rc;
}

void update_status_json(jw *w) {
  pthread_mutex_lock(&update_mu);
  jw_kv_bool(w, "available", U.available);
  jw_kv_str(w, "latest", U.latest[0] ? U.latest : XENO_VERSION);
  jw_kv_str(w, "current", XENO_VERSION);
  jw_kv_str(w, "url", U.url);
  jw_kv_str(w, "sha256", U.sha256);
  jw_kv_str(w, "notes", U.notes);
  jw_kv_i64(w, "checkedAt", (int64_t)U.checkedAt);
  pthread_mutex_unlock(&update_mu);
}

/* Streams url to dst while hashing; returns 0 and the hex digest. */
static int download_to_file(const char *url, const char *dst, char hex[65], char *err, size_t errcap) {
  xhttp_req req;
  memset(&req, 0, sizeof req);
  req.url = url;
  req.range_start = req.range_end = -1;
  req.follow_redirects = 8;
  req.connect_timeout_ms = 20000;
  req.recv_timeout_ms = 60000;
  xhttp_conn *c = NULL;
  xhttp_resp resp;
  if (xhttp_open(&req, &c, &resp) != 0) { xsnprintf(err, errcap, "Download failed: %s", xhttp_last_error()); return -1; }
  if (resp.status != 200) { xsnprintf(err, errcap, "Download returned HTTP %d", resp.status); xhttp_close(c); return -1; }
  int fd = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0755);
  if (fd < 0) { xsnprintf(err, errcap, "Cannot write %s", dst); xhttp_close(c); return -1; }
  char *buf = malloc(256u << 10);
  sha256_ctx h;
  sha256_init(&h);
  int64_t total = 0;
  int rc = 0;
  for (;;) {
    int n = buf ? xhttp_read(c, buf, 256u << 10) : -1;
    if (n < 0) { xsnprintf(err, errcap, "Download interrupted: %s", xhttp_last_error()); rc = -1; break; }
    if (n == 0) break;
    sha256_update(&h, buf, (size_t)n);
    ssize_t off = 0;
    while (off < n) {
      ssize_t w = write(fd, buf + off, (size_t)(n - off));
      if (w <= 0) { xsnprintf(err, errcap, "Write failed"); rc = -1; break; }
      off += w;
    }
    if (rc) break;
    total += n;
    if (total > (64LL << 20)) { xsnprintf(err, errcap, "ELF larger than 64 MiB — refusing"); rc = -1; break; }
  }
  free(buf);
  fsync(fd);
  close(fd);
  xhttp_close(c);
  if (rc == 0 && total < 4096) { xsnprintf(err, errcap, "Downloaded file is too small to be an ELF"); rc = -1; }
  if (rc == 0) {
    uint8_t dgst[32];
    sha256_final(&h, dgst);
    sha256_digest_hex(dgst, hex);
  }
  return rc;
}

int update_apply(char *out_path, size_t cap, char *err, size_t errcap) {
  err[0] = 0;
  char url[1024], expect[65];
  pthread_mutex_lock(&update_mu);
  xstrlcpy(url, U.url, sizeof url);
  xstrlcpy(expect, U.sha256, sizeof expect);
  pthread_mutex_unlock(&update_mu);
  if (!url[0] && update_check(err, errcap) != 0) return -1;
  pthread_mutex_lock(&update_mu);
  xstrlcpy(url, U.url, sizeof url);
  xstrlcpy(expect, U.sha256, sizeof expect);
  pthread_mutex_unlock(&update_mu);
  if (!url[0]) { xsnprintf(err, errcap, "No download URL in the update feed"); return -1; }
  char staging[600], final[600];
  xsnprintf(staging, sizeof staging, "%s/xeno-store.elf.new", data_dir);
  xsnprintf(final, sizeof final, "%s/xeno-store.elf", data_dir);
  char hex[65];
  if (download_to_file(url, staging, hex, err, errcap) != 0) { util_unlink_quiet(staging); return -1; }
  if (expect[0] && strcmp(expect, hex) != 0) {
    xsnprintf(err, errcap, "SHA-256 mismatch (expected %.12s…, got %.12s…)", expect, hex);
    util_unlink_quiet(staging);
    return -1;
  }
  /* Sanity: an ELF starts with 0x7F 'E' 'L' 'F'. */
  size_t n;
  char *head = util_read_file(staging, &n, 64);
  int is_elf = head && n >= 4 && memcmp(head, "\x7f" "ELF", 4) == 0;
  free(head);
  if (!is_elf) { xsnprintf(err, errcap, "Downloaded file is not an ELF"); util_unlink_quiet(staging); return -1; }
  if (rename(staging, final) != 0) { xsnprintf(err, errcap, "Cannot rename staged ELF"); return -1; }
  util_fsync_dir(final);
  xstrlcpy(out_path, final, cap);
  LOGI("update: staged %s (sha256 %s)", final, hex);
  return 0;
}
