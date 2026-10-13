# XENO STORE — build system (SPEC §2). Run every target from xeno-store/.
#
#   make web      node web/build.mjs            -> web/dist/index.html
#   make catalog  tools/catalog/build_catalog.py -> catalog/xeno-catalog.json
#   make assets   tools/gen_assets.py            -> src/assets.h
#   make host     host binary build/host/xeno-store (-DXENO_HOST=1, OpenSSL if found)
#   make test     host build + tests/host/run.sh
#   make ps5      xeno-store.elf + xeno-store-browser.elf (needs PS5_PAYLOAD_SDK)
#   make pkg      tools/make_homebrew.py          -> dist/XENO-STORE/ + zip
#   make ffpkg    tools/make_ffpkg.py             -> dist/XENO-STORE.pkg (needs fpkg_build)
#   make launcher app/build_launcher.sh          -> app/dist/xeno-store-launcher.elf (needs PS5_PAYLOAD_SDK)
#   make all      web catalog assets ps5 pkg
#   make clean

VERSION := $(shell cat VERSION 2>/dev/null || echo 0.0.0)
PYTHON  ?= python3
NODE    ?= node

SRC_DIR   := src
BUILD_DIR := build
ASSETS    := $(SRC_DIR)/assets.h

# Every src/*.c is built except the two transport backends, which are picked per target.
COMMON_SRCS := $(filter-out http_posix.c http_sce.c,$(sort $(notdir $(wildcard $(SRC_DIR)/*.c))))
HOST_SRCS   := $(COMMON_SRCS) http_posix.c
PS5_SRCS    := $(COMMON_SRCS) http_sce.c
HEADERS     := $(wildcard $(SRC_DIR)/*.h)

BASE_CFLAGS := -std=gnu11 -Wall -Wextra -Werror -O2 -fstack-protector-strong -D_FILE_OFFSET_BITS=64 -DXENO_VERSION=\"$(VERSION)\"

# ---- host --------------------------------------------------------------------
HOST_CC     ?= cc
HOST_CFLAGS := $(BASE_CFLAGS) -DXENO_HOST=1 -D_GNU_SOURCE -pthread
HOST_LDLIBS := -lpthread -lm
# gcc's -Wformat-truncation fires on intentionally bounded snprintf() chains;
# only add the opt-out when the compiler knows the flag (clang does not).
HOST_CFLAGS += $(shell echo 'int main(void){return 0;}' | $(HOST_CC) -Werror -Wno-format-truncation -x c -c -o /dev/null - >/dev/null 2>&1 && echo -Wno-format-truncation)
ifeq ($(shell pkg-config --exists openssl && echo yes),yes)
  HOST_CFLAGS += -DXENO_HAVE_OPENSSL=1 $(shell pkg-config --cflags openssl)
  HOST_LDLIBS += $(shell pkg-config --libs openssl)
endif
HOST_OBJS := $(addprefix $(BUILD_DIR)/host/,$(HOST_SRCS:.c=.o))
HOST_BIN  := $(BUILD_DIR)/host/xeno-store

# ---- ps5 ---------------------------------------------------------------------
# The library set mirrors this repo's proven payloads (payload/Makefile and
# payload/dpi/Makefile): every one is a DT_NEEDED entry, because a payload whose
# dependency graph rtld cannot resolve is rejected silently at load time.
# --no-as-needed keeps them all, including libSceNotification and the libSceNet
# the SDK wrapper appends, exactly as before.
# libSceIpmi is the one addition: launcher_icon.c resolves libSceAppInstUtil's
# title installer by NID at runtime, and that path needs libSceIpmi loaded even
# though no symbol is referenced directly. PS5_LIBS is used only by the PS5 link
# rules, so the host build never sees it.
PS5_LIBS := -Wl,--no-as-needed -lSceSystemService -lSceUserService -lSceIpmi -lSceAppInstUtil -lSceNotification -lkernel_sys
ELF         := xeno-store.elf
ELF_BROWSER := xeno-store-browser.elf

.PHONY: all web catalog assets host test ps5 ps5-check pkg ffpkg launcher clean distclean

all: web catalog assets ps5 pkg

web:
	$(NODE) web/build.mjs

catalog:
	$(PYTHON) tools/catalog/build_catalog.py --offline
	$(PYTHON) tools/catalog/build_catalog.py --validate

assets:
	$(PYTHON) tools/gen_assets.py

# Only rebuilt when missing; 'assets' (above) regenerates on demand and leaves
# the file untouched when nothing embedded changed, so objects stay fresh.
$(ASSETS):
	$(PYTHON) tools/gen_assets.py

# ---- host build --------------------------------------------------------------
host: assets $(HOST_BIN)

$(HOST_BIN): $(HOST_OBJS)
	$(HOST_CC) $(HOST_CFLAGS) -o $@ $(HOST_OBJS) $(HOST_LDLIBS)
	@echo "host binary: $@"

$(BUILD_DIR)/host/%.o: $(SRC_DIR)/%.c $(HEADERS) $(ASSETS)
	@mkdir -p $(dir $@)
	$(HOST_CC) $(HOST_CFLAGS) -c -o $@ $<

test: host
	tests/host/run.sh

# Compile-only check of every PS5 translation unit (no link); handy without a full SDK link.
ps5-check: assets
ifndef PS5_PAYLOAD_SDK
	$(error PS5_PAYLOAD_SDK is not set)
endif
	$(MAKE) PS5_PAYLOAD_SDK=$(PS5_PAYLOAD_SDK) $(addprefix $(BUILD_DIR)/ps5/,$(PS5_SRCS:.c=.o))

# ---- PS5 build ---------------------------------------------------------------
ps5: assets
ifndef PS5_PAYLOAD_SDK
	$(error PS5_PAYLOAD_SDK is not set — export it to the ps5-payload-dev SDK directory)
endif
	$(MAKE) PS5_PAYLOAD_SDK=$(PS5_PAYLOAD_SDK) $(ELF) $(ELF_BROWSER)

ifdef PS5_PAYLOAD_SDK
include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk
PS5_CFLAGS := $(BASE_CFLAGS)
PS5_OBJS         := $(addprefix $(BUILD_DIR)/ps5/,$(PS5_SRCS:.c=.o))
PS5_BROWSER_OBJS := $(addprefix $(BUILD_DIR)/ps5-browser/,$(PS5_SRCS:.c=.o))

$(ELF): $(PS5_OBJS)
	$(CC) $(PS5_CFLAGS) -o $@ $(PS5_OBJS) $(PS5_LIBS)
	@echo "payload: $@"

$(ELF_BROWSER): $(PS5_BROWSER_OBJS)
	$(CC) $(PS5_CFLAGS) -DLAUNCH_BROWSER -o $@ $(PS5_BROWSER_OBJS) $(PS5_LIBS)
	@echo "payload: $@"

$(BUILD_DIR)/ps5/%.o: $(SRC_DIR)/%.c $(HEADERS) $(ASSETS)
	@mkdir -p $(dir $@)
	$(CC) $(PS5_CFLAGS) -c -o $@ $<

$(BUILD_DIR)/ps5-browser/%.o: $(SRC_DIR)/%.c $(HEADERS) $(ASSETS)
	@mkdir -p $(dir $@)
	$(CC) $(PS5_CFLAGS) -DLAUNCH_BROWSER -c -o $@ $<
endif

# ---- packaging ---------------------------------------------------------------
pkg:
	$(PYTHON) tools/make_homebrew.py

# Installable .pkg built by ps5upload's fpkg_build. Skips cleanly (exit 3) when
# the builder is not available, so 'make ffpkg' never breaks a build without it.
ffpkg:
	@$(PYTHON) tools/make_ffpkg.py; rc=$$?; \
	  if [ $$rc -eq 3 ]; then echo "make: ffpkg skipped — fpkg_build not found (set \$$XENO_FPKG_BUILD or pass --fpkg)"; \
	  elif [ $$rc -ne 0 ]; then exit $$rc; fi

# App-launcher ELF (eboot for the .pkg): probes the store, starts it via the ELF
# loader if needed, then opens the browser. Server-only link set.
launcher:
ifndef PS5_PAYLOAD_SDK
	$(error PS5_PAYLOAD_SDK is not set — export it to the ps5-payload-dev SDK directory)
endif
	PS5_PAYLOAD_SDK=$(PS5_PAYLOAD_SDK) app/build_launcher.sh

# 'clean' removes the payload build outputs; web/dist belongs to 'make web'
# (and the UI builders working in parallel), so only 'distclean' removes it.
clean:
	rm -rf $(BUILD_DIR) $(ELF) $(ELF_BROWSER) $(ASSETS) dist app/dist

distclean: clean
	rm -rf web/dist
