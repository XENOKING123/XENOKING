// XENO-AIO — on-console auto-connect.
//
// When the UI is served by the on-console ELF (XENO-AIO.elf running on
// the jailbroken PS5), `GET /api/netinfo` returns
//   { on_console: true, ip, port, version }.
// In that case we connect to the local console AUTOMATICALLY — no "enter
// IP + click connect" step. The user injects the ELF, opens the URL the
// toast shows, and lands on a live, already-connected app.
//
// On the PC host server (or plain `vite dev`) there is no `/api/netinfo`
// route, so this no-ops and the normal Connection flow runs unchanged.
import { isWebMode, setOnConsole } from "./webBridge";
import { useConnectionStore } from "../state/connection";
import { useRosterStore } from "../state/roster";
import { log } from "../state/logs";

export async function webAutoConnect(): Promise<void> {
  if (!isWebMode()) return;
  try {
    const res = await fetch("/api/netinfo", { cache: "no-store" });
    if (!res.ok) return;
    const ni = (await res.json()) as {
      on_console?: boolean;
      ip?: string;
      port?: number;
      version?: string;
    };
    if (!ni || ni.on_console !== true || !ni.ip) return;
    const host = String(ni.ip);

    // Tell the bridge we're on-console so connectivity probes resolve
    // healthy (the server IS this PS5) and the poller keeps it "up".
    setOnConsole({ ip: host, version: ni.version ?? null });

    // Seed the roster so the console appears in the tab strip, then make
    // it active. The API the bridge talks to IS this console, so there's
    // nothing to probe — bind straight to it.
    const roster = useRosterStore.getState();
    const existing = roster.profiles.find((p) => p.host === host);
    if (existing) roster.setActive(existing.id);
    else roster.add({ name: "PS5 (this console)", host });

    // Mark the connection live so ConnectionGate passes immediately and
    // every screen renders connected (no "No PS5 connected" / "helper
    // isn't running" interstitials).
    useConnectionStore.getState().setStatus({
      engineStatus: "up",
      payloadStatus: "up",
      payloadStatusHost: host,
      payloadVersion: ni.version ?? null,
    });
    log.info("web", `auto-connected to on-console PS5 ${host}`);
  } catch {
    // Network/parse failure → fall back to the manual flow silently.
  }
}
