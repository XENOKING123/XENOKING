/*
 * json.h — tiny JSON writer + bounded DOM reader (SPEC §4.9).
 *
 * Writer (jw): a growable buffer with automatic comma handling. Every call is
 * safe after an allocation failure (jw->err is set and output is discarded).
 *
 * Reader: json_parse() copies the input once, unescapes strings in place and
 * builds a flat node array (max depth / max node count are enforced). Values
 * are addressed by jv handles that stay valid until json_free().
 */
#ifndef XENO_JSON_H
#define XENO_JSON_H

#include <stddef.h>
#include <stdint.h>

/* ---- writer ------------------------------------------------------------- */
typedef struct jw {
  char *buf;
  size_t len, cap;
  int depth;
  unsigned char first[64];  /* per depth: 1 while no element has been written yet */
  int err;
} jw;

void jw_init(jw *w);
void jw_free(jw *w);
void jw_obj_begin(jw *w);
void jw_obj_end(jw *w);
void jw_arr_begin(jw *w);
void jw_arr_end(jw *w);
void jw_key(jw *w, const char *key);
void jw_str(jw *w, const char *s);
void jw_strn(jw *w, const char *s, size_t n);
void jw_int(jw *w, int v);
void jw_i64(jw *w, int64_t v);
void jw_double(jw *w, double v);
void jw_bool(jw *w, int v);
void jw_null(jw *w);
void jw_raw(jw *w, const char *json, size_t n);   /* pre-validated JSON text */
/* key/value shortcuts */
void jw_kv_str(jw *w, const char *k, const char *v);
void jw_kv_int(jw *w, const char *k, int v);
void jw_kv_i64(jw *w, const char *k, int64_t v);
void jw_kv_double(jw *w, const char *k, double v);
void jw_kv_bool(jw *w, const char *k, int v);
void jw_kv_null(jw *w, const char *k);
void jw_kv_raw(jw *w, const char *k, const char *json, size_t n);
/* Hands over the buffer (NUL-terminated); caller frees. NULL on error. */
char *jw_detach(jw *w, size_t *len);

/* ---- reader ------------------------------------------------------------- */
enum { JV_INVALID = 0, JV_NULL, JV_BOOL, JV_NUM, JV_STR, JV_ARR, JV_OBJ };

typedef struct jdoc jdoc;
typedef struct jv { const jdoc *d; uint32_t i; } jv;

/* max_nodes 0 → 200000, max_depth 0 → 32. Returns NULL on malformed input. */
jdoc *json_parse(const char *text, size_t len, size_t max_nodes, int max_depth);
void json_free(jdoc *d);
jv json_root(const jdoc *d);
size_t json_node_count(const jdoc *d);

int jv_ok(jv v);
int jv_type(jv v);
jv jv_get(jv obj, const char *key);        /* member lookup (objects only) */
jv jv_at(jv arr, size_t idx);              /* O(n) index */
jv jv_first(jv container);                 /* first child (array or object) */
jv jv_next(jv child);                      /* next sibling */
size_t jv_len(jv container);               /* children count */
const char *jv_key(jv member);             /* key of an object member, NULL otherwise */
const char *jv_str(jv v, const char *dflt);
size_t jv_strlen(jv v);
int64_t jv_i64(jv v, int64_t dflt);
double jv_dbl(jv v, double dflt);
int jv_bool(jv v, int dflt);
/* Shortcuts: get member then coerce. */
const char *jv_get_str(jv obj, const char *key, const char *dflt);
int64_t jv_get_i64(jv obj, const char *key, int64_t dflt);
double jv_get_dbl(jv obj, const char *key, double dflt);
int jv_get_bool(jv obj, const char *key, int dflt);
/* Serializes any value back into a writer (used by export/import/merge). */
void jw_value(jw *w, jv v);

#define JV_FOREACH(it, container) for (jv it = jv_first(container); jv_ok(it); it = jv_next(it))

#endif
