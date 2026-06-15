import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "className" | "children"
  > {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Shared button primitive. Four variants cover every in-app use:
 *
 *   primary   — the main CTA on a screen; filled accent color.
 *   secondary — neutral action (Refresh, Choose file); bordered.
 *   ghost     — subtle tertiary (Dismiss, icon-only); border-less.
 *   danger    — destructive (Delete, Uninstall); red border.
 *
 * Two sizes:
 *   sm — used for header actions and inline row actions.
 *   md — the default for primary CTAs.
 *
 * `loading` swaps the left icon for a spinner and disables the button.
 * `leftIcon` / `rightIcon` give consistent icon spacing without the
 *  caller having to remember to wrap in a flex container.
 *
 * Tailwind classes are composed here so every button in the app
 * ends up with the same hover / disabled / focus treatment — no
 * more remembering `hover:bg-[var(--color-surface-3)]` at each
 * call site.
 */
export function Button({
  variant = "secondary",
  size = "sm",
  loading = false,
  leftIcon,
  rightIcon,
  children,
  disabled,
  type = "button",
  className = "",
  ...rest
}: ButtonProps) {
  // Keyboard focus comes from the global :focus-visible ring in index.css
  // (v3) so buttons match every other interactive element — no per-component
  // ring classes needed.
  // `whitespace-nowrap`: a button is a single-line control. Without it, a
  // button squeezed in a tight flex row (min-width:0 globally) wraps its
  // label vertically, one character per line. If a label is genuinely too
  // long, that's a layout decision for the call site (truncate / give room),
  // never a reason to stack letters.
  const base =
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium " +
    "transition-colors " +
    "disabled:cursor-not-allowed disabled:opacity-50";

  const sizing =
    size === "md"
      ? "px-4 py-2 text-sm"
      : "px-3 py-1.5 text-xs";

  const variants: Record<ButtonVariant, string> = {
    primary:
      "bg-[var(--color-accent)] text-[var(--color-accent-contrast)] hover:opacity-90 active:opacity-80 border border-transparent",
    secondary:
      "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-3)]",
    ghost:
      "border border-transparent text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]",
    danger:
      "border border-[var(--color-bad)] bg-[var(--color-surface)] text-[var(--color-bad)] hover:bg-[var(--color-bad-soft)]",
  };

  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`${base} ${sizing} ${variants[variant]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Loader2 size={size === "md" ? 14 : 12} className="animate-spin" />
      ) : (
        leftIcon
      )}
      {children && <span>{children}</span>}
      {!loading && rightIcon}
    </button>
  );
}
