/* pairing.c — see pairing.h. */
#include "pairing.h"
#include "json.h"
#include "log.h"
#include "sys.h"
#include "util.h"

#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PAIR_MAX_TOKENS 16
#define PAIR_TOKEN_HEX 64
#define PAIR_SHOW_COOLDOWN_S 30
#define PAIR_LOCKOUT_S 60
#define PAIR_MAX_STRIKES 5

static pthread_mutex_t pair_mu = PTHREAD_MUTEX_INITIALIZER;
static char pair_dir[512];
static char pair_path[560];
static char pair_code_val[7];                         /* 6 digits + NUL */
static char pair_tokens[PAIR_MAX_TOKENS][PAIR_TOKEN_HEX + 1];
static int pair_ntokens;
static time_t pair_locked_until;
static int pair_strikes;
static time_t pair_show_after;
static int pair_ready;

/* Constant-time equality over the first n bytes (no early exit on mismatch). */
static int ct_eq(const char *a, const char *b, size_t n) {
  unsigned char d = 0;
  for (size_t i = 0; i < n; i++) d |= (unsigned char)a[i] ^ (unsigned char)b[i];
  return d == 0;
}

/* Fills out[0..5] with six decimal digits from the strongest source available. */
static void gen_code(char out[7]) {
  uint8_t pool[6];
  size_t have = 0;
  int fd = open("/dev/urandom", O_RDONLY);
  if (fd >= 0) { ssize_t r = read(fd, pool, sizeof pool); if (r > 0) have = (size_t)r; close(fd); }
  for (int i = 0; i < 6; i++) {
    uint32_t r;
    if ((size_t)i < have) r = pool[i];
    else { char hx[3]; util_rand_hex(hx, 2); r = (uint32_t)strtoul(hx, NULL, 16); }
    out[i] = (char)('0' + (r % 10));
  }
  out[6] = 0;
}

static int is_hex64(const char *s) {
  if (!s) return 0;
  size_t n = 0;
  for (; s[n]; n++) {
    char c = s[n];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return 0;
  }
  return n == PAIR_TOKEN_HEX;
}

/* Caller holds pair_mu. Writes <data>/pairing.json atomically. 0 or -1. */
static int persist_locked(void) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_int(&w, "v", 1);
  jw_key(&w, "tokens");
  jw_arr_begin(&w);
  for (int i = 0; i < pair_ntokens; i++) jw_str(&w, pair_tokens[i]);
  jw_arr_end(&w);
  jw_obj_end(&w);
  size_t len = 0;
  char *txt = jw_detach(&w, &len);
  if (!txt) return -1;
  int rc = util_write_file_atomic(pair_path, txt, len);
  free(txt);
  return rc;
}

static void load_locked(void) {
  pair_ntokens = 0;
  size_t len = 0;
  char *txt = util_read_file(pair_path, &len, 1u << 20);
  if (!txt) return;
  jdoc *d = json_parse(txt, len, 4096, 8);
  free(txt);
  if (!d) return;
  JV_FOREACH(t, jv_get(json_root(d), "tokens")) {
    const char *s = jv_str(t, "");
    if (is_hex64(s) && pair_ntokens < PAIR_MAX_TOKENS) {
      memcpy(pair_tokens[pair_ntokens], s, PAIR_TOKEN_HEX);
      pair_tokens[pair_ntokens][PAIR_TOKEN_HEX] = 0;
      pair_ntokens++;
    }
  }
  json_free(d);
}

void pairing_init(const char *data_dir) {
  pthread_mutex_lock(&pair_mu);
  xstrlcpy(pair_dir, data_dir ? data_dir : ".", sizeof pair_dir);
  xsnprintf(pair_path, sizeof pair_path, "%s/pairing.json", pair_dir);
  load_locked();
  gen_code(pair_code_val);
  pair_locked_until = 0;
  pair_strikes = 0;
  pair_show_after = 0;
  pair_ready = 1;
  pthread_mutex_unlock(&pair_mu);
  sys_toast("XENO STORE pairing code: %s", pair_code_val);
  LOGI("pairing: code ready (%d paired device%s)", pair_ntokens, pair_ntokens == 1 ? "" : "s");
}

