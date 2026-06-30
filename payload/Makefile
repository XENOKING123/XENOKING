PS5_HOST ?= 192.168.137.2
PS5_PORT ?= 9021

ifdef PS5_PAYLOAD_SDK
    include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk
else
    $(error PS5_PAYLOAD_SDK is undefined)
endif

ELF := ps5upload.elf

BLAKE3_DIR := third_party/blake3
# Use the SIMD dispatcher + all x86-64 assembly backends (SSE2/SSE4.1/AVX2/AVX512).
# Zen 2 (PS5) supports through AVX2; dispatcher picks best at runtime.
# Portable falls back on unsupported hardware.
BLAKE3_SRCS := $(BLAKE3_DIR)/blake3.c \
               $(BLAKE3_DIR)/blake3_portable.c \
               $(BLAKE3_DIR)/blake3_dispatch.c \
               $(BLAKE3_DIR)/blake3_sse2_x86-64_unix.S \
               $(BLAKE3_DIR)/blake3_sse41_x86-64_unix.S \
               $(BLAKE3_DIR)/blake3_avx2_x86-64_unix.S \
               $(BLAKE3_DIR)/blake3_avx512_x86-64_unix.S

INCLUDES := -Iinclude -I$(BLAKE3_DIR)
CFLAGS := -Wall -Wextra -Werror -g $(INCLUDES)

# Sony sprx linkage. The payload calls sceLncUtilLaunchApp +
# sceKernelGetCpuTemperature etc., and rtld must run those
# libraries' init functions before main() invokes them. With
# compile-time linkage (DT_NEEDED entries here), the rtld walks
# init order correctly. An earlier dlopen-at-runtime path wedged
# on FW 9.60 because some Sony APIs reach into per-library
# internal state that gets initialised lazily — by the time we
# called the API, the state hadn't been built yet.
#
# register.c keeps its dlsym-via-RTLD_DEFAULT resolution as a
# backstop: on a firmware where one of these libraries fails to
# load, dlsym returns NULL for the missing symbols and the
# affected handler returns a clear "service_unavailable" error
# instead of crashing. Belt-and-braces.
# Compile-time linkage: ONLY libraries we know are present on every
# supported PS5 firmware. A missing DT_NEEDED entry makes rtld refuse
# to load the binary at all (no toast, no port bind, loader silently
# rejects the ELF — exact symptom we hit when the previous build
# added libSceFsInternalForVsh / libSceNet / libSceSysCore here).
# Optional features (sceFsMountGamePkg, sceNetGetIfList, etc.)
# dlopen their backing SPRX at runtime — missing SPRX → handler
# returns "service_unavailable" instead of bricking the payload.
#
# `-lkernel_sys` enables compile-time NID resolution for sceKernel* symbols
# (sceKernelGetCpuTemperature / sceKernelGetSocSensorTemperature /
# sceKernelGetCpuFrequency / sceKernelGetSocPowerConsumption). The older path
# used `dlsym(RTLD_DEFAULT, "sceKernelGetCpuTemperature")` which fails on FW
# points where libkernel exports NID-only, then fell back to ptrace-into-
# SceShellUI — which destabilises the console (screen blank, occasional
# power-off). Direct compile-time linkage gives stable per-call sensor reads
# with no ptrace dance. libkernel_sys.sprx is part of every supported PS5
# firmware so adding the DT_NEEDED entry is safe.
LIBS := -lSceSystemService -lSceUserService -lSceAppInstUtil -lSceNotification \
        -lkernel_sys

SRCS := src/main.c src/runtime.c src/takeover.c src/register.c src/hw_info.c \
        src/proc_list.c src/ptrace_remote.c src/shellui_rpc.c src/bgft.c \
        src/sony_api_lock.c src/kernel_rw_lock.c src/sys_time.c \
        src/sys_registry.c src/smp_meta.c src/profile.c \
        $(BLAKE3_SRCS)

# Headers as Make prerequisites so editing a .h triggers a rebuild. This
# is belt-and-braces given the recipe below re-compiles every .c every
# time, but it guards against the one case where the build system
# otherwise misses: `touch include/foo.h` alone, with no .c change.
HEADERS := $(wildcard include/*.h) $(wildcard $(BLAKE3_DIR)/*.h)

all: $(ELF) $(ELF).gz

$(ELF): $(SRCS) $(HEADERS)
	$(CC) $(CFLAGS) -o $@ $(SRCS) $(LIBS)

# ── XENO-AIO.elf: the full payload PLUS the embedded web server. One
#    ELF the user injects to get the FTX2 servers (desktop app) AND a
#    browser UI at :6969 that proxies to the in-process mgmt server for
#    real console data. Built with `make aio`; deliberately NOT part of
#    `all`, so ps5upload.elf (embedded in the desktop exe) stays lean and
#    free of the ~3 MB web bundle. ────────────────────────────────────
WEB_DIR   := web
WEB_DIST  := ../client/dist
WEB_GEN_C := $(WEB_DIR)/web_assets.c
WEB_GEN_H := $(WEB_DIR)/web_assets.h
AIO_ELF   := XENO-AIO.elf

aio: $(AIO_ELF) $(AIO_ELF).gz

# Embed the built React UI (regenerated when dist's index.html changes).
$(WEB_GEN_C) $(WEB_GEN_H): $(WEB_DIR)/gen_web_assets.py $(WEB_DIST)/index.html
	python3 $(WEB_DIR)/gen_web_assets.py $(WEB_DIST) $(WEB_GEN_C) $(WEB_GEN_H)

$(AIO_ELF): $(SRCS) $(WEB_DIR)/websrv.c $(WEB_GEN_C) $(HEADERS) $(WEB_DIR)/websrv.h $(WEB_GEN_H)
	$(CC) $(CFLAGS) -DWITH_WEBSRV -I$(WEB_DIR) -o $@ $(SRCS) $(WEB_DIR)/websrv.c $(WEB_GEN_C) $(LIBS)

$(AIO_ELF).gz: $(AIO_ELF)
	gzip -kf $<

# Gzipped copy for the Tauri bundle resource. linuxdeploy (Linux
# AppImage bundler) walks every ELF in the AppDir and tries to
# resolve its .so deps via `patchelf --print-needed`. The PS5
# payload's FreeBSD ELF depends on PS5 sprx modules that can never
# exist on Linux, so linuxdeploy aborts the build. The .gz form
# shows gzip magic (`\x1f\x8b`) instead of ELF magic — bundler sees
# a regular data file and ships it as a resource. The host decompresses
# on first use (probes.rs::find_bundled_payload).
$(ELF).gz: $(ELF)
	gzip -kf $<

clean:
	rm -f $(ELF) $(ELF).gz $(AIO_ELF) $(AIO_ELF).gz $(WEB_GEN_C) $(WEB_GEN_H)

send: $(ELF)
	@echo "Sending $(ELF) to $(PS5_HOST):$(PS5_PORT) ..."
	nc -w 1 $(PS5_HOST) $(PS5_PORT) < $(ELF)
	@echo "Sent — wait for PS5 notification before testing"

.PHONY: all aio clean send
