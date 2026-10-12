/*
 * json.c — see json.h.
 *
 * Reader design: one node per value; strings and number literals point into a
 * private copy of the text (strings are unescaped in place, which never grows
 * them). Children are linked through `first`/`next`, so arrays iterate in O(n)
 * and object lookups are linear — fine for the catalog's small objects.
 */
#include "json.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- writer ------------------------------------------------------------- */

static int jw_reserve(jw *w, size_t extra) {
  if (w->err) return -1;
  if (w->len + extra + 1 <= w->cap) return 0;
  size_t ncap = w->cap ? w->cap * 2 : 1024;
  while (ncap < w->len + extra + 1) ncap *= 2;
  char *nb = realloc(w->buf, ncap);
  if (!nb) { w->err = 1; return -1; }
  w->buf = nb;
  w->cap = ncap;
  return 0;
}

static void jw_put(jw *w, const char *s, size_t n) {
  if (jw_reserve(w, n) != 0) return;
  memcpy(w->buf + w->len, s, n);
  w->len += n;
  w->buf[w->len] = 0;
}

static void jw_sep(jw *w) {
  /* Insert a comma unless this is the first element at the current depth. */
  if (w->depth > 0 && w->depth <= 64) {
    if (!w->first[w->depth - 1]) jw_put(w, ",", 1);
    w->first[w->depth - 1] = 0;
  }
}

void jw_init(jw *w) { memset(w, 0, sizeof *w); }
void jw_free(jw *w) { free(w->buf); memset(w, 0, sizeof *w); }

static void jw_open(jw *w, char c) {
  jw_sep(w);
  jw_put(w, &c, 1);
  if (w->depth < 64) w->first[w->depth] = 1;
  w->depth++;
}

static void jw_close(jw *w, char c) {
  if (w->depth > 0) w->depth--;
  jw_put(w, &c, 1);
}

void jw_obj_begin(jw *w) { jw_open(w, '{'); }
void jw_obj_end(jw *w) { jw_close(w, '}'); }
void jw_arr_begin(jw *w) { jw_open(w, '['); }
void jw_arr_end(jw *w) { jw_close(w, ']'); }

static void jw_escaped(jw *w, const char *s, size_t n) {
  static const char hexd[] = "0123456789abcdef";
  jw_put(w, "\"", 1);
  size_t run = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    const char *rep = NULL;
    char u[7];
    switch (c) {
      case '"': rep = "\\\""; break;
      case '\\': rep = "\\\\"; break;
      case '\n': rep = "\\n"; break;
      case '\r': rep = "\\r"; break;
      case '\t': rep = "\\t"; break;
      default:
        if (c < 0x20) {
          u[0] = '\\'; u[1] = 'u'; u[2] = '0'; u[3] = '0';
          u[4] = hexd[c >> 4]; u[5] = hexd[c & 15]; u[6] = 0;
          rep = u;
        }
    }
    if (rep) {
      if (run) jw_put(w, s + i - run, run);
      run = 0;
      jw_put(w, rep, strlen(rep));
    } else {
      run++;
    }
  }
  if (run) jw_put(w, s + n - run, run);
  jw_put(w, "\"", 1);
}

void jw_key(jw *w, const char *key) {
  jw_sep(w);
  jw_escaped(w, key, strlen(key));
  jw_put(w, ":", 1);
  /* the value that follows must not emit a comma */
  if (w->depth > 0 && w->depth <= 64) w->first[w->depth - 1] = 1;
}

void jw_strn(jw *w, const char *s, size_t n) { jw_sep(w); jw_escaped(w, s ? s : "", s ? n : 0); }
void jw_str(jw *w, const char *s) { jw_strn(w, s, s ? strlen(s) : 0); }

void jw_int(jw *w, int v) { jw_i64(w, v); }

void jw_i64(jw *w, int64_t v) {
  char tmp[32];
  int n = snprintf(tmp, sizeof tmp, "%lld", (long long)v);
  jw_sep(w);
  jw_put(w, tmp, (size_t)n);
}