const char *pairing_code(void) { return pair_code_val; }

int pairing_show_cooldown(void) {
  pthread_mutex_lock(&pair_mu);
  time_t now = util_now();
  int left = pair_show_after > now ? (int)(pair_show_after - now) : 0;
  pthread_mutex_unlock(&pair_mu);
  return left;
}

int pairing_show(int *retry_after) {
  pthread_mutex_lock(&pair_mu);
  time_t now = util_now();
  if (pair_show_after > now) {
    int left = (int)(pair_show_after - now);
    pthread_mutex_unlock(&pair_mu);
    if (retry_after) *retry_after = left;
    return 1;
  }
  /* Failed shows are throttled too, so repeated requests cannot flood. */
  pair_show_after = now + PAIR_SHOW_COOLDOWN_S;
  char code[7];
  memcpy(code, pair_code_val, sizeof code);
  pthread_mutex_unlock(&pair_mu);
  if (retry_after) *retry_after = PAIR_SHOW_COOLDOWN_S;
  sys_toast("XENO STORE pairing code: %s", code);
  return 0;
}

int pairing_redeem(const char *code, char *token_out, size_t cap, int *retry_after) {
  if (token_out && cap) token_out[0] = 0;
  pthread_mutex_lock(&pair_mu);
  time_t now = util_now();
  if (pair_locked_until > now) {
    if (retry_after) *retry_after = (int)(pair_locked_until - now);
    pthread_mutex_unlock(&pair_mu);
    return -429;
  }
  if (!code || strlen(code) != 6 || !ct_eq(code, pair_code_val, 6)) {
    if (++pair_strikes >= PAIR_MAX_STRIKES) { pair_locked_until = now + PAIR_LOCKOUT_S; pair_strikes = 0; }
    pthread_mutex_unlock(&pair_mu);
    return -403;
  }
  if (pair_ntokens >= PAIR_MAX_TOKENS) { pthread_mutex_unlock(&pair_mu); return -409; }
  char token[PAIR_TOKEN_HEX + 1];
  util_rand_hex(token, PAIR_TOKEN_HEX);
  memcpy(pair_tokens[pair_ntokens], token, sizeof token);
  pair_ntokens++;
  pair_strikes = 0;
  if (persist_locked() != 0) { pair_ntokens--; pthread_mutex_unlock(&pair_mu); return -503; }
  pthread_mutex_unlock(&pair_mu);
  if (token_out && cap) xstrlcpy(token_out, token, cap);
  return 0;
}

int pairing_token_valid(const char *token) {
  if (!is_hex64(token)) return 0;
  int ok = 0;
  pthread_mutex_lock(&pair_mu);
  for (int i = 0; i < pair_ntokens; i++) if (ct_eq(token, pair_tokens[i], PAIR_TOKEN_HEX)) ok = 1;
  pthread_mutex_unlock(&pair_mu);
  return ok;
}

int pairing_ensure_token(char *token_out, size_t cap) {
  if (!token_out || !cap) return -1;
  token_out[0] = 0;
  pthread_mutex_lock(&pair_mu);
  if (pair_ntokens == 0) {
    char token[PAIR_TOKEN_HEX + 1];
    util_rand_hex(token, PAIR_TOKEN_HEX);
    memcpy(pair_tokens[0], token, sizeof token);
    pair_ntokens = 1;
    if (persist_locked() != 0) { pair_ntokens = 0; pthread_mutex_unlock(&pair_mu); return -1; }
  }
  xstrlcpy(token_out, pair_tokens[0], cap);
  pthread_mutex_unlock(&pair_mu);
  return 0;
}
