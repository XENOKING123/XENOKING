import { useRef, useState } from "react";
import {
  Send,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Upload,
} from "lucide-react";

import { Button } from "../../components";
import { pushNotification } from "../../state/notifications";

// XENO-AIO web "Send file" panel. The desktop SendPanel is path-based
// (Tauri file dialog → local path). In the browser there are no local
// paths, so on-console we pick a file with a plain <input>, read its
// bytes, and POST them to the ELF's /api/payload/send, which streams them
// to the on-console loader (:9021) to run — same end result as the exe.

type St =
  | { kind: "idle" }
  | { kind: "sending"; name: string }
  | { kind: "sent"; name: string }
  | { kind: "error"; msg: string };

export default function WebSendPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [st, setSt] = useState<St>({ kind: "idle" });

  const send = async (file: File) => {
    setSt({ kind: "sending", name: file.name });
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch("/api/payload/send", { method: "POST", body: buf });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) {
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setSt({ kind: "sent", name: file.name });
      pushNotification("success", `Sent ${file.name} to the PS5 loader`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSt({ kind: "error", msg });
      pushNotification("error", `Send failed: ${msg}`);
    }
  };

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 text-center">
        <Upload className="mx-auto mb-3 text-[var(--text-muted)]" size={32} />
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">
          Send a payload to your PS5
        </h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Pick a payload file (.elf / .bin). It's sent straight to your console's
          loader on port 9021 and runs immediately — the same as the desktop app.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept=".elf,.bin,.js,.lua,.jar"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void send(f);
            e.currentTarget.value = "";
          }}
        />

        <div className="mt-4">
          <Button
            variant="primary"
            leftIcon={
              st.kind === "sending" ? (
                <Loader2 className="animate-spin" size={14} />
              ) : (
                <Send size={14} />
              )
            }
            disabled={st.kind === "sending"}
            onClick={() => inputRef.current?.click()}
          >
            {st.kind === "sending" ? `Sending ${st.name}…` : "Choose & send"}
          </Button>
        </div>

        {st.kind === "sent" && (
          <p className="mt-3 flex items-center justify-center gap-1.5 text-sm text-green-400">
            <CheckCircle2 size={15} /> Sent {st.name} — check your PS5 screen.
          </p>
        )}
        {st.kind === "error" && (
          <p className="mt-3 flex items-center justify-center gap-1.5 text-sm text-red-400">
            <AlertTriangle size={15} /> {st.msg}
          </p>
        )}
      </div>
    </div>
  );
}
