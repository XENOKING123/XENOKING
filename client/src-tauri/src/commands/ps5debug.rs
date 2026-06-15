//! ps5debug (:744) cheat apply — a faithful port of the public ps4debug
//! protocol (ps5debug is wire-compatible). EXPERIMENTAL: this writes directly
//! to the running game's memory. Offsets/values come from the local trainer
//! file (JSON/SHN). We attach to the `eboot.bin` process, resolve its
//! executable base, and write the cheat's "on" (or "off") bytes at base+offset.
//!
//! Safety (hardened — the user must never have a write crash their console):
//!   * every command's status is verified (== CMD_SUCCESS);
//!   * we only ever attach to a process named exactly `eboot.bin`, and we
//!     RE-VERIFY that pid still maps to eboot.bin immediately before writing
//!     (closes the TOCTOU window where the game exits / a pid is reused);
//!   * each patch is bounded to the REAL executable mapping size (not a loose
//!     1 GiB guess) so we can't smear bytes into libkernel/heap/guard pages;
//!   * each patch payload is length-capped (a cheat byte-patch is tiny);
//!   * nothing is written unless a matching cheat with real patches is found;
//!   * no `.unwrap()` on network-derived data and no `&str` byte-slicing that
//!     could panic — a malformed reply / trainer file returns a clean Err.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde::Serialize;

const PORT: u16 = 744;
const MAGIC: u32 = 0xFFAA_BBCC;
const CMD_PROC_LIST: u32 = 0xBDAA_0001;
const CMD_PROC_WRITE: u32 = 0xBDAA_0003;
const CMD_PROC_MAPS: u32 = 0xBDAA_0004;
const CMD_SUCCESS: u32 = 0x8000_0000;
const PROC_LIST_ENTRY: usize = 36;
const PROC_MAP_ENTRY: usize = 58;
// Realistic upper bounds on counts coming from the console — keeps the
// up-front allocation tiny and rejects an absurd remote-supplied count.
const MAX_PROCS: usize = 8_192;
const MAX_MAPS: usize = 131_072;
// Hard ceiling on a cheat offset when we couldn't measure the real mapping
// size (fallback only). 128 MiB easily covers any eboot .text/.data.
const MAX_OFFSET_FALLBACK: u64 = 0x0800_0000;
// A cheat byte-patch is a handful of bytes; refuse anything that looks like a
// runaway blob (a malformed/garbage trainer file).
const MAX_PATCH_LEN: usize = 256;

struct Dbg {
    sock: TcpStream,
}

impl Dbg {
    fn connect(ip: &str) -> Result<Self, String> {
        let addr = format!("{ip}:{PORT}");
        let sock = TcpStream::connect_timeout(
            &addr.parse().map_err(|_| format!("bad addr {addr}"))?,
            Duration::from_secs(5),
        )
        .map_err(|e| format!("ps5debug connect {addr} failed: {e} (is ps5debug/etaHEN loaded?)"))?;
        sock.set_read_timeout(Some(Duration::from_secs(8))).ok();
        sock.set_write_timeout(Some(Duration::from_secs(8))).ok();
        Ok(Self { sock })
    }

    fn header(&mut self, cmd: u32, len: u32) -> Result<(), String> {
        let mut b = Vec::with_capacity(12);
        b.extend_from_slice(&MAGIC.to_le_bytes());
        b.extend_from_slice(&cmd.to_le_bytes());
        b.extend_from_slice(&len.to_le_bytes());
        self.sock.write_all(&b).map_err(|e| format!("send: {e}"))
    }

    fn send(&mut self, data: &[u8]) -> Result<(), String> {
        self.sock.write_all(data).map_err(|e| format!("send data: {e}"))
    }

