/*
 * ext_console.c — console feature routes (SPEC §17.2, §17.6, §17.16–§17.22)
 * registered through the api.h extension hooks: ext_console_init() adds the
 * route table, ext_console_tick() runs the periodic duties and
 * api_status_extra() adds featured/messages/setup/savesEngine/mdns to
 * GET /api/status. Every handler answers with the §6 envelope.
 */
#include "api.h"
#include "config.h"
#include "cx_accounts.h"
#include "cx_registry.h"
#include "cx_common.h"
#include "cx_companions.h"
#include "cx_enrich.h"
#include "cx_feeds.h"
#include "cx_homebrew.h"
#include "cx_jobs.h"
#include "cx_library.h"
#include "cx_mdns.h"
#include "cx_savemount.h"
#include "cx_saves.h"
#include "cx_savestore.h"
#include "cx_setup.h"
#include "cx_uninstall.h"
#include "dl.h"
#include "log.h"
#include "server.h"
#include "settings.h"
#include "storage.h"
#include "sys.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int status_for(const char *code) {
  if (strcmp(code, "not_found") == 0 || strcmp(code, "not_installed") == 0) return 404;
  if (strcmp(code, "exists") == 0) return 409;
  if (strcmp(code, "forbidden") == 0) return 403;
  if (strcmp(code, "confirm_required") == 0) return 428;
  if (strcmp(code, "downloads_unavailable") == 0 || strcmp(code, "loader_unavailable") == 0 || strcmp(code, "engine_unavailable") == 0) return 503;
  if (strcmp(code, "busy") == 0) return 429;
  if (strcmp(code, "oom") == 0 || strcmp(code, "io") == 0) return 500;
  if (strcmp(code, "bad_request") == 0 || strcmp(code, "title_mismatch") == 0) return 400;
  return 422;
}

static uint32_t body_user(api_ctx *c, const char *key) {
  jv v = jv_get(c->body, key);
  if (jv_type(v) == JV_NUM) return (uint32_t)jv_i64(v, 0);
  if (jv_type(v) == JV_STR) { const char *s = jv_str(v, ""); return (uint32_t)strtoul(s, NULL, util_istarts_with(s, "0x") ? 16 : 10); }
  return 0;
}

static void send_simple(api_ctx *c, jw *w) { api_send(c, w); }

/* ---- enrichment --------------------------------------------------------- */

static void h_enrich(api_ctx *c) {
  char id[160];
  http_query_get(c->req, "id", id, sizeof id);
  if (!id[0]) { api_error(c, 400, "bad_request", "id is required"); return; }
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "id", id);
  if (cx_enrich_json(id, http_query_int(c->req, "refresh", 0), &w) != 0) { jw_free(&w); api_error(c, 404, "not_found", "Unknown game id"); return; }
  send_simple(c, &w);
}

/* ---- setup -------------------------------------------------------------- */

static void h_setup_check(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_setup_check_json(&w);
  send_simple(c, &w);
}

/* ---- uninstall + ghost icons -------------------------------------------- */

static void h_uninstall(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  int data = jv_get_bool(c->body, "data", 0), homebrew = jv_get_bool(c->body, "homebrew", 0);
  int pm = jv_get_bool(c->body, "payloadManager", 0), downloads = jv_get_bool(c->body, "downloads", 0);
  if (!data && !homebrew && !pm && !downloads) { api_error(c, 400, "bad_request", "Nothing selected: pass data, homebrew, payloadManager and/or downloads"); return; }
  dl_save_queue();
  jw w;
  api_begin(&w);
  cx_uninstall(data, homebrew, pm, downloads, &w);
  send_simple(c, &w);
  sys_toast("XENO STORE uninstalled");
  LOGI("uninstall requested by %s — stopping", c->req->client_ip);
  g_cfg.stop_requested = 1;
}

static void h_homebrew_dirs(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_homebrew_dirs_json(&w);
  send_simple(c, &w);
}

static void h_homebrew_dirs_delete(api_ctx *c) {
  char code[32], err[256];
  if (cx_homebrew_dir_delete(api_body_str(c, "name", ""), api_body_str(c, "confirm", ""), code, sizeof code, err, sizeof err) != 0) { api_error(c, status_for(code), code, err); return; }
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "deleted", api_body_str(c, "name", ""));
  send_simple(c, &w);
}

