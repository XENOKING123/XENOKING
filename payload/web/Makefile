# XENO TOOL Web — on-console web server ELF (xeno-web.elf).
# Builds a single, standalone PS5 ELF that serves the full React UI
# (embedded from client/dist) over HTTP and pops a toast with its URL.

ifdef PS5_PAYLOAD_SDK
    include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk
else
    $(error PS5_PAYLOAD_SDK is undefined)
endif

ELF     := xeno-web.elf
VERSION := $(shell tr -d '[:space:]' < ../../VERSION)
DIST    := ../../client/dist

GEN_C := web_assets.c
GEN_H := web_assets.h

INCLUDES := -I.
CFLAGS   := -Wall -Wextra -Werror -g $(INCLUDES) -DXENO_WEB_VERSION='"$(VERSION)"'

SRCS := websrv.c $(GEN_C)

all: $(ELF) $(ELF).gz

# Embed the built React UI. Regenerated whenever the dist's index.html
# changes (a fresh `npm run build:vite` rewrites all hashed assets).
$(GEN_C) $(GEN_H): gen_web_assets.py $(DIST)/index.html
	python3 gen_web_assets.py $(DIST) $(GEN_C) $(GEN_H)

$(ELF): $(SRCS) $(GEN_H)
	$(CC) $(CFLAGS) -o $@ $(SRCS)

# Gzipped copy (matches the main payload convention) so non-PS5 bundlers
# treat it as data, and for a smaller release download.
$(ELF).gz: $(ELF)
	gzip -kf $<

clean:
	rm -f $(ELF) $(ELF).gz $(GEN_C) $(GEN_H)

.PHONY: all clean