    fn recv(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; n];
        self.sock.read_exact(&mut buf).map_err(|e| format!("recv: {e}"))?;
        Ok(buf)
    }

    /// Read exactly 4 bytes as a little-endian u32 — no panics on a short /
    /// reset connection (recv already guarantees the length, but we never
    /// `.unwrap()` network data on principle).
    fn recv_u32(&mut self) -> Result<u32, String> {
        let b = self.recv(4)?;
        let arr: [u8; 4] = b.as_slice().try_into().map_err(|_| "short read".to_string())?;
        Ok(u32::from_le_bytes(arr))
    }

    fn recv_i32(&mut self) -> Result<i32, String> {
        Ok(self.recv_u32()? as i32)
    }

    fn status(&mut self) -> Result<(), String> {
        let s = self.recv_u32()?;
        if s == CMD_SUCCESS {
            Ok(())
        } else {
            Err(format!("ps5debug status 0x{s:08x}"))
        }
    }

    /// (name, pid) for every process.
    fn proc_list(&mut self) -> Result<Vec<(String, i32)>, String> {
        self.header(CMD_PROC_LIST, 0)?;
        self.status()?;
        let n = self.recv_i32()?.max(0) as usize;
        if n > MAX_PROCS {
            return Err(format!("ps5debug returned an absurd process count ({n})"));
        }
        let data = self.recv(n * PROC_LIST_ENTRY)?;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let off = i * PROC_LIST_ENTRY;
            let name = data
                .get(off..off + 32)
                .map(cstr)
                .ok_or("truncated proc entry")?;
            let pid_bytes = data.get(off + 32..off + 36).ok_or("truncated proc entry")?;
            let arr: [u8; 4] = pid_bytes.try_into().map_err(|_| "bad pid".to_string())?;
            out.push((name, i32::from_le_bytes(arr)));
        }
        Ok(out)
    }

    /// (base, size) of the process's executable mapping (first r-x / eboot
    /// mapping). `size` is the byte length of that mapping so callers can keep
    /// every write strictly inside it.
    fn exec_base(&mut self, pid: i32) -> Result<(u64, u64), String> {
        self.header(CMD_PROC_MAPS, 4)?;
        self.send(&pid.to_le_bytes())?;
        self.status()?;
        let n = self.recv_i32()?.max(0) as usize;
        if n > MAX_MAPS {
            return Err(format!("ps5debug returned an absurd map count ({n})"));
        }
        let data = self.recv(n * PROC_MAP_ENTRY)?;
        // (start, size) candidates.
        let mut first_exec: Option<(u64, u64)> = None;
        let mut named: Option<(u64, u64)> = None;
        for i in 0..n {
            let off = i * PROC_MAP_ENTRY;
            let row = data.get(off..off + PROC_MAP_ENTRY).ok_or("truncated map entry")?;
            let name = cstr(&row[0..32]).to_lowercase();
            let start = u64::from_le_bytes(row[32..40].try_into().map_err(|_| "bad start")?);
            let end = u64::from_le_bytes(row[40..48].try_into().map_err(|_| "bad end")?);
            let prot = u16::from_le_bytes(row[56..58].try_into().map_err(|_| "bad prot")?);
            let size = end.saturating_sub(start);
            if (prot & 0x4) != 0 && first_exec.is_none() {
                first_exec = Some((start, size));
            }
            if named.is_none() && (name.contains("executable") || name.ends_with("eboot.bin")) {
                named = Some((start, size));
            }
        }
        named
            .or(first_exec)
            .ok_or_else(|| "no executable mapping found".into())
    }

    fn write_mem(&mut self, pid: i32, addr: u64, data: &[u8]) -> Result<(), String> {
        if data.is_empty() || data.len() > MAX_PATCH_LEN {
            return Err(format!("refusing a {}-byte write (cap {MAX_PATCH_LEN})", data.len()));
        }
        // header(CMD_PROC_WRITE, 16) + (pid:i32, addr:u64, len:i32) + status + data + status
        self.header(CMD_PROC_WRITE, 16)?;
        let mut payload = Vec::with_capacity(16);
        payload.extend_from_slice(&pid.to_le_bytes());
        payload.extend_from_slice(&addr.to_le_bytes());
        payload.extend_from_slice(&(data.len() as i32).to_le_bytes());
        self.send(&payload)?;
        self.status()?;
        self.send(data)?;
        self.status()
    }
}

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).trim().to_string()
}

