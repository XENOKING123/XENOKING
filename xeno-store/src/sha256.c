/*
 * sha256.c — straightforward portable implementation (no SIMD); ~300 MB/s on
 * the console's Zen 2, which is far above any download speed.
 */
#include "sha256.h"

#include <string.h>

static const uint32_t K[64] = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void transform(uint32_t h[8], const uint8_t blk[64]) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = (uint32_t)blk[i * 4] << 24 | (uint32_t)blk[i * 4 + 1] << 16 |
           (uint32_t)blk[i * 4 + 2] << 8 | blk[i * 4 + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ROTR(w[i - 15], 7) ^ ROTR(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = ROTR(w[i - 2], 17) ^ ROTR(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = hh + S1 + ch + K[i] + w[i];
    uint32_t S0 = ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = S0 + maj;
    hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

void sha256_init(sha256_ctx *c) {
  static const uint32_t iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  memcpy(c->h, iv, sizeof iv);
  c->len = 0;
  c->buf_len = 0;
}

void sha256_update(sha256_ctx *c, const void *data, size_t n) {
  const uint8_t *p = data;
  c->len += n;
  if (c->buf_len) {
    size_t take = 64 - c->buf_len;
    if (take > n) take = n;
    memcpy(c->buf + c->buf_len, p, take);
    c->buf_len += take;
    p += take;
    n -= take;
    if (c->buf_len == 64) { transform(c->h, c->buf); c->buf_len = 0; }
  }
  while (n >= 64) { transform(c->h, p); p += 64; n -= 64; }
  if (n) { memcpy(c->buf, p, n); c->buf_len = n; }
}

void sha256_final(sha256_ctx *c, uint8_t out[32]) {
  uint64_t bits = c->len * 8;
  uint8_t pad = 0x80;
  uint8_t zero = 0;
  uint8_t lenb[8];
  sha256_update(c, &pad, 1);
  while (c->buf_len != 56) sha256_update(c, &zero, 1);
  for (int i = 0; i < 8; i++) lenb[i] = (uint8_t)(bits >> (56 - 8 * i));
  sha256_update(c, lenb, 8);   /* completes the final block and transforms it */
  for (int i = 0; i < 8; i++) {
    out[i * 4] = (uint8_t)(c->h[i] >> 24);
    out[i * 4 + 1] = (uint8_t)(c->h[i] >> 16);
    out[i * 4 + 2] = (uint8_t)(c->h[i] >> 8);
    out[i * 4 + 3] = (uint8_t)c->h[i];
  }
}

void sha256_digest_hex(const uint8_t digest[32], char hex_out[65]) {
  static const char hexd[] = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    hex_out[i * 2] = hexd[digest[i] >> 4];
    hex_out[i * 2 + 1] = hexd[digest[i] & 15];
  }
  hex_out[64] = 0;
}

void sha256_hex(const void *data, size_t n, char hex_out[65]) {
  sha256_ctx c;
  uint8_t d[32];
  sha256_init(&c);
  sha256_update(&c, data, n);
  sha256_final(&c, d);
  sha256_digest_hex(d, hex_out);
}
