# xenoking-mount-once — XENO TOOL on-console mod loader
#
# Builds against the ps5-payload-dev SDK (https://github.com/ps5-payload-dev/sdk).
# Same SDK as ps5-app/. Local build:
#
#   export PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk
#   make           # -> xenoking-mount-once.elf
#
# The output ELF is sent to the PS5 :9021 by the desktop app's
# "Apply Mods Now" button, reads /data/xeno_mods/<title>/state.json, finds
# the running game's sandbox, and unionfs-mounts each active mod's top-level
# subdirs (parts/, chr/, msg/, sfx/, …) over <sandbox>/app0/<subdir>/.

ifndef PS5_PAYLOAD_SDK
    $(error PS5_PAYLOAD_SDK is not set. Install the ps5-payload-dev SDK and export it.)
endif

include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk

ELF    := xenoking-mount-once.elf
CFLAGS += -Wall -O2

.PHONY: all clean

all: $(ELF)

$(ELF): main.c
	$(CC) $(CFLAGS) -o $@ main.c $(LDADD)

clean:
	rm -f $(ELF)
