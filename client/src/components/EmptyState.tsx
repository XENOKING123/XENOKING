import type { LucideIcon } from "lucide-react";

/**
 * "Nothing here yet" / "waiting" card. Used when a screen has loaded but has
 * no data to show — distinct from the error state ("loading failed").
 *
 * Sizes:
 *   - compact (default) — small card with a single-line message, for when the
 *     screen has other content around it.
 *   - hero — taller card with icon + title + message, for screens whose ONLY
 *     state is "nothing yet" (empty Library, pre-connection Hardware, etc).
 *
 * `fill` makes the card tall (min 55vh) and centres its content — so a
 * sole-content empty/loading state reads as a balanced, intentional
 * placeholder instead of a thin bar floating over a black void. Works in
 * normal block flow; no special parent needed.
 */
export function EmptyState({
  icon: Icon,
  title,
  message,
  size = "compact",
  fill = false,
  action,
}: {
  icon?: LucideIcon;
  title?: string;
  message: string;
  size?: "compact" | "hero";
  fill?: boolean;
  action?: React.ReactNode;
}) {
  // `hero` is by definition the screen's sole state, so it always fills +
  // centres. `fill` opts a compact message (e.g. "waiting…") into the same.
  const wantFill = fill || size === "hero";
  const fillCls = wantFill
    ? "flex min-h-[72vh] flex-col items-center justify-center"
    : "";

  if (size === "hero" || fill) {
    return (
      <div
        className={`rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] p-12 text-center ${fillCls}`}
      >
        {Icon && (
          <Icon
            size={40}
            className="mx-auto mb-4 text-[var(--color-muted)] opacity-60"
          />
        )}
        {title && <h3 className="mb-1.5 text-lg font-semibold">{title}</h3>}
        <p className="mx-auto max-w-xl text-sm leading-relaxed text-[var(--color-muted)]">
          {message}
        </p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] p-6 text-center text-sm text-[var(--color-muted)]">
      {Icon && (
        <Icon
          size={20}
          className="mx-auto mb-2 text-[var(--color-muted)] opacity-60"
          aria-hidden
        />
      )}
      {message}
      {action && (
        <div className="mt-3 flex justify-center">{action}</div>
      )}
    </div>
  );
}