/* ---- companion payloads ------------------------------------------------- */

static void h_payloads(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_companions_json(&w);
  send_simple(c, &w);
}

static void h_payload_install(api_ctx *c) {
  char id[16], code[32], err[256];
  if (cx_companions_install(c->params[0], id, sizeof id, code, sizeof code, err, sizeof err) != 0) { api_error(c, status_for(code), code, err); return; }
  jw w;
  api_begin(&w);
  jw_key(&w, "job");
  cx_job_json(&w, id);
  send_simple(c, &w);
}

static void h_payload_launch(api_ctx *c) {
  char code[32], err[256];
  jw w;
  api_begin(&w);
  if (cx_companions_launch(c->params[0], &w, code, sizeof code, err, sizeof err) != 0) { jw_free(&w); api_error(c, status_for(code), code, err); return; }
  send_simple(c, &w);
}

/* ---- saves hub ---------------------------------------------------------- */

static void h_saves_users(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_saves_users_json(&w);
  send_simple(c, &w);
}

static void h_saves_list(api_ctx *c) {
  char us[32], err[128];
  http_query_get(c->req, "user", us, sizeof us);
  uint32_t uid = us[0] ? (uint32_t)strtoul(us, NULL, util_istarts_with(us, "0x") ? 16 : 10) : 0;
  jw w;
  api_begin(&w);
  if (cx_saves_list_json(uid, &w, err, sizeof err) != 0) { jw_free(&w); api_error(c, 404, "not_found", err); return; }
  send_simple(c, &w);
}

static void h_saves_backup(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  uint32_t uid = body_user(c, "user");
  char err[256], code[32];
  jw w;
  api_begin(&w);
  if (jv_get_bool(c->body, "all", 0)) {
    if (cx_saves_backup_all(uid, &w, err, sizeof err) != 0) { jw_free(&w); api_error(c, 404, "not_found", err); return; }
    send_simple(c, &w);
    return;
  }
  char id[16];
  if (cx_saves_backup_start(uid, api_body_str(c, "titleId", ""), api_body_str(c, "kind", ""), id, sizeof id, code, sizeof code, err, sizeof err) != 0) { jw_free(&w); api_error(c, status_for(code), code, err); return; }
  if (jv_get_bool(c->body, "wait", 0)) cx_job_wait(id, 60000);
  jw_key(&w, "job");
  cx_job_json(&w, id);
  send_simple(c, &w);
}

static void h_saves_backups(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_saves_backups_json(&w);
  send_simple(c, &w);
}

static void h_saves_restore(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  char err[256], code[32];
  jw w;
  api_begin(&w);
  if (cx_saves_restore(body_user(c, "user"), api_body_str(c, "zipPath", ""), jv_get_bool(c->body, "overwrite", 0), &w, code, sizeof code, err, sizeof err) != 0) {
    jw_free(&w); api_error(c, status_for(code), code, err); return;
  }
  send_simple(c, &w);
}

static void h_saves_transfer(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  char err[256], code[32];
  jw w;
  api_begin(&w);
  if (cx_saves_transfer(body_user(c, "fromUser"), body_user(c, "toUser"), api_body_str(c, "titleId", ""), api_body_str(c, "kind", ""),
                        jv_get_bool(c->body, "move", 0), &w, code, sizeof code, err, sizeof err) != 0) {
    jw_free(&w); api_error(c, status_for(code), code, err); return;
  }
  send_simple(c, &w);
}

static void h_saves_jobs(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_jobs_json(&w);
  send_simple(c, &w);
}

static void h_saves_job(api_ctx *c) {
  jw w;
  api_begin(&w);
  jw_key(&w, "job");
  if (cx_job_json(&w, c->params[0]) != 0) { jw_free(&w); api_error(c, 404, "not_found", "No such job"); return; }
  send_simple(c, &w);
}

static void h_saves_job_cancel(api_ctx *c) {
  if (cx_job_cancel(c->params[0]) != 0) { api_error(c, 404, "not_found", "No such running job"); return; }
  jw w;
  api_begin(&w);
  jw_key(&w, "job");
  cx_job_json(&w, c->params[0]);
  send_simple(c, &w);
}

