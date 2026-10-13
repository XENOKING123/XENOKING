/*
 * cx_accounts.h — console users (sceUserService) and offline account
 * activation through the registry slots (SPEC §17.18).
 *
 * The slot layout, default flags, FNV id derivation and activate/clear
 * semantics come from ps5-payload-dev/offact (GPL-3.0) as vendored in this
 * repository's payload/src/profile.c; the attribution is preserved here.
 */
#ifndef XENO_CX_ACCOUNTS_H
#define XENO_CX_ACCOUNTS_H

#include "json.h"
#include <stddef.h>
#include <stdint.h>

#define CX_SLOT_COUNT 16
#define CX_PROFILE_NAME_MAX 32
#define CX_PROFILE_TYPE_MAX 17
#define CX_PROFILE_DEFAULT_FLAGS 0x1002
#define CX_MAX_USERS 16

typedef struct cx_user {
  uint32_t id;
  char name[CX_PROFILE_NAME_MAX + 1];
  int foreground;
} cx_user;

void cx_accounts_init(void);
/* Logged-in users (sceUserServiceGetLoginUserIdList); host: <data>/sim/users.json. */
int cx_users_list(cx_user *out, int max);
int cx_user_find(uint32_t id, cx_user *out);
uint32_t cx_user_foreground(void);
/* /user/home/<uid hex> (host: the simulated twin). Returns 0, or -1 when
 * the directory does not exist. */
int cx_user_home(uint32_t id, char *out, size_t cap);
/* Lowercase hex directory name used under /user/home. */
void cx_user_dirname(uint32_t id, char *out, size_t cap);

/* Registry slot ops (offact). slot is 1..16; all return 0 / -1. */
int cx_slot_get_name(int slot, char out[CX_PROFILE_NAME_MAX], uint32_t *err);
int cx_slot_get_id(int slot, uint64_t *out, uint32_t *err);
int cx_slot_get_type(int slot, char out[CX_PROFILE_TYPE_MAX], uint32_t *err);
int cx_slot_get_flags(int slot, int *out, uint32_t *err);
uint64_t cx_profile_gen_id(const char *name);
int cx_slot_activate(int slot, uint64_t id, uint32_t *err);
int cx_slot_clear(int slot, uint32_t *err);

/* JSON: writes "slots", "foregroundUser", "supported", "simulated". */
void cx_accounts_json(jw *w);
/* Account id (hex string) of a user: the activated registry id whose slot
 * name matches the user name, else "". */
void cx_user_account_id(uint32_t uid, char *out, size_t cap);
/* sceSystemServiceRequestReboot (direct-linked); host: logs only. */
int cx_reboot(void);

#endif
