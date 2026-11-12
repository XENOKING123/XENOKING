// Save Converter (PS5 ⇄ PC) — typed wrappers over the Tauri commands in
// `src-tauri/src/commands/save_converter.rs`. The shapes mirror the serde
// structs in `engine/crates/ps5upload-core/src/save_convert/` — keep the
// two in sync.
//
// Everything here is local-disk work; no console connection is involved.

import { invoke } from "../lib/invokeLogged";

export type Direction = "ps5_to_pc" | "pc_to_ps5";

/** `ready` = verified both ways · `experimental` = converts, not yet
 *  confirmed in-game both ways · `wip` = listed, conversion refused. */
export type GameStatus = "ready" | "experimental" | "wip";

export interface FileMap {
  /** Path inside the decrypted PS5 save (may contain one `*`). */
  ps5: string;
  /** Path inside the PC save folder. */
  pc: string;
  label: string;
  required: boolean;
}

export interface OptionSpec {
  key: string;
  label: string;
  kind: "steam_id64" | "text";
  help: string;
  /** Directions that use this option; empty means both. */
  directions: Direction[];
  required: boolean;
}

export interface GameProfile {
  id: string;
  name: string;
  status: GameStatus;
  aliases: string[];
  ps5: { title_ids: string[]; save_hint: string };
  pc: { steam_app_id: number | null; save_path: string };
  files: FileMap[];
  codec: string;
  options: OptionSpec[];
  notes: string[];
  next_steps: { ps5_to_pc: string[]; pc_to_ps5: string[] };
  credits: string[];
}

export interface PlannedFile {
  label: string;
  /** Relative to `save_root`. */
  source: string;
  /** Relative to the output folder. */
  dest: string;
  size: number;
}

export interface MissingFile {
  label: string;
  pattern: string;
  required: boolean;
}

export interface InspectReport {
  game_id: string;
  direction: Direction;
  /** Where the save was actually found — the picked folder or a
   *  subfolder of it. */
  save_root: string;
  files: PlannedFile[];
  missing: MissingFile[];
  ignored: string[];
  ignored_total: number;
  convertible: boolean;
  /** Plain-language reasons it can't be converted; empty when it can. */
  blockers: string[];
}

export interface ConvertedFile {
  label: string;
  source: string;
  dest: string;
  in_size: number;
  out_size: number;
}

export interface ConvertReport {
  game_id: string;
  direction: Direction;
  save_root: string;
  /** The newly created folder holding the converted save. */
  output_dir: string;
  files: ConvertedFile[];
  ignored_total: number;
  warnings: string[];
}

export function saveConverterGames(): Promise<GameProfile[]> {
  return invoke<GameProfile[]>("save_converter_games");
}

/** Dry run — what would be converted from `inputDir`. Writes nothing. */
export function saveConverterInspect(
  gameId: string,
  direction: Direction,
  inputDir: string,
): Promise<InspectReport> {
  return invoke<InspectReport>("save_converter_inspect", {
    req: { game_id: gameId, direction, input_dir: inputDir },
  });
}

/** Convert into a brand-new folder under `outputDir`. The input is never
 *  modified and nothing existing is overwritten. */
export function saveConverterConvert(
  gameId: string,
  direction: Direction,
  inputDir: string,
  outputDir: string,
  options: Record<string, string>,
): Promise<ConvertReport> {
  return invoke<ConvertReport>("save_converter_convert", {
    req: {
      game_id: gameId,
      direction,
      input_dir: inputDir,
      output_dir: outputDir,
      options,
    },
  });
}

/** Open a folder in the OS file manager. */
export function saveConverterReveal(path: string): Promise<void> {
  return invoke<void>("save_converter_reveal", { path });
}
