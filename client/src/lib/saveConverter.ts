// Pure helpers for the Save Converter screen — search, option
// validation, readiness. Kept out of the component so they're unit-tested
// without rendering anything.

import type {
  Direction,
  GameProfile,
  OptionSpec,
} from "../api/saveConverter";

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Filter the game list by a free-text search. Every word must appear
 *  somewhere in the game's name, aliases, title IDs or Steam app id, so
 *  "mh wilds", "PPSA01234" and "2246340" all work. */
export function filterGames(games: GameProfile[], term: string): GameProfile[] {
  const words = norm(term).split(" ").filter(Boolean);
  if (words.length === 0) return games;
  return games.filter((game) => {
    const haystack = norm(
      [
        game.name,
        ...game.aliases,
        ...game.ps5.title_ids,
        game.pc.steam_app_id ?? "",
      ].join(" "),
    );
    return words.every((word) => haystack.includes(word));
  });
}

/** The options the user has to fill in for one direction. */
export function optionsFor(
  game: GameProfile,
  direction: Direction,
): OptionSpec[] {
  return game.options.filter(
    (o) => o.directions.length === 0 || o.directions.includes(direction),
  );
}

// First/last SteamID64 of an individual account: 0x0110000100000000 +
// a 32-bit account id. Mirrors `parse_steam_id64` in the Rust core, which
// is the real gate — this copy only exists to show the problem while the
// user is still typing. Kept as strings because the values exceed 2^53;
// both sides are exactly 17 digits, so string order is numeric order.
const STEAM_ID64_BASE = "76561197960265728";
const STEAM_ID64_MAX = "76561202255233023";

/** Why a typed option value is unusable, or null when it's fine. An
 *  empty value is only a problem for a required option. */
export function optionProblem(spec: OptionSpec, raw: string): string | null {
  const value = raw.trim();
  if (value === "") return spec.required ? "Required." : null;
  if (spec.kind === "steam_id64") {
    if (!/^\d{17}$/.test(value)) {
      return "A SteamID64 is exactly 17 digits and starts with 7656119…";
    }
    if (value <= STEAM_ID64_BASE || value > STEAM_ID64_MAX) {
      return "That number isn't a Steam account id — a SteamID64 starts with 7656119…";
    }
  }
  return null;
}

/** The SteamID64 implied by a path inside Steam's per-account save
 *  folder (`…/userdata/<account id>/<app id>/remote/…`), or null when the
 *  path isn't one. The folder name is the 32-bit account id; the SteamID64
 *  is that plus the individual-account base. Lets the screen fill the id in
 *  for a PC save picked straight from Steam, where it's by definition the
 *  account that made the save. */
export function steamId64FromPath(path: string): string | null {
  const match = /[\\/]userdata[\\/](\d{1,10})(?:[\\/]|$)/i.exec(path);
  if (!match) return null;
  const account = Number(match[1]);
  if (!Number.isSafeInteger(account) || account < 1 || account > 4294967295) {
    return null;
  }
  // 76561197960265728 + account, done in two halves because the sum
  // doesn't fit a JS number: the base is 7656119 * 10^10 + 7960265728 and
  // the low half plus any account id stays far below 2^53.
  const low = 7960265728 + account;
  const high = 7656119 + Math.floor(low / 1e10);
  return `${high}${String(low % 1e10).padStart(10, "0")}`;
}

/** True when every option this direction needs has a usable value. */
export function optionsReady(
  game: GameProfile,
  direction: Direction,
  values: Record<string, string>,
): boolean {
  return optionsFor(game, direction).every(
    (spec) => optionProblem(spec, values[spec.key] ?? "") === null,
  );
}

/** Only the values that apply to this direction, trimmed, blanks dropped
 *  — what gets sent to the backend. */
export function optionPayload(
  game: GameProfile,
  direction: Direction,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of optionsFor(game, direction)) {
    const value = (values[spec.key] ?? "").trim();
    if (value) out[spec.key] = value;
  }
  return out;
}

export function sourcePlatform(direction: Direction): "PS5" | "PC" {
  return direction === "ps5_to_pc" ? "PS5" : "PC";
}

export function targetPlatform(direction: Direction): "PS5" | "PC" {
  return direction === "ps5_to_pc" ? "PC" : "PS5";
}