static void h_saves_engine(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_savemount_engine_json(&w);
  send_simple(c, &w);
}

/* ---- save data store ---------------------------------------------------- */

static void h_store_list(api_ctx *c) {
  char tid[16], cat[24], q[128];
  http_query_get(c->req, "titleId", tid, sizeof tid);
  http_query_get(c->req, "category", cat, sizeof cat);
  http_query_get(c->req, "q", q, sizeof q);
  jw w;
  api_begin(&w);
  cx_savestore_list_json(tid, cat, q, http_query_int(c->req, "refresh", 0), &w);
  send_simple(c, &w);
}

static void store_job(api_ctx *c, int download_only) {
  settings_t s;
  settings_get(&s);
  int backup_first = s.saves.autoBackup;
  jv bf = jv_get(c->body, "backupFirst");
  if (jv_type(bf) == JV_BOOL) backup_first = jv_bool(bf, backup_first);
  char id[16], code[32], err[256];
  if (cx_savestore_install(c->params[0], body_user(c, "user"), backup_first, download_only, id, sizeof id, code, sizeof code, err, sizeof err) != 0) {
    api_error(c, status_for(code), code, err); return;
  }
  if (jv_get_bool(c->body, "wait", 0)) cx_job_wait(id, 120000);
  jw w;
  api_begin(&w);
  jw_key(&w, "job");
  cx_job_json(&w, id);
  send_simple(c, &w);
}

static void h_store_install(api_ctx *c) { store_job(c, 0); }
static void h_store_download(api_ctx *c) { store_job(c, 1); }

static void h_store_cover(api_ctx *c) {
  char url[1200];
  if (cx_savestore_cover_url(c->params[0], url, sizeof url) != 0 || !url[0]) { api_error(c, 404, "not_found", "No cover for this save"); return; }
  char hdr[1300];
  xsnprintf(hdr, sizeof hdr, "Location: %s\r\nCache-Control: private, max-age=3000\r\n", url);
  http_send(c->req, 302, "text/plain; charset=utf-8", url, strlen(url), hdr);
}

static void h_saves_export(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  char code[32], err[256];
  jw w;
  api_begin(&w);
  if (cx_savestore_export(body_user(c, "user"), api_body_str(c, "titleId", ""), api_body_str(c, "dirName", ""), &w, code, sizeof code, err, sizeof err) != 0) {
    jw_free(&w); api_error(c, status_for(code), code, err); return;
  }
  send_simple(c, &w);
}

static void h_saves_upload(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  char code[32], err[256];
  jw w;
  api_begin(&w);
  if (cx_savestore_upload(api_body_str(c, "zipPath", ""), api_body_str(c, "host", ""), &w, code, sizeof code, err, sizeof err) != 0) {
    jw_free(&w); api_error(c, status_for(code), code, err); return;
  }
  send_simple(c, &w);
}

static void h_saves_submit(api_ctx *c) {
  char code[32], err[256];
  jw w;
  api_begin(&w);
  if (cx_savestore_submit(c->body, &w, code, sizeof code, err, sizeof err) != 0) { jw_free(&w); api_error(c, status_for(code), code, err); return; }
  send_simple(c, &w);
}

static void h_installed_version(api_ctx *c) {
  char tid[16];
  http_query_get(c->req, "titleId", tid, sizeof tid);
  if (!cx_titleid_valid(tid)) { api_error(c, 400, "bad_request", "titleId must look like PPSA12345 / CUSA12345"); return; }
  char ver[32] = "", src[12] = "";
  int installed = storage_title_installed(tid);
  cx_installed_version(tid, ver, sizeof ver, src, sizeof src);
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "titleId", tid);
  jw_kv_bool(&w, "installed", installed);
  jw_kv_str(&w, "version", ver);
  jw_kv_str(&w, "source", src);
  send_simple(c, &w);
}

/* ---- accounts ----------------------------------------------------------- */

static void h_accounts(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_accounts_json(&w);
  send_simple(c, &w);
}