// --------------------------------------------------------------------------- //
//  trainer parsing — JSON (GoldHEN) + SHN (XML). Returns ordered cheats with
//  memory patches, in the SAME order list_trainers reports names, so the
//  frontend can apply by index.
// --------------------------------------------------------------------------- //
#[derive(Clone)]
struct Patch {
    offset: u64,
    on: Vec<u8>,
    off: Vec<u8>,
}
#[derive(Clone)]
struct Cheat {
    name: String,
    patches: Vec<Patch>,
}

fn hex_bytes(s: &str) -> Vec<u8> {
    let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    (0..clean.len() / 2)
        .filter_map(|i| u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16).ok())
        .collect()
}
fn hex_off(s: &str) -> Option<u64> {
    let t = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    let clean: String = t.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    u64::from_str_radix(&clean, 16).ok()
}

/// Read + parse a trainer file. Returns a clear Err on read failure so the UI
/// can distinguish "couldn't read the file" from "no matching cheat".
fn parse_trainer(path: &str) -> Result<Vec<Cheat>, String> {
    let txt = std::fs::read_to_string(path).map_err(|e| format!("read trainer {path}: {e}"))?;
    let lower = path.to_lowercase();
    if lower.ends_with(".json") {
        let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| format!("bad JSON: {e}"))?;
        let mut out = vec![];
        if let Some(mods) = v["mods"].as_array() {
            for m in mods {
                let name = m["name"].as_str().unwrap_or("?").to_string();
                let mut patches = vec![];
                if let Some(mem) = m["memory"].as_array() {
                    for p in mem {
                        if let Some(off) = p["offset"].as_str().and_then(hex_off) {
                            patches.push(Patch {
                                offset: off,
                                on: hex_bytes(p["on"].as_str().unwrap_or("")),
                                off: hex_bytes(p["off"].as_str().unwrap_or("")),
                            });
                        }
                    }
                }
                out.push(Cheat { name, patches });
            }
        }
        Ok(out)
    } else if lower.ends_with(".shn") {
        Ok(parse_shn(&txt))
    } else {
        Ok(vec![])
    }
}

/// Parse the SHN (XML) trainer format. Char-boundary-safe: every advance is by
/// the byte length of a matched ASCII literal via `find`, and we only ever take
/// slices at indices `find` returned (always on char boundaries). No fixed +N
/// byte hops, so non-ASCII cheat names can't trigger a slice panic.
fn parse_shn(xml: &str) -> Vec<Cheat> {
    const CHEAT_OPEN: &str = "<Cheat ";
    const CHEAT_CLOSE: &str = "</Cheat>";
    const LINE_OPEN: &str = "<Cheatline>";
    const LINE_CLOSE: &str = "</Cheatline>";
    let mut out = vec![];
    let mut rest = xml;
    while let Some(p) = rest.find(CHEAT_OPEN) {
        // Slice from the start of this <Cheat ...> tag.
        rest = &rest[p..];
        let (block, advance) = match rest.find(CHEAT_CLOSE) {
            Some(e) => (&rest[..e], e + CHEAT_CLOSE.len()),
            None => (rest, rest.len()),
        };
        let name = tag_attr(block, "Text").unwrap_or_else(|| "?".into());
        let mut patches = vec![];
        let mut lr = block;
        while let Some(lp) = lr.find(LINE_OPEN) {
            lr = &lr[lp..];
            let (line, ladv) = match lr.find(LINE_CLOSE) {
                Some(e) => (&lr[..e], e + LINE_CLOSE.len()),
                None => (lr, lr.len()),
            };
            if let Some(off) = inner(line, "Offset").and_then(|s| hex_off(&s)) {
                patches.push(Patch {
                    offset: off,
                    on: hex_bytes(&inner(line, "ValueOn").unwrap_or_default()),
                    off: hex_bytes(&inner(line, "ValueOff").unwrap_or_default()),
                });
            }
            // Advance past this </Cheatline> (or to the block end).
            lr = &lr[ladv.min(lr.len())..];
        }
        out.push(Cheat { name, patches });
        // Advance past this </Cheat> (or to the document end).
        rest = &rest[advance.min(rest.len())..];
    }
    out
}

fn tag_attr(s: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let p = s.find(&needle)? + needle.len();
    let end = s[p..].find('"')?;
    Some(s[p..p + end].to_string())
}
fn inner(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let p = s.find(&open)? + open.len();
    let end = s[p..].find(&close)?;
    Some(s[p..p + end].to_string())
}

