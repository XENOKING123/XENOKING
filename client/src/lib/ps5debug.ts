// ps5debug (:744) direct cheat apply. EXPERIMENTAL — writes to the running
// game's memory. Attach first, then toggling a cheat writes its on/off bytes.
import { invoke } from "@tauri-apps/api/core";

export interface AttachInfo {
  ok: boolean;
  pid: number;
  message: string;
}

export async function attach(ip: string): Promise<AttachInfo> {
  return await invoke<AttachInfo>("ps5debug_attach", { ip });
}

/** Apply (enable) or revert (disable) cheat #index from a local trainer file. */
export async function applyCheat(
  ip: string,
  path: string,
  index: number,
  enable: boolean,
): Promise<string> {
  return await invoke<string>("cheat_apply", { ip, path, index, enable });
}
