/**
 * Shared progress bar — replaces the hand-rolled `h-1.5 rounded-full …`
 * fills that Upload, QueuePanel and FileSystem each wrote separately
 * (each with slightly different heights, colors and transitions).
 *
 * Two modes:
 *   determinate   — pass `value` (0..1); the fill animates width changes.
 *   indeterminate — omit `value`; renders a shimmer sweep so "working,
 *                   amount unknown" still reads as motion, not a frozen bar.
 *
 * `tone` recolors the fill for terminal states (good = finished,
 * bad = failed) so completion can reuse the same bar instead of
 * swapping components.
 */
export function ProgressBar({
  value,
  tone = "accent",
  size = "md",
  className = "",
}: {
  /** 0..1 fraction. Omit for an indeterminate shimmer. */
  value?: number | null;
  tone?: "accent" | "good" | "warn" | "bad";
  size?: "sm" | "md";
  className?: string;
}) {
  const h = size === "sm" ? "h-1" : "h-1.5";
  const toneVar = {
    accent: "var(--color-accent)",
    good: "var(--color-good)",
    warn: "var(--color-warn)",
    bad: "var(--color-bad)",
  }[tone];

  const determinate = typeof value === "number" && Number.isFinite(value);
  const pct = determinate ? Math.min(100, Math.max(0, value * 100)) : 0;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      className={`${h} w-full overflow-hidden rounded-full bg-[var(--color-surface-3)] ${className}`}
    >
      {determinate ? (
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%`, background: toneVar }}
        />
      ) : (
        <div className="anim-skeleton h-full w-full" />
      )}
    </div>
  );
}
