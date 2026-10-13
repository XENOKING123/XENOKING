/*
 * sha256.h — FIPS 180-4 SHA-256, streaming API (download verification,
 * self-update verification, ETag-less tail checks).
 */
#ifndef XENO_SHA256_H
#define XENO_SHA256_H

#include <stddef.h>
#include <stdint.h>

typedef struct sha256_ctx {
  uint32_t h[8];
  uint64_t len;
  uint8_t buf[64];
  size_t buf_len;
} sha256_ctx;

void sha256_init(sha256_ctx *c);
void sha256_update(sha256_ctx *c, const void *data, size_t n);
void sha256_final(sha256_ctx *c, uint8_t out[32]);
/* One-shot helpers. hex_out needs 65 bytes. */
void sha256_hex(const void *data, size_t n, char hex_out[65]);
void sha256_digest_hex(const uint8_t digest[32], char hex_out[65]);

#endif
