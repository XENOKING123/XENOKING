// XENO trainer library — browse the local 6-repo trainer collection. Scanning
// + syncing happen in Rust (list_trainers / cheat_sync); cheats apply via
// CheatRunner (My Games) or ps5debug. Data lives under <app_data>/trainers/.
import { invoke } from "@tauri-apps/api/core";

export interface TrainerRow {
  game: string;
  titleId: string;
  version: string;
  format: "JSON" | "SHN" | "MC4" | string;
  modder: string;
  cheats: string[];
  path: string;
}

export async function listTrainers(): Promise<TrainerRow[]> {
  try {
    return await invoke<TrainerRow[]>("list_trainers");
  } catch {
    return [];
  }
}

export interface SyncResult {
  total: number;
  per_repo: [string, number][];
}

export async function cheatSync(force = false): Promise<SyncResult> {
  return await invoke<SyncResult>("cheat_sync", { force });
}

/** Online title resolution: name (+ PS5 cover) for a CUSA/PPSA id. Backed by
 *  the bundled All_Titles.json catalog first, then prosperopatches for PS5. */
export interface TitleInfo {
  title: string;
  cover: string;
}

export async function deleteTrainer(path: string): Promise<void> {
  await invoke("delete_trainer", { path });
}

export async function resolveTitleOnline(id: string): Promise<TitleInfo> {
  try {
    return await invoke<TitleInfo>("title_resolve", { id });
  } catch {
    return { title: "", cover: "" };
  }
}
