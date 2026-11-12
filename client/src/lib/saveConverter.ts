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