static int slot_arg(api_ctx *c, int *slot) {
  *slot = util_parse_int(c->params[0], 0);
  if (*slot < 1 || *slot > CX_SLOT_COUNT) { api_error(c, 400, "bad_request", "slot must be 1..16"); return -1; }
  if (!cx_reg_available()) { api_error(c, 503, "registry_unavailable", "The system registry API is not available on this firmware"); return -1; }
  return 0;
}

static void h_account_activate(api_ctx *c) {
  int slot;
  if (slot_arg(c, &slot) != 0) return;
  uint64_t id = 0;
  const char *ids = api_body_str(c, "id", "");
  if (ids[0]) {
    char *end = NULL;
    id = strtoull(ids, &end, 16);
    if (!end || *end || id == 0) { api_error(c, 400, "bad_request", "id must be a hex account id like 0x1234abcd5678ef90"); return; }
  }
  uint32_t err = 0;
  if (cx_slot_activate(slot, id, &err) != 0) {
    char msg[160];
    xsnprintf(msg, sizeof msg, "Activation failed (registry error 0x%08x). Slot %d may be empty.", err, slot);
    api_error(c, 422, "activate_failed", msg);
    return;
  }
  uint64_t now_id = 0;
  cx_slot_get_id(slot, &now_id, NULL);
  char hex[24];
  xsnprintf(hex, sizeof hex, "0x%016llx", (unsigned long long)now_id);
  jw w;
  api_begin(&w);
  jw_kv_int(&w, "slot", slot);
  jw_kv_str(&w, "id", hex);
  jw_kv_bool(&w, "activated", 1);
  jw_kv_bool(&w, "rebootRequired", 1);
  jw_kv_str(&w, "note", "Reboot the console for the activation to take effect. Back up your saves first.");
  send_simple(c, &w);
  LOGI("accounts: slot %d activated (%s)", slot, hex);
}

static void h_account_clear(api_ctx *c) {
  int slot;
  if (slot_arg(c, &slot) != 0) return;
  uint32_t err = 0;
  if (cx_slot_clear(slot, &err) != 0) { char msg[120]; xsnprintf(msg, sizeof msg, "Clear failed (registry error 0x%08x)", err); api_error(c, 422, "clear_failed", msg); return; }
  jw w;
  api_begin(&w);
  jw_kv_int(&w, "slot", slot);
  jw_kv_bool(&w, "activated", 0);
  jw_kv_bool(&w, "rebootRequired", 1);
  send_simple(c, &w);
  LOGI("accounts: slot %d cleared", slot);
}

static void h_reboot(api_ctx *c) {
  dl_save_queue();
  jw w;
  api_begin(&w);
  jw_kv_bool(&w, "rebooting", !cx_is_host());
  jw_kv_bool(&w, "simulated", cx_is_host());
  send_simple(c, &w);
  cx_reboot();
}

/* ---- mdns --------------------------------------------------------------- */

static void h_mdns(api_ctx *c) {
  jw w;
  api_begin(&w);
  jw_key(&w, "mdns");
  cx_mdns_status_json(&w);
  send_simple(c, &w);
}

#ifdef XENO_HOST
/* Host-only: exercises the packet builder for the unit test. */
static void h_mdns_build(api_ctx *c) {
  const char *b64 = api_body_str(c, "query", "");
  const char *ips = api_body_str(c, "ip", "192.168.1.20");
  uint8_t q[1500], out[512];
  size_t qlen = 0;
  if (util_b64_decode(b64, strlen(b64), q, sizeof q, &qlen) != 0) { api_error(c, 400, "bad_request", "query must be base64"); return; }
  unsigned a, b, cc, d;
  if (sscanf(ips, "%u.%u.%u.%u", &a, &b, &cc, &d) != 4) { api_error(c, 400, "bad_request", "ip must be dotted"); return; }
  uint32_t ip_be = (uint32_t)((a & 255) | ((b & 255) << 8) | ((cc & 255) << 16) | ((d & 255) << 24));
  int uni = 0;
  size_t n = jv_get_bool(c->body, "announce", 0) ? cx_mdns_build_announce(ip_be, out, sizeof out) : cx_mdns_build_response(q, qlen, ip_be, out, sizeof out, &uni);
  char enc[1024];
  util_b64_encode(out, n, enc, sizeof enc);
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "answer", n ? enc : "");
  jw_kv_int(&w, "length", (int)n);
  jw_kv_bool(&w, "unicast", uni);
  send_simple(c, &w);
}
#endif