// --------------------------------------------------------------------------- //
//  Tauri commands
// --------------------------------------------------------------------------- //
#[derive(Serialize)]
pub struct AttachInfo {
    pub ok: bool,
    pub pid: i32,
    pub message: String,
}

/// Probe ps5debug + find the running game (eboot.bin). Used by the "Attach"
/// button to show whether direct apply is available.
#[tauri::command]
pub async fn ps5debug_attach(ip: String) -> Result<AttachInfo, String> {
    let mut d = Dbg::connect(&ip)?;
    let procs = d.proc_list()?;
    let game = procs.iter().find(|(n, _)| n == "eboot.bin");
    match game {
        Some((_, pid)) => {
            let (base, size) = d.exec_base(*pid)?;
            Ok(AttachInfo {
                ok: true,
                pid: *pid,
                message: format!(
                    "attached to eboot.bin (pid {pid}, base 0x{base:x}, {} KB)",
                    size / 1024
                ),
            })
        }
        None => Ok(AttachInfo {
            ok: false,
            pid: 0,
            message: "ps5debug is up, but no game is running (no eboot.bin). Launch the game first."
                .into(),
        }),
    }
}

/// EXPERIMENTAL — apply (or revert) one cheat from a local trainer file to the
/// running game via ps5debug memory writes. `index` is the cheat's position in
/// the file (matches the name order shown in the UI). Returns the resolved
/// cheat name so the UI can confirm it patched the row the user actually
/// toggled.
#[tauri::command]
pub async fn cheat_apply(
    ip: String,
    path: String,
    index: usize,
    enable: bool,
) -> Result<String, String> {
    let cheats = parse_trainer(&path)?;
    let cheat = cheats
        .get(index)
        .ok_or_else(|| "cheat not found (only JSON/SHN trainers support direct apply yet)".to_string())?;
    if cheat.patches.is_empty() {
        return Err(format!("'{}' has no memory patches in this file", cheat.name));
    }

    let mut d = Dbg::connect(&ip)?;
    let (_, pid) = d
        .proc_list()?
        .into_iter()
        .find(|(n, _)| n == "eboot.bin")
        .ok_or_else(|| "no game running (no eboot.bin process)".to_string())?;
    let (base, size) = d.exec_base(pid)?;

    // Validate EVERY patch against the real executable mapping BEFORE writing a
    // single byte — refuse the whole cheat if any patch is out of range or
    // over-long, so we never half-apply or smear bytes past the mapping.
    let limit = if size > 0 { size } else { MAX_OFFSET_FALLBACK };
    for p in &cheat.patches {
        let bytes = if enable { &p.on } else { &p.off };
        if bytes.is_empty() {
            continue;
        }
        if bytes.len() > MAX_PATCH_LEN {
            return Err(format!(
                "'{}' has a {}-byte patch — refusing (looks malformed)",
                cheat.name,
                bytes.len()
            ));
        }
        let end = p.offset.saturating_add(bytes.len() as u64);
        if p.offset >= limit || end > limit {
            return Err(format!(
                "offset 0x{:x} (+{}) is outside the game's code mapping (0x{:x}) — refusing to write",
                p.offset,
                bytes.len(),
                limit
            ));
        }
    }

    // TOCTOU guard: re-confirm the pid still belongs to eboot.bin right before
    // writing. If the user closed the game between attach and now, abort
    // cleanly instead of writing into a dead/reused pid.
    let still_running = d
        .proc_list()?
        .into_iter()
        .any(|(n, p)| p == pid && n == "eboot.bin");
    if !still_running {
        return Err("the game stopped running — not writing (relaunch it and re-attach)".into());
    }

    let mut wrote = 0;
    for p in &cheat.patches {
        let bytes = if enable { &p.on } else { &p.off };
        if bytes.is_empty() {
            continue;
        }
        d.write_mem(pid, base + p.offset, bytes)?;
        wrote += 1;
    }
    Ok(format!(
        "{} '{}' ({} write{})",
        if enable { "enabled" } else { "disabled" },
        cheat.name,
        wrote,
        if wrote == 1 { "" } else { "s" }
    ))
}
