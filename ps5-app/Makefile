# XENOKING Game Store - native PS5 app
#
# Builds against the ps5-payload-dev SDK (https://github.com/ps5-payload-dev/sdk).
# The SDK tarball installs prospero-clang + the toolchain makefile to
# /opt/ps5-payload-sdk; CI sets PS5_PAYLOAD_SDK for you. To build locally:
#
#   export PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk
#   make            # -> xeno-store.elf, xeno-store-browser.elf, and the homebrew pkg
#
# Targets:
#   xeno-store.elf          server-only payload  (Send via XENO TOOL -> Payloads :9021)
#   xeno-store-browser.elf  server + auto-opens the PS5 browser  (one-tap eboot)
#   pkg                     dist/XENO-Game-Store/  homebrew app folder (logo + metadata)
#   bubble                  EXPERIMENTAL fake-signed Sony app bubble (see README)

ifndef PS5_PAYLOAD_SDK
    $(error PS5_PAYLOAD_SDK is not set. Install the ps5-payload-dev SDK and export it.)
endif

include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk

TITLE_ID    := XENO00001
ELF         := xeno-store.elf
ELF_BROWSER := xeno-store-browser.elf
CFLAGS      += -Wall -O2

# libs needed only by the browser-launching build
BROWSER_LIBS := -lSceSystemService -lSceUserService

.PHONY: all pkg bubble clean

all: $(ELF) $(ELF_BROWSER) pkg

# Regenerate the embedded assets (HTML + catalog + logo) before compiling.
assets.h: homebrew/index.html homebrew/catalog.json homebrew/logo.jpg tools/gen_assets.py
	python3 tools/gen_assets.py

# 1) server-only payload
$(ELF): main.c assets.h
	$(CC) $(CFLAGS) -o $@ main.c $(LDADD)

# 2) server + one-tap browser launch (used as the homebrew eboot.bin)
$(ELF_BROWSER): main.c assets.h
	$(CC) $(CFLAGS) -DLAUNCH_BROWSER -o $@ main.c $(BROWSER_LIBS) $(LDADD)

# 3) homebrew app package: a folder etaHEN / itemzflow show with our icon and run.
#    eboot.bin = the one-tap browser build; sce_sys/icon0.png = the XENO logo.
pkg: $(ELF_BROWSER) sce_sys/icon0.png sce_sys/param.json homebrew.json
	rm -rf dist/XENO-Game-Store
	mkdir -p dist/XENO-Game-Store/sce_sys
	cp $(ELF_BROWSER)         dist/XENO-Game-Store/eboot.bin
	cp sce_sys/icon0.png      dist/XENO-Game-Store/sce_sys/icon0.png
	cp sce_sys/param.json     dist/XENO-Game-Store/sce_sys/param.json
	cp homebrew.json          dist/XENO-Game-Store/homebrew.json
	@echo "homebrew package ready: dist/XENO-Game-Store/"

# 4) EXPERIMENTAL Sony app bubble (fake-signed). Unverified on hardware - the
#    .elf payload + homebrew pkg above are the supported paths. Needs param.sfo.
PS4_SDK_VERSION ?= 0x07590001
AUTHID   := 0x3800000000000022
AUTHINFO := 00 00 00 00 00 00 00 00 00 00 00 00 00 1C 00 40 00 FF 00 00 00 00 \
            00 80 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 80 \
            00 40 00 40 00 00 00 00 00 00 00 80 00 00 00 00 00 00 00 08 00 40 \
            FF FF 00 00 00 F0 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 \
            00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 \
            00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 \
            00 00 00 00

bubble: $(ELF_BROWSER) sce_sys/icon0.png
	rm -rf dist/bubble/$(TITLE_ID)
	mkdir -p dist/bubble/$(TITLE_ID)/sce_sys
	python3 tools/make_param_sfo.py dist/bubble/$(TITLE_ID)/sce_sys/param.sfo
	cp sce_sys/icon0.png dist/bubble/$(TITLE_ID)/sce_sys/icon0.png
	python3 make_fself.py --ptype fake --paid $(AUTHID) \
		--auth-info "$(AUTHINFO)" \
		--app-version $(PS4_SDK_VERSION) --fw-version $(PS4_SDK_VERSION) \
		$(ELF_BROWSER) dist/bubble/$(TITLE_ID)/eboot.bin
	@echo "EXPERIMENTAL bubble ready: dist/bubble/$(TITLE_ID)/"

clean:
	rm -f $(ELF) $(ELF_BROWSER) assets.h
	rm -rf dist
