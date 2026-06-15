// Cross-platform file/folder picker that returns a REAL filesystem path.
//
// Desktop uses the native dialog (plugin-dialog), which already returns
// real paths. Android's scoped storage doesn't — its directory picker is
// a no-op and its file picker returns content:// URIs the engine can't
// read — so on Android we route to the in-app real-path browser
// (LocalPathPicker via the localPicker store) instead. Callers don't
// branch; they just `await pickPath({ mode })`.

import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { isAndroid } from "./platform";
import { pickLocalPath } from "../state/localPicker";

export interface PickPathOptions {
  mode: "file" | "folder";
  title?: string;
  /** Desktop file-dialog filters (ignored by the Android browser). */
  filters?: { name: string; extensions: string[] }[];
}

/** Pick a single real path, or null if cancelled. */
export async function pickPath(opts: PickPathOptions): Promise<string | null> {
  if (isAndroid()) {
    return pickLocalPath({ mode: opts.mode, title: opts.title });
  }
  const sel = await openDialog({
    directory: opts.mode === "folder",
    multiple: false,
    title: opts.title,
    filters: opts.filters,
  });
  return typeof sel === "string" ? sel : null;
}
