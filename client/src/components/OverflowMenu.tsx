import {
  type ReactNode,
  type CSSProperties,
  useEffect,
  useRef,
  useState,
} from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "./Button";

/**
 * One action inside an OverflowMenu.
 *
 * `loading` shows a spinner glyph and disables the row; the parent
 * decides which item is busy via the same boolean it already uses to
 * disable its primary buttons. `destructive` switches the label to
 * the warn color so deletes don't blend with neutral actions.
 *
 * `title` becomes the row's `title` attribute, providing the same
 * tooltip a Button would have surfaced. Keep it short — the menu
 * already includes the action label, so the title is for the why
 * (e.g. "Modifies the source file") not the what.
 */
export interface OverflowMenuItem {
  label: string;
  /** Optional left icon; when present, rendered at the same 12 px
   *  size the row Buttons use, so the menu lines up visually. */
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  loading?: boolean;
  destructive?: boolean;
  title?: string;
}

/**
 * "More actions" trigger that opens a small popover menu of
 * secondary actions. Used in the Library row to keep the visible
 * action surface minimal — primary action stays as a Button, every
 * other action lives behind this menu so the row reads as one
 * verb at a glance instead of seven.
 *
 * Closes on:
 *   - selecting an item (after the onSelect runs)
 *   - clicking outside the menu
 *   - pressing Escape
 *   - the trigger losing focus to outside the popover
 *
 * Positioned relative to the trigger (`absolute right-0 top-full`),
 * which is reliable inside the surrounding scroll container without
 * needing a portal — Library rows live inside a scrollable section
 * so a portaled menu would detach from the row visually.
 */
export function OverflowMenu({
  items,
  ariaLabel = "More actions",
  buttonTitle = "More actions",
  align = "right",
  size = "sm",
}: {
  items: OverflowMenuItem[];
  ariaLabel?: string;
  buttonTitle?: string;
  align?: "left" | "right";
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape. Both wired only when the menu
  // is open so we don't pay the listener cost for every closed menu
  // on every page (Library can render hundreds of rows).
  useEffect(() => {
    if (!open) return;
    function handlePointer(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  const menuPositionStyle: CSSProperties =
    align === "right" ? { right: 0 } : { left: 0 };

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <Button
        variant="ghost"
        size={size}
        leftIcon={<MoreHorizontal size={14} />}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={buttonTitle}
      />
      {open && (
        <div
          role="menu"
          className="anim-rise elev-2 absolute z-30 mt-1 min-w-[200px] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
          style={{ ...menuPositionStyle, top: "100%" }}
        >
          {items.map((item, i) => (
            <button
              key={`${item.label}-${i}`}
              type="button"
              role="menuitem"
              disabled={item.disabled || item.loading}
              onClick={() => {
                if (item.disabled || item.loading) return;
                setOpen(false);
                item.onSelect();
              }}
              title={item.title}
              className={
                "flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-xs transition-colors " +
                "disabled:cursor-not-allowed disabled:opacity-50 " +
                (item.destructive
                  ? "text-[var(--color-bad)] hover:bg-[var(--color-bad-soft)]"
                  : "text-[var(--color-text)] hover:bg-[var(--color-surface-3)]")
              }
            >
              {item.icon && (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {item.icon}
                </span>
              )}
              <span className="flex-1">{item.label}</span>
              {item.loading && (
                <span className="ml-2 text-xs text-[var(--color-muted)]">…</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
