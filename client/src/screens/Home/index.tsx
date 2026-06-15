import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

/**
 * XENO Home — the landing screen. A glowing hero, quick-action bubbles, and an
 * auto-scrolling showcase of game covers. The app opens here instead of a
 * random tab.
 */
const BUBBLES: { to: string; emoji: string; label: string; desc: string; gold?: boolean }[] = [
  { to: "/my-games", emoji: "🎮", label: "My Games", desc: "Cheats on running games", gold: true },
  { to: "/trainers", emoji: "🎯", label: "Trainers", desc: "9,000+ trainer library", gold: true },
  { to: "/game-store", emoji: "🛒", label: "Game Store", desc: "Browse & download PS4/PS5", gold: true },
  { to: "/install-package", emoji: "📦", label: "Install Package", desc: "Send a .pkg to your PS5" },
  { to: "/saves", emoji: "💾", label: "Save Data", desc: "Backup & restore saves" },
  { to: "/payloads", emoji: "🧨", label: "Payloads", desc: "Send homebrew + favorites" },
  { to: "/connection", emoji: "🔌", label: "Connection", desc: "Link your PS5" },
  { to: "/settings", emoji: "🎨", label: "Themes", desc: "50 themes, pick your vibe" },
];

export default function HomeScreen() {
  const [covers, setCovers] = useState<string[]>([]);
  useEffect(() => {
    fetch("/covers.json")
      .then((r) => r.json())
      .then((d) => {
        const all = Object.values((d && d.titles) || {}).filter(
          (v): v is string => typeof v === "string" && v.startsWith("http"),
        );
        const step = Math.max(1, Math.floor(all.length / 30));
        const pick: string[] = [];
        for (let i = 0; i < all.length && pick.length < 30; i += step) pick.push(all[i]);
        setCovers(pick);
      })
      .catch(() => {});
  }, []);

  const strip = covers.length ? [...covers, ...covers] : [];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* hero */}
      <div className="relative overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-8 text-center">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{ background: "radial-gradient(120% 80% at 50% -10%, color-mix(in oklch, var(--color-accent), transparent 70%), transparent 60%)" }}
        />
        <img src="/logo-square.png" alt="" className="relative mx-auto mb-3 h-20 w-20 rounded-2xl" />
        <h1 className="xeno-wordmark relative text-4xl font-black tracking-[0.18em]">XENO TOOL</h1>
        <p className="relative mt-2 text-sm text-[var(--color-muted)]">
          ALL-IN-ONE · cheats · trainers · game store · saves · payloads
        </p>
      </div>

      {/* quick-action bubbles */}
      <div
        className="mt-5 grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}
      >
        {BUBBLES.map((b) => (
          <Link
            key={b.to}
            to={b.to}
            className={`group flex items-center gap-3 rounded-xl border p-3 transition hover:-translate-y-0.5 ${
              b.gold
                ? "border-[var(--color-gold)]/40 bg-[var(--color-gold-soft)] hover:border-[var(--color-gold)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-accent)]"
            }`}
          >
            <span className="text-2xl">{b.emoji}</span>
            <span className="min-w-0">
              <span className={`block text-sm font-bold ${b.gold ? "text-[var(--color-gold)]" : ""}`}>
                {b.label}
              </span>
              <span className="block truncate text-[11px] text-[var(--color-muted)]">{b.desc}</span>
            </span>
          </Link>
        ))}
      </div>

      {/* showcase — auto-scrolling cover strip */}
      {strip.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
            ◆ Showcase
          </div>
          <div className="relative overflow-hidden rounded-xl border border-[var(--color-border)] py-3">
            <div className="xeno-marquee flex w-max gap-3 px-3">
              {strip.map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt=""
                  loading="lazy"
                  className="h-40 w-28 shrink-0 rounded-lg object-cover shadow-lg"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="h-4 shrink-0" />
    </div>
  );
}
