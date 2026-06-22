// Plain-English mapping of CheatRunner / Rust-sidecar / reqwest error strings.
// The renderer's setErr was showing raw stack-style messages users can't act on
// (timeout strings, HTTP codes, "unsafe filename"). This funnels every known
// failure mode into a remediation a user can actually follow. Unknown errors
// fall through to the original message so debug info is never lost.

type Ctx = "reach" | "upload" | "toggle" | "state" | "apply";

const PATTERNS: Array<[RegExp, (ctx: Ctx) => string]> = [
  // ── network / reach ──────────────────────────────────────────────
  [/operation timed out|connect.* timed out|deadline/i,
    () => "PS5 didn't answer — is CheatRunner running on the console?"],
  [/unreachable|connection refused|os error 10061|os error 111/i,
    () => "Can't reach CheatRunner on this PS5. Load CheatRunner.elf first, then Refresh."],
  [/dns|name resolution|name or service not known/i,
    () => "PS5 IP address didn't resolve. Check the Connection tab."],

  // ── CheatRunner explicit JSON errors ─────────────────────────────
  [/payload[_ ]?too[_ ]?large|http 413/i,
    () => "Cheat file is too big (CheatRunner caps JSON at 2 MB and SHN/MC4 at 1 MB)."],
  [/unsupported extension/i,
    () => "Only .json, .shn, and .mc4 files can be installed. Rename your .ShnExt to .shn first."],
  [/unsafe filename/i,
    () => "Filename has characters CheatRunner refuses. Only letters, numbers, dot, dash, underscore."],
  [/apply[_ ]?in[_ ]?progress|http 429/i,
    () => "CheatRunner is busy applying another cheat — give it a second and try again."],
  [/version[_ ]?mismatch|wrong[_ ]?ver|MISMATCH/i,
    () => "Cheat is for a different game version. Open the game's actual update, or pick a matching version in CheatRunner."],
  [/baseline[_ ]?unknown/i,
    () => "CheatRunner can't read the game's memory yet — get past the splash/title screen, then try again."],
  [/crash[_ ]?suspect/i,
    () => "CheatRunner flagged this cheat after it crashed before. Clear crash flags in CheatRunner's dashboard if you want to retry."],
  [/missing filename|empty body/i,
    () => "The upload was malformed — try the file again."],

  // ── HTTP fall-throughs ───────────────────────────────────────────
  [/http 4\d\d/i,
    (ctx) => `CheatRunner rejected the ${ctx} request.`],
  [/http 5\d\d/i,
    () => "CheatRunner had an internal error. Check the console logs."],
];

export function friendlyCheatRunnerError(e: unknown, ctx: Ctx = "reach"): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  for (const [pat, mk] of PATTERNS) {
    if (pat.test(raw)) return mk(ctx);
  }
  return raw || "Unknown CheatRunner error.";
}
