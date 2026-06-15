import { useState } from "react";
import { Palette, X, Check } from "lucide-react";
import { useThemeStore } from "../state/theme";
import { THEMES } from "../state/themesList";

/**
 * XENO theme picker — a palette button (use anywhere) that opens a grid of all
 * 50 themes. Clicking a swatch applies it instantly (live, no reload).
 */
const ALL = [
  { id: "dark", label: "Dark (default)", swatch: "oklch(0.7 0.17 255)", mode: "dark" },
  ...THEMES,
];

export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Themes — 50 to pick from"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]"
      >
        <Palette size={15} />
        {!compact && <span>Themes</span>}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[82vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-bold">
                <span className="text-[var(--color-gold)]">XENO</span> Themes{" "}
                <span className="text-xs font-normal text-[var(--color-muted)]">
                  · {ALL.length} styles
                </span>
              </div>
              <button onClick={() => setOpen(false)} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
                <X size={20} />
              </button>
            </div>
            <div
              className="grid min-h-0 flex-1 gap-2 overflow-y-auto pr-1"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}
            >
              {ALL.map((t) => {
                const active = theme === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className={`group relative flex flex-col items-start gap-2 rounded-xl border-2 p-2.5 transition ${
                      active
                        ? "border-[var(--color-accent)]"
                        : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
                    }`}
                  >
                    <span
                      className="h-9 w-full rounded-lg"
                      style={{
                        background: `linear-gradient(135deg, ${t.swatch}, ${t.swatch} 40%, transparent)`,
                        boxShadow: `0 0 18px -4px ${t.swatch}`,
                      }}
                    />
                    <span className="flex w-full items-center justify-between gap-1">
                      <span className="truncate text-[11px] font-semibold">{t.label}</span>
                      {active && <Check size={13} className="shrink-0 text-[var(--color-accent)]" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
