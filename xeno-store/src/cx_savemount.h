/*
 * cx_savemount.h — save data engine (SPEC §17.22.3): three tiers chosen
 * automatically and reported honestly.
 *   native — PS5 SaveData API (libSceSaveData.sprx via dlopen/dlsym; needs
 *            kstuff-style save patches): mount → copy files → umount.
 *   garlic — Garlic Save Manager answering on 127.0.0.1:8082.
 *   raw    — same-console directory copy of /user/home/<uid>/savedata_prospero/<TID>/.
 * The host build simulates the native tier: a "mount" is a temp directory
 * mirrored to <title dir>/.sim/<dirName>/ on commit, so the whole import /
 * export flow runs in tests.
 */
#ifndef XENO_CX_SAVEMOUNT_H
#define XENO_CX_SAVEMOUNT_H

#include "json.h"
#include <stddef.h>
#include <stdint.h>

enum { CX_TIER_NATIVE = 0, CX_TIER_GARLIC = 1, CX_TIER_RAW = 2 };

void cx_savemount_init(void);
int cx_savemount_tier(void);                   /* best available tier */
const char *cx_tier_name(int tier);
/* Writes "tier", "detail", "native", "garlic", "raw", "simulated". */
void cx_savemount_engine_json(jw *w);

/* Save directory of a title for a user: /user/home/<uid>/savedata_prospero/<TID>
 * (PS5) or /savedata/<TID> (PS4). kind is "ps5"|"ps4"|"" (auto by title id). */
int cx_save_title_dir(uint32_t uid, const char *titleId, const char *kind, char *out, size_t cap, char *kind_out, size_t kcap);

typedef struct cx_mount {
  int tier;
  int rdwr, created;
  uint32_t uid;
  char titleId[12], dirName[32];
  char point[1024];        /* directory with the decrypted files */
  char native_point[16];   /* SceSaveDataMountPoint for umount */
  char title_dir[1024];
} cx_mount;

/* Opens a save for reading (rdwr=0) or writing (rdwr=1; create when absent).
 * Only the native tier (or its host simulation) can mount. */
int cx_savemount_open(uint32_t uid, const char *titleId, const char *dirName, int rdwr, cx_mount *m, char *err, size_t errcap);
/* Closes the mount; commit=1 keeps the changes (host sim: mirrors them back). */
int cx_savemount_close(cx_mount *m, int commit);

typedef struct cx_import_result {
  char tier[8];
  int files;
  int64_t bytes;
  char preBackup[1024];
  char accountId[20];
  char style[12];          /* decrypted | raw */
} cx_import_result;

/* Imports a save zip (xeno-save-zip, Garlic decrypted zip or an own raw
 * backup) for (uid, titleId). dirName may be "" when the zip's manifest or
 * the index row provides it. Takes a pre-backup of the current save into
 * backup_dir when backup_first. Returns 0, or -1 with code+err. */
int cx_savemount_import_zip(uint32_t uid, const char *titleId, const char *dirName, const char *zipPath,
                            int backup_first, const char *backup_dir, cx_import_result *out,
                            char *code, size_t ccap, char *err, size_t errcap);

typedef struct cx_export_result {
  char tier[8];
  char zipPath[1024];
  char sha256[65];
  int64_t size;
  int files;
  char format[20];         /* xeno-save-zip | xeno-raw-zip */
  int accountIdStripped;
  char manifest[2048];     /* JSON text */
} cx_export_result;

/* Exports (uid, titleId, dirName) to dest_zip with a manifest; strips the
 * ACCOUNT_ID from sce_sys/param.sfo (decrypted exports only). */
int cx_savemount_export(uint32_t uid, const char *titleId, const char *dirName, const char *dest_zip,
                        cx_export_result *out, char *err, size_t errcap);

/* param.sfo helpers (PSF v1.1): set/clear ACCOUNT_ID in place. 0 when found. */
int cx_sfo_set_account_id(uint8_t *buf, size_t len, uint64_t id);
int cx_sfo_get_str(const uint8_t *buf, size_t len, const char *key, char *out, size_t cap);

#endif
