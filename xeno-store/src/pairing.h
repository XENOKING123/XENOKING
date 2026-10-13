/*
 * pairing.h — device pairing (SPEC §6.6, Orbit parity).
 *
 * At start a random 6-digit code is generated and shown on the console as a
 * toast; a phone proves it is in the room by entering that code and receives a
 * 64-hex bearer token (capped at 16, persisted to <data>/pairing.json). A
 * valid token lets a mutating api request through without the optional PIN.
 * All state lives here under its own mutex — settings.c is never touched.
 */
#ifndef XENO_PAIRING_H
#define XENO_PAIRING_H

#include <stddef.h>

/* Loads persisted tokens, generates the session code, shows it as a toast. */
void pairing_init(const char *data_dir);

/* The current 6-digit code (always 6 chars + NUL). */
const char *pairing_code(void);

/* POST /api/pair/show: re-shows the code as a console toast.
 * 0 shown, 1 within the 30 s cooldown (sets *retry_after to seconds left),
 * -1 the notification could not be shown. */
int pairing_show(int *retry_after);

/* Seconds until /api/pair/show may be called again (0 = ready now). */
int pairing_show_cooldown(void);

/* POST /api/pair: redeem a code for a bearer token (constant-time compare).
 * 0 and a 64-hex token in token_out (cap >= 65) on success; otherwise a
 * negated HTTP status: 429 locked out (sets *retry_after), 403 wrong code,
 * 409 all 16 slots in use, 503 could not persist. */
int pairing_redeem(const char *code, char *token_out, size_t cap, int *retry_after);

/* 1 when `token` (64 hex) matches a paired token (constant-time). */
int pairing_token_valid(const char *token);

/* /api/session (loopback only): returns a token the console browser can use,
 * creating the first one if none exists. 0 and token_out filled, or -1. */
int pairing_ensure_token(char *token_out, size_t cap);

#endif
