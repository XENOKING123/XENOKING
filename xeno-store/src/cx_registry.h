/*
 * cx_registry.h — PS5 system registry (sceRegMgr) wrappers.
 *
 * Ported from this repository's payload/src/sys_registry.c (ps5upload,
 * GPL-3.0). Every symbol is resolved with dlsym(RTLD_DEFAULT) because
 * libSceRegMgr.sprx is loaded indirectly on some firmwares; a missing symbol
 * yields CX_REG_ERR_NO_SYMBOL instead of a crash. The host build keeps a
 * simulated registry in <data>/sim/registry.json so the accounts flow is
 * testable end-to-end.
 */
#ifndef XENO_CX_REGISTRY_H
#define XENO_CX_REGISTRY_H

#include <stddef.h>
#include <stdint.h>

#define CX_REG_ERR_NULL_ARG 0xE0003001U
#define CX_REG_ERR_NO_SYMBOL 0xE0003002U
#define CX_REG_ERR_BUFFER_TOO_SMALL 0xE0003003U

int cx_reg_get_int(uint32_t key, int *out, uint32_t *err);
int cx_reg_set_int(uint32_t key, int val, uint32_t *err);
int cx_reg_get_str(uint32_t key, char *buf, size_t cap, uint32_t *err);
int cx_reg_set_str(uint32_t key, const char *buf, size_t len, uint32_t *err);
int cx_reg_get_bin(uint32_t key, void *buf, size_t cap, uint32_t *err);
int cx_reg_set_bin(uint32_t key, const void *buf, size_t len, uint32_t *err);
/* 1 when the get/set symbols resolved (always 1 on the host simulation). */
int cx_reg_available(void);

#endif