/* ---- library extras ----------------------------------------------------- */

static void h_library_launch(api_ctx *c) {
  char code[32], err[256];
  jw w;
  api_begin(&w);
  if (cx_library_launch(api_body_str(c, "titleId", ""), &w, code, sizeof code, err, sizeof err) != 0) { jw_free(&w); api_error(c, status_for(code), code, err); return; }
  send_simple(c, &w);
}

static void h_library_uninstall(api_ctx *c) {
  char code[32], err[256];
  jw w;
  api_begin(&w);
  int rc = cx_library_uninstall(api_body_str(c, "titleId", ""), api_body_str(c, "token", ""), &w, code, sizeof code, err, sizeof err);
  if (rc < 0) { jw_free(&w); api_error(c, status_for(code), code, err); return; }
  send_simple(c, &w);
}

static void h_library_usage(api_ctx *c) {
  jw w;
  api_begin(&w);
  cx_library_usage_json(&w);
  send_simple(c, &w);
}

static void h_library_clean(api_ctx *c) {
  char err[160];
  jw w;
  api_begin(&w);
  if (cx_library_clean_partials(api_body_str(c, "root", ""), &w, err, sizeof err) != 0) { jw_free(&w); api_error(c, 422, "root_unavailable", err); return; }
  send_simple(c, &w);
}

/* ---- homebrew store ----------------------------------------------------- */

static void h_homebrew(api_ctx *c) {
  char q[128], cat[32];
  http_query_get(c->req, "q", q, sizeof q);
  http_query_get(c->req, "category", cat, sizeof cat);
  jw w;
  api_begin(&w);
  cx_homebrew_json(http_query_int(c->req, "refresh", 0), q, cat, &w);
  send_simple(c, &w);
}

static void h_homebrew_installed(api_ctx *c) {
  char err[128];
  if (cx_homebrew_record_installed(c->params[0], api_body_str(c, "titleId", ""), api_body_str(c, "version", ""), err, sizeof err) != 0) { api_error(c, 400, "bad_request", err); return; }
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "id", c->params[0]);
  send_simple(c, &w);
}

static void h_image(api_ctx *c) {
  char url[1536];
  http_query_get(c->req, "url", url, sizeof url);
  cx_image_proxy(c->req, url);
}

/* ---- feeds -------------------------------------------------------------- */

static void h_feeds(api_ctx *c) {
  jw w;
  api_begin(&w);
  jw_key(&w, "featured"); cx_feed_json(CX_FEED_FEATURED, &w);
  jw_key(&w, "messages"); cx_feed_json(CX_FEED_MESSAGES, &w);
  jw_key(&w, "companions"); cx_feed_json(CX_FEED_COMPANIONS, &w);
  jw_key(&w, "savesBackend"); cx_feed_json(CX_FEED_SAVES_BACKEND, &w);
  jw_key(&w, "fetchedAt"); jw_obj_begin(&w);
  jw_kv_i64(&w, "featured", (int64_t)cx_feed_fetched_at(CX_FEED_FEATURED));
  jw_kv_i64(&w, "messages", (int64_t)cx_feed_fetched_at(CX_FEED_MESSAGES));
  jw_kv_i64(&w, "companions", (int64_t)cx_feed_fetched_at(CX_FEED_COMPANIONS));
  jw_kv_i64(&w, "savesBackend", (int64_t)cx_feed_fetched_at(CX_FEED_SAVES_BACKEND));
  jw_obj_end(&w);
  send_simple(c, &w);
}

static void h_feeds_refresh(api_ctx *c) {
  cx_feeds_refresh(1);
  h_feeds(c);
}

/* ---- status extra + routes ---------------------------------------------- */

