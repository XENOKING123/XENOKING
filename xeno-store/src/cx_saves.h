/*
 * cx_saves.h — saves hub (SPEC §17.17): list saves per user, backup to zip
 * (background job), restore with automatic pre-backup, transfer between
 * profiles, list backups on every drive.
 */
#ifndef XENO_CX_SAVES_H
#define XENO_CX_SAVES_H

#include "json.h"
#include <stddef.h>
#include <stdint.h>

void cx_saves_init(void);
/* Writes "users": [{id,name,foreground}]. */
void cx_saves_users_json(jw *w);
/* Writes "saves": [...] for a user (0 = foreground). */
int cx_saves_list_json(uint32_t uid, jw *w, char *err, size_t errcap);
/* Directory that receives backups: <root>/xeno-store/saves (root = saves.backupRoot or default). */
void cx_saves_backup_dir(char *out, size_t cap);
/* Starts a backup job; writes the job id. all=1 starts one job per title and
 * writes "jobs": [ids]. Returns 0 or -1 with code/err. */
int cx_saves_backup_start(uint32_t uid, const char *titleId, const char *kind, char *job_id, size_t idcap, char *code, size_t ccap, char *err, size_t errcap);
int cx_saves_backup_all(uint32_t uid, jw *w, char *err, size_t errcap);
/* Writes "backups": [...] from every root. */
void cx_saves_backups_json(jw *w);
/* 1 when zipPath is a backup/export/community zip below a known root. */
int cx_saves_zip_allowed(const char *zipPath);
int cx_saves_restore(uint32_t uid, const char *zipPath, int overwrite, jw *w, char *code, size_t ccap, char *err, size_t errcap);
int cx_saves_transfer(uint32_t from, uint32_t to, const char *titleId, const char *kind, int move, jw *w, char *code, size_t ccap, char *err, size_t errcap);
/* Lists the save directory names of a title (image files and sce_sys subdirectories). */
int cx_saves_dirnames(const char *title_dir, char (*out)[32], int max);

#endif