void jw_double(jw *w, double v) {
  char tmp[64];
  int n;
  if (isnan(v) || isinf(v)) n = snprintf(tmp, sizeof tmp, "0");
  else if (v == floor(v) && fabs(v) < 1e15) n = snprintf(tmp, sizeof tmp, "%.0f", v);
  else n = snprintf(tmp, sizeof tmp, "%.6g", v);
  jw_sep(w);
  jw_put(w, tmp, (size_t)n);
}

void jw_bool(jw *w, int v) { jw_sep(w); if (v) jw_put(w, "true", 4); else jw_put(w, "false", 5); }
void jw_null(jw *w) { jw_sep(w); jw_put(w, "null", 4); }
void jw_raw(jw *w, const char *json, size_t n) { jw_sep(w); jw_put(w, json, n); }

void jw_kv_str(jw *w, const char *k, const char *v) { jw_key(w, k); jw_str(w, v); }
void jw_kv_int(jw *w, const char *k, int v) { jw_key(w, k); jw_int(w, v); }
void jw_kv_i64(jw *w, const char *k, int64_t v) { jw_key(w, k); jw_i64(w, v); }
void jw_kv_double(jw *w, const char *k, double v) { jw_key(w, k); jw_double(w, v); }
void jw_kv_bool(jw *w, const char *k, int v) { jw_key(w, k); jw_bool(w, v); }
void jw_kv_null(jw *w, const char *k) { jw_key(w, k); jw_null(w); }
void jw_kv_raw(jw *w, const char *k, const char *json, size_t n) { jw_key(w, k); jw_raw(w, json, n); }

char *jw_detach(jw *w, size_t *len) {
  if (w->err) { jw_free(w); return NULL; }
  if (!w->buf) { w->buf = malloc(1); if (!w->buf) return NULL; w->buf[0] = 0; }
  char *b = w->buf;
  if (len) *len = w->len;
  memset(w, 0, sizeof *w);
  return b;
}

/* ---- reader ------------------------------------------------------------- */

#define JV_NONE 0xFFFFFFFFu

typedef struct jnode {
  uint8_t type;
  uint32_t next;       /* sibling index or JV_NONE */
  uint32_t first;      /* first child (containers) */
  uint32_t count;      /* children (containers) / string length (strings) */
  const char *key;     /* object member key (unescaped, NUL-terminated) */
  const char *s;       /* string/number text (NUL-terminated) */
  int b;               /* bool value */
} jnode;

struct jdoc {
  char *text;
  jnode *nodes;
  size_t n, cap, max_nodes;
  int max_depth;
};

typedef struct parser {
  jdoc *d;
  char *p;       /* cursor into d->text (mutable: strings are unescaped in place) */
  char *end;
  int depth;
  int err;
} parser;

static uint32_t node_new(parser *ps, uint8_t type) {
  jdoc *d = ps->d;
  if (d->n >= d->max_nodes) { ps->err = 1; return JV_NONE; }
  if (d->n == d->cap) {
    size_t ncap = d->cap ? d->cap * 2 : 256;
    if (ncap > d->max_nodes) ncap = d->max_nodes;
    jnode *nn = realloc(d->nodes, ncap * sizeof *nn);
    if (!nn) { ps->err = 1; return JV_NONE; }
    d->nodes = nn;
    d->cap = ncap;
  }
  jnode *nd = &d->nodes[d->n];
  memset(nd, 0, sizeof *nd);
  nd->type = type;
  nd->next = JV_NONE;
  nd->first = JV_NONE;
  return (uint32_t)d->n++;
}

static void skip_ws(parser *ps) {
  while (ps->p < ps->end && (*ps->p == ' ' || *ps->p == '\n' || *ps->p == '\r' || *ps->p == '\t')) ps->p++;
}

