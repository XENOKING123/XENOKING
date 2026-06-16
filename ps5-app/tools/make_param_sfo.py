#!/usr/bin/env python3
"""
make_param_sfo.py - generate a real PS5 param.sfo for the XENOKING Game Store app.

The SFO container format is public and simple:
  Header  : magic "\\x00PSF", version 1.1, key-table offset, data-table offset, entry count
  Index   : per entry -> key_offset(u16), fmt(u16), used_len(u32), total_len(u32), data_offset(u32)
  Keys    : null-terminated ASCII key names
  Data    : values (utf8 / utf8-special / int32) padded to total_len

fmt codes:  0x0004 = utf8-special (no NUL)   0x0204 = utf8 (NUL-terminated)   0x0404 = int32

This writes a valid param.sfo. Tweak the entries below to taste, then run:
    python make_param_sfo.py ../sce_sys/param.sfo
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

# (key, fmt, value, total_len)   total_len = reserved size on disk (PS5 uses fixed
# widths for several string keys; these match common homebrew fpkg layouts).
ENTRIES = [
    ("APP_TYPE",        0x0404, 1,                                  4),
    ("APP_VER",         0x0204, "01.00",                            8),
    ("ATTRIBUTE",       0x0404, 0,                                  4),
    ("CATEGORY",        0x0204, "gd",                               4),     # gd = game/app
    ("CONTENT_ID",      0x0204, "IV0000-XENO00001_00-XENOKINGSTORE0", 48),
    ("DOWNLOAD_DATA_SIZE", 0x0404, 0,                               4),
    ("FORMAT",          0x0204, "obs",                              4),
    ("PARENTAL_LEVEL",  0x0404, 0,                                  4),
    ("PUBTOOLINFO",     0x0204, "",                                 0x200),
    ("PUBTOOLVER",      0x0404, 0,                                  4),
    ("SYSTEM_VER",      0x0404, 0,                                  4),
    ("TITLE",           0x0204, "XENOKING Game Store",              0x80),
    ("TITLE_ID",        0x0204, "XENO00001",                        12),
    ("VERSION",         0x0204, "01.00",                            8),
]


def _encode_value(fmt: int, value, total_len: int) -> tuple[bytes, int]:
    if fmt == 0x0404:                       # int32
        return struct.pack("<I", int(value)), 4
    raw = str(value).encode("utf-8")
    if fmt == 0x0204:                       # utf8 (NUL-terminated)
        raw += b"\x00"
    used = len(raw)
    if used > total_len:
        total_len = used
    raw = raw + b"\x00" * (total_len - used)
    return raw, used


def build_sfo() -> bytes:
    # SFO requires keys sorted ascending
    entries = sorted(ENTRIES, key=lambda e: e[0])
    n = len(entries)

    key_blob = b""
    key_offsets = []
    for key, *_ in entries:
        key_offsets.append(len(key_blob))
        key_blob += key.encode("ascii") + b"\x00"
    # pad key table to 4 bytes
    key_blob += b"\x00" * ((4 - len(key_blob) % 4) % 4)

    data_blob = b""
    data_offsets = []
    used_lens = []
    total_lens = []
    for key, fmt, value, total_len in entries:
        raw, used = _encode_value(fmt, value, total_len)
        data_offsets.append(len(data_blob))
        used_lens.append(used)
        total_lens.append(len(raw))
        data_blob += raw

    header_size = 20
    index_size = 16 * n
    key_table_off = header_size + index_size
    data_table_off = key_table_off + len(key_blob)

    out = bytearray()
    out += b"\x00PSF"                                   # magic
    out += struct.pack("<I", 0x0101)                    # version 1.1
    out += struct.pack("<I", key_table_off)
    out += struct.pack("<I", data_table_off)
    out += struct.pack("<I", n)

    for i, (key, fmt, value, total_len) in enumerate(entries):
        out += struct.pack("<H", key_offsets[i])
        out += struct.pack("<H", fmt)
        out += struct.pack("<I", used_lens[i])
        out += struct.pack("<I", total_lens[i])
        out += struct.pack("<I", data_offsets[i])

    out += key_blob
    out += data_blob
    return bytes(out)


def main():
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("param.sfo")
    dest.parent.mkdir(parents=True, exist_ok=True)
    blob = build_sfo()
    dest.write_bytes(blob)
    print(f"wrote {dest}  ({len(blob)} bytes, {len(ENTRIES)} keys)")


if __name__ == "__main__":
    main()
