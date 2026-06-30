import { useState } from "react";
import { Download, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

import { Button } from "../../components";
import { pushNotification } from "../../state/notifications";

// On-console one-click "Download & Send" for a catalog payload. The
// browser pulls the latest release straight from GitHub (its API allows
// cross-origin) and POSTs the asset bytes to the ELF's /api/payload/send,
// which streams them to the loader (:9021). No PC, no local download.

interface Entry {
  id: string;
  repo_host?: string;
  repo_owner?: string;
  repo_name?: string;
  asset_name_hint?: string;
}

type St =
  | { kind: "idle" }
  | { kind: "working"; msg: string }
  | { kind: "done" }
  | { kind: "err"; msg: string };

interface Asset {
  name: string;
  browser_download_url: string;
}

async function downloadAndSend(e: Entry, setMsg: (m: string) => void) {
  const host = e.repo_host || "github.com";
  const api =
    host === "github.com"
      ? `https://api.github.com/repos/${e.repo_owner}/${e.repo_name}/releases/latest`
      : `https://${host}/api/v1/repos/${e.repo_owner}/${e.repo_name}/releases/latest`;

  setMsg("Finding latest release…");
  const rel = await fetch(api).then((r) => {
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.json() as Promise<{ assets?: Asset[] }>;
  });

  const assets = rel.assets ?? [];
  const hint = (e.asset_name_hint || "").toLowerCase();
  const isElf = (a: Asset) => a.name.toLowerCase().endsWith(".elf");
  const pick =
    assets.find((a) => a.name.toLowerCase().includes(hint) && isElf(a)) ||
    assets.find(isElf) ||
    assets.find((a) => a.name.toLowerCase().includes(hint)) ||
    assets[0];
  if (!pick) throw new Error("no downloadable asset in the latest release");

  setMsg(`Downloading ${pick.name}…`);
  const buf = await fetch(pick.browser_download_url).then((r) => {
    if (!r.ok) throw new Error(`download ${r.status}`);
    return r.arrayBuffer();
  });

  setMsg("Sending to PS5…");
  const res = await fetch("/api/payload/send", { method: "POST", body: buf });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || j.ok === false) throw new Error(j.error || `send ${res.status}`);
}

export default function WebCatalogAction({ info }: { info: Entry }) {
  const [st, setSt] = useState<St>({ kind: "idle" });

  const run = async () => {
    setSt({ kind: "working", msg: "Starting…" });
    try {
      await downloadAndSend(info, (m) => setSt({ kind: "working", msg: m }));
      setSt({ kind: "done" });
      pushNotification("success", `Sent ${info.id} to your PS5`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSt({ kind: "err", msg });
      pushNotification("error", `${info.id}: ${msg}`);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="primary"
        size="sm"
        disabled={st.kind === "working"}
        leftIcon={
          st.kind === "working" ? (
            <Loader2 className="animate-spin" size={11} />
          ) : (
            <Download size={11} />
          )
        }
        onClick={run}
      >
        {st.kind === "working" ? st.msg : "Download & Send"}
      </Button>
      {st.kind === "done" && (
        <span className="flex items-center gap-1 text-xs text-green-400">
          <CheckCircle2 size={12} /> Sent — check your PS5 screen.
        </span>
      )}
      {st.kind === "err" && (
        <span className="flex items-center gap-1 text-xs text-red-400">
          <AlertTriangle size={12} /> {st.msg}
        </span>
      )}
    </div>
  );
}