static int hexval(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static size_t put_utf8(unsigned cp, char *o) {
  if (cp < 0x80) { o[0] = (char)cp; return 1; }
  if (cp < 0x800) { o[0] = (char)(0xC0 | (cp >> 6)); o[1] = (char)(0x80 | (cp & 0x3F)); return 2; }
  if (cp < 0x10000) {
    o[0] = (char)(0xE0 | (cp >> 12)); o[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    o[2] = (char)(0x80 | (cp & 0x3F)); return 3;
  }
  o[0] = (char)(0xF0 | (cp >> 18)); o[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  o[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); o[3] = (char)(0x80 | (cp & 0x3F)); return 4;
}

/* Parses a string starting at the opening quote; unescapes in place and
 * returns the start pointer (NUL-terminated) or NULL. *len receives length. */
static char *parse_string(parser *ps, size_t *len) {
  if (ps->p >= ps->end || *ps->p != '"') return NULL;
  char *start = ++ps->p;
  char *w = start;
  while (ps->p < ps->end) {
    unsigned char c = (unsigned char)*ps->p;
    if (c == '"') {
      ps->p++;
      *w = 0;
      *len = (size_t)(w - start);
      return start;
    }
    if (c < 0x20) return NULL;
    if (c != '\\') { *w++ = (char)c; ps->p++; continue; }
    ps->p++;
    if (ps->p >= ps->end) return NULL;
    char e = *ps->p++;
    switch (e) {
      case '"': *w++ = '"'; break;
      case '\\': *w++ = '\\'; break;
      case '/': *w++ = '/'; break;
      case 'b': *w++ = '\b'; break;
      case 'f': *w++ = '\f'; break;
      case 'n': *w++ = '\n'; break;
      case 'r': *w++ = '\r'; break;
      case 't': *w++ = '\t'; break;
      case 'u': {
        if (ps->end - ps->p < 4) return NULL;
        unsigned cp = 0;
        for (int i = 0; i < 4; i++) {
          int h = hexval(ps->p[i]);
          if (h < 0) return NULL;
          cp = (cp << 4) | (unsigned)h;
        }
        ps->p += 4;
        if (cp >= 0xD800 && cp <= 0xDBFF && ps->end - ps->p >= 6 && ps->p[0] == '\\' && ps->p[1] == 'u') {
          unsigned lo = 0;
          int okk = 1;
          for (int i = 0; i < 4; i++) {
            int h = hexval(ps->p[2 + i]);
            if (h < 0) { okk = 0; break; }
            lo = (lo << 4) | (unsigned)h;
          }
          if (okk && lo >= 0xDC00 && lo <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            ps->p += 6;
          }
        }
        if (cp == 0) cp = 0xFFFD;  /* embedded NUL would break C strings */
        w += put_utf8(cp, w);
        break;
      }
      default: return NULL;
    }
  }
  return NULL;
}

static uint32_t parse_value(parser *ps);

static uint32_t parse_container(parser *ps, uint8_t type) {
  char close = type == JV_OBJ ? '}' : ']';
  if (++ps->depth > ps->d->max_depth) { ps->err = 1; return JV_NONE; }
  uint32_t self = node_new(ps, type);
  if (self == JV_NONE) return JV_NONE;
  ps->p++;  /* opening bracket */
  uint32_t last = JV_NONE;
  uint32_t count = 0;
  skip_ws(ps);
  if (ps->p < ps->end && *ps->p == close) {
    ps->p++;
    ps->depth--;
    return self;
  }
  for (;;) {
    skip_ws(ps);
    const char *key = NULL;
    if (type == JV_OBJ) {
      size_t kl;
      key = parse_string(ps, &kl);
      if (!key) { ps->err = 1; return JV_NONE; }
      skip_ws(ps);
      if (ps->p >= ps->end || *ps->p != ':') { ps->err = 1; return JV_NONE; }
      ps->p++;
      skip_ws(ps);
    }
    uint32_t child = parse_value(ps);
    if (child == JV_NONE) { ps->err = 1; return JV_NONE; }
    ps->d->nodes[child].key = key;
    if (last == JV_NONE) ps->d->nodes[self].first = child;
    else ps->d->nodes[last].next = child;
    last = child;
    count++;
    skip_ws(ps);
    if (ps->p >= ps->end) { ps->err = 1; return JV_NONE; }
    if (*ps->p == ',') { ps->p++; continue; }
    if (*ps->p == close) { ps->p++; break; }
    ps->err = 1;
    return JV_NONE;
  }
  ps->d->nodes[self].count = count;
  ps->depth--;
  return self;
}

static uint32_t parse_value(parser *ps) {
  skip_ws(ps);
  if (ps->p >= ps->end) return JV_NONE;
  char c = *ps->p;
  if (c == '{') return parse_container(ps, JV_OBJ);
  if (c == '[') return parse_container(ps, JV_ARR);
  if (c == '"') {
    size_t len;
    char *s = parse_string(ps, &len);
    if (!s) return JV_NONE;
    uint32_t n = node_new(ps, JV_STR);
    if (n == JV_NONE) return JV_NONE;
    ps->d->nodes[n].s = s;
    ps->d->nodes[n].count = (uint32_t)len;
    return n;
  }
  if (c == 't' && ps->end - ps->p >= 4 && memcmp(ps->p, "true", 4) == 0) {
    ps->p += 4;
    uint32_t n = node_new(ps, JV_BOOL);
    if (n != JV_NONE) ps->d->nodes[n].b = 1;
    return n;
  }
  if (c == 'f' && ps->end - ps->p >= 5 && memcmp(ps->p, "false", 5) == 0) {
    ps->p += 5;
    return node_new(ps, JV_BOOL);
  }
  if (c == 'n' && ps->end - ps->p >= 4 && memcmp(ps->p, "null", 4) == 0) {
    ps->p += 4;
    return node_new(ps, JV_NULL);
  }
  if (c == '-' || (c >= '0' && c <= '9')) {
    char *start = ps->p;
    if (*ps->p == '-') ps->p++;
    while (ps->p < ps->end && ((*ps->p >= '0' && *ps->p <= '9') || *ps->p == '.' || *ps->p == 'e' ||
                                *ps->p == 'E' || *ps->p == '+' || *ps->p == '-'))
      ps->p++;
    uint32_t n = node_new(ps, JV_NUM);
    if (n == JV_NONE) return JV_NONE;
    ps->d->nodes[n].s = start;
    ps->d->nodes[n].count = (uint32_t)(ps->p - start);
    return n;
  }
  return JV_NONE;
}

jdoc *json_parse(const char *text, size_t len, size_t max_nodes, int max_depth) {
  jdoc *d = calloc(1, sizeof *d);
  if (!d) return NULL;
  d->max_nodes = max_nodes ? max_nodes : 200000;
  d->max_depth = max_depth ? max_depth : 32;
  d->text = malloc(len + 1);
  if (!d->text) { free(d); return NULL; }
  memcpy(d->text, text, len);
  d->text[len] = 0;
  parser ps = { d, d->text, d->text + len, 0, 0 };
  uint32_t root = parse_value(&ps);
  if (root != 0 || ps.err) { json_free(d); return NULL; }
  skip_ws(&ps);
  if (ps.p != ps.end) { json_free(d); return NULL; }
  /* Number literals need NUL termination for strtod: terminate them now that
   * parsing is done (the next char is always punctuation/whitespace). */
  for (size_t i = 0; i < d->n; i++) {
    if (d->nodes[i].type == JV_NUM) ((char *)d->nodes[i].s)[d->nodes[i].count] = 0;
  }
  return d;
}

void json_free(jdoc *d) {
  if (!d) return;
  free(d->nodes);
  free(d->text);
  free(d);
}

jv json_root(const jdoc *d) { jv v = { d, d && d->n ? 0 : JV_NONE }; return v; }
size_t json_node_count(const jdoc *d) { return d ? d->n : 0; }

static const jnode *N(jv v) {
  if (!v.d || v.i == JV_NONE || v.i >= v.d->n) return NULL;
  return &v.d->nodes[v.i];
}

int jv_ok(jv v) { return N(v) != NULL; }
int jv_type(jv v) { const jnode *n = N(v); return n ? n->type : JV_INVALID; }

jv jv_get(jv obj, const char *key) {
  jv none = { obj.d, JV_NONE };
  const jnode *n = N(obj);
  if (!n || n->type != JV_OBJ) return none;
  for (uint32_t i = n->first; i != JV_NONE; i = obj.d->nodes[i].next) {
    if (obj.d->nodes[i].key && strcmp(obj.d->nodes[i].key, key) == 0) { jv r = { obj.d, i }; return r; }
  }
  return none;
}

jv jv_at(jv arr, size_t idx) {
  jv none = { arr.d, JV_NONE };
  const jnode *n = N(arr);
  if (!n || (n->type != JV_ARR && n->type != JV_OBJ)) return none;
  uint32_t i = n->first;
  while (i != JV_NONE && idx--) i = arr.d->nodes[i].next;
  jv r = { arr.d, i };
  return r;
}

jv jv_first(jv c) {
  const jnode *n = N(c);
  jv r = { c.d, (n && (n->type == JV_ARR || n->type == JV_OBJ)) ? n->first : JV_NONE };
  return r;
}

jv jv_next(jv child) {
  const jnode *n = N(child);
  jv r = { child.d, n ? n->next : JV_NONE };
  return r;
}

size_t jv_len(jv c) {
  const jnode *n = N(c);
  return (n && (n->type == JV_ARR || n->type == JV_OBJ)) ? n->count : 0;
}

const char *jv_key(jv m) { const jnode *n = N(m); return n ? n->key : NULL; }

const char *jv_str(jv v, const char *dflt) {
  const jnode *n = N(v);
  return (n && n->type == JV_STR) ? n->s : dflt;
}

size_t jv_strlen(jv v) { const jnode *n = N(v); return (n && n->type == JV_STR) ? n->count : 0; }

int64_t jv_i64(jv v, int64_t dflt) {
  const jnode *n = N(v);
  if (!n) return dflt;
  if (n->type == JV_NUM) {
    if (strpbrk(n->s, ".eE")) { double d = strtod(n->s, NULL); return (int64_t)d; }
    return (int64_t)strtoll(n->s, NULL, 10);
  }
  if (n->type == JV_BOOL) return n->b;
  if (n->type == JV_STR) { int64_t x; return (n->s[0] && sscanf(n->s, "%lld", (long long *)&x) == 1) ? x : dflt; }
  return dflt;
}

double jv_dbl(jv v, double dflt) {
  const jnode *n = N(v);
  if (!n) return dflt;
  if (n->type == JV_NUM) return strtod(n->s, NULL);
  if (n->type == JV_BOOL) return n->b;
  return dflt;
}

int jv_bool(jv v, int dflt) {
  const jnode *n = N(v);
  if (!n) return dflt;
  if (n->type == JV_BOOL) return n->b;
  if (n->type == JV_NUM) return strtod(n->s, NULL) != 0.0;
  if (n->type == JV_STR) return strcmp(n->s, "true") == 0 || strcmp(n->s, "1") == 0;
  return dflt;
}

const char *jv_get_str(jv o, const char *k, const char *dflt) { return jv_str(jv_get(o, k), dflt); }
int64_t jv_get_i64(jv o, const char *k, int64_t dflt) { return jv_i64(jv_get(o, k), dflt); }
double jv_get_dbl(jv o, const char *k, double dflt) { return jv_dbl(jv_get(o, k), dflt); }
int jv_get_bool(jv o, const char *k, int dflt) { return jv_bool(jv_get(o, k), dflt); }

void jw_value(jw *w, jv v) {
  const jnode *n = N(v);
  if (!n) { jw_null(w); return; }
  switch (n->type) {
    case JV_NULL: jw_null(w); break;
    case JV_BOOL: jw_bool(w, n->b); break;
    case JV_NUM: jw_raw(w, n->s, n->count); break;
    case JV_STR: jw_strn(w, n->s, n->count); break;
    case JV_ARR:
      jw_arr_begin(w);
      JV_FOREACH(it, v) jw_value(w, it);
      jw_arr_end(w);
      break;
    case JV_OBJ:
      jw_obj_begin(w);
      JV_FOREACH(it, v) { jw_key(w, jv_key(it) ? jv_key(it) : ""); jw_value(w, it); }
      jw_obj_end(w);
      break;
    default: jw_null(w);
  }
}