void api_status_extra(jw *w) {
  jw_key(w, "featured"); cx_feed_json(CX_FEED_FEATURED, w);
  jdoc *m = cx_feed_doc(CX_FEED_MESSAGES);
  jw_key(w, "messages");
  if (m) {
    jv arr = jv_get(json_root(m), "messages");
    if (jv_type(arr) == JV_ARR) jw_value(w, arr); else if (jv_type(json_root(m)) == JV_ARR) jw_value(w, json_root(m)); else { jw_arr_begin(w); jw_arr_end(w); }
    json_free(m);
  } else { jw_arr_begin(w); jw_arr_end(w); }
  jw_key(w, "setup"); cx_setup_summary_json(w);
  jw_kv_str(w, "savesEngine", cx_tier_name(cx_savemount_tier()));
  jw_key(w, "mdns"); cx_mdns_status_json(w);
  jw_kv_int(w, "consoleJobs", cx_jobs_active(""));
}

static const api_route ROUTES[] = {
  { "GET", "/api/game/enrich", h_enrich },
  { "GET", "/api/setup/check", h_setup_check },
  { "POST", "/api/setup/check", h_setup_check },
  { "POST", "/api/uninstall", h_uninstall },
  { "GET", "/api/homebrew-dirs", h_homebrew_dirs },
  { "POST", "/api/homebrew-dirs/delete", h_homebrew_dirs_delete },
  { "GET", "/api/payloads", h_payloads },
  { "POST", "/api/payloads/{id}/install", h_payload_install },
  { "POST", "/api/payloads/{id}/launch", h_payload_launch },
  { "GET", "/api/saves/users", h_saves_users },
  { "GET", "/api/saves", h_saves_list },
  { "POST", "/api/saves/backup", h_saves_backup },
  { "GET", "/api/saves/backups", h_saves_backups },
  { "POST", "/api/saves/restore", h_saves_restore },
  { "POST", "/api/saves/transfer", h_saves_transfer },
  { "GET", "/api/saves/jobs", h_saves_jobs },
  { "GET", "/api/saves/jobs/{id}", h_saves_job },
  { "POST", "/api/saves/jobs/{id}/cancel", h_saves_job_cancel },
  { "GET", "/api/saves/engine", h_saves_engine },
  { "GET", "/api/saves/store", h_store_list },
  { "POST", "/api/saves/store/{id}/install", h_store_install },
  { "POST", "/api/saves/store/{id}/download", h_store_download },
  { "GET", "/api/saves/store/{id}/cover", h_store_cover },
  { "POST", "/api/saves/export", h_saves_export },
  { "POST", "/api/saves/upload", h_saves_upload },
  { "POST", "/api/saves/submit", h_saves_submit },
  { "GET", "/api/saves/installed-version", h_installed_version },
  { "GET", "/api/accounts", h_accounts },
  { "POST", "/api/accounts/reboot", h_reboot },
  { "POST", "/api/accounts/{slot}/activate", h_account_activate },
  { "POST", "/api/accounts/{slot}/clear", h_account_clear },
  { "GET", "/api/mdns", h_mdns },
#ifdef XENO_HOST
  { "POST", "/api/mdns/build", h_mdns_build },
#endif
  { "POST", "/api/library/launch", h_library_launch },
  { "POST", "/api/library/uninstall", h_library_uninstall },
  { "GET", "/api/library/usage", h_library_usage },
  { "POST", "/api/library/usage/clean", h_library_clean },
  { "GET", "/api/homebrew", h_homebrew },
  { "POST", "/api/homebrew/{id}/installed", h_homebrew_installed },
  { "GET", "/api/image", h_image },
  { "GET", "/api/feeds", h_feeds },
  { "POST", "/api/feeds/refresh", h_feeds_refresh },
};

void ext_console_init(void) {
  cx_feeds_init();
  cx_accounts_init();
  cx_savemount_init();
  cx_saves_init();
  cx_savestore_init();
  cx_companions_init();
  cx_homebrew_init();
  cx_setup_init();
  cx_mdns_init();
  if (api_register_routes(ROUTES, XS_ARRAY_LEN(ROUTES)) != 0) LOGE("ext_console: route table not registered");
  else LOGI("ext_console: %zu routes registered", XS_ARRAY_LEN(ROUTES));
}

void ext_console_tick(void) {
  cx_feeds_tick();
  cx_setup_tick();
  cx_mdns_tick();
  cx_savestore_tick();
}
