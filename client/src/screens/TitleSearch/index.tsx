import { useEffect, useMemo, useState } from "react";
import { Crosshair, Search } from "lucide-react";

import { PageHeader, EmptyState } from "../../components";
import {
  listTrainers,
  resolveTitleOnline,
  type TrainerRow,
  type TitleInfo,
} from "../../lib/trainers";

/**
 * XENO Title Search — type a game name or CUSA/PPSA id to find which trainers
 * exist for it across the whole synced library. Rows with no name (an orphan
 * title id) are resolved live from the bundled All_Titles.json catalog, then
 * prosperopatches.com for PS5 (which also gives real cover art).
 */
export default function TitleSearchScreen() {
  const [rows, setRows] = useState<TrainerRow[]>([]);
  const [term, setTerm] = useState("");
  const [resolved, setResolved] = useState<Record<string, TitleInfo>>({});

  useEffect(() => {
    void listTrainers().then(setRows);
  }, []);

  const results = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return [];
    return rows
      .filter((r) => r.game.toLowerCase().includes(t) || r.titleId.toLowerCase().includes(t))
      .slice(0, 300);
  }, [rows, term]);

  // Resolve the visible rows that have no real name (game blank or == titleId).
  // Capped per pass; converges because resolved ids are skipped next run.
  useEffect(() => {
    const missing = results
      .filter((r) => !r.game || r.game.toUpperCase() === r.titleId.toUpperCase())
      .map((r) => r.titleId.toUpperCase())
      .filter((id, i, a) => !!id && a.indexOf(id) === i && !(id in resolved))
      .slice(0, 12);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const id of missing) {
        const info = await resolveTitleOnline(id);
        if (cancelled) return;
        setResolved((prev) => ({ ...prev, [id]: info }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [results, resolved]);

  const nameOf = (r: TrainerRow) =>
    r.game || resolved[r.titleId.toUpperCase()]?.title || r.titleId;
  const coverOf = (r: TrainerRow) => resolved[r.titleId.toUpperCase()]?.cover || "";

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Crosshair}
        title="Title Search"
        count={rows.length}
        description="Search the whole trainer library by game name or title id (CUSA / PPSA). Missing names are resolved online (PS5 via prosperopatches, the rest from the title catalog)."
      />

      <div className="relative mb-4">
        <Search
          size={18}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
        />
        <input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="e.g. Elden Ring, or CUSA12345 / PPSA01628…"
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] py-2.5 pl-10 pr-3 text-base outline-none focus:border-[var(--color-gold)]"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {!term.trim() ? (
          <EmptyState
            icon={Crosshair}
            title="Search the library"
            message={`${rows.length} trainers indexed — start typing a game or title id.`}
          />
        ) : results.length === 0 ? (
          <EmptyState icon={Search} title="No matches" message={`Nothing for “${term}”.`} />
        ) : (
          <div className="space-y-1.5">
            {results.map((r) => {
              const cover = coverOf(r);
              return (
                <div
                  key={r.path}
                  className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
                >
                  {cover ? (
                    <img
                      src={cover}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded object-cover"
                      onError={(e) => (e.currentTarget.style.display = "none")}
                    />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{nameOf(r)}</span>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {r.titleId}
                      {r.version ? ` · v${r.version}` : ""} · {r.format}
                    </span>
                  </span>
                  <span className="rounded-full bg-[var(--color-gold-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-gold)]">
                    {r.cheats.length} cheats
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
