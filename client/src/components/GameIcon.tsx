import { useEffect, useState } from "react";
import { Gamepad2 } from "lucide-react";

import { appIconUrl, gameIconUrl } from "../api/ps5";
import { transferAddr } from "../lib/addr";

/**
 * Shared game cover/icon with a graceful glyph fallback.
 *
 * Two sources, matching the two ways the app knows about a title:
 *   - `titleId` → `/user/appmeta/<id>/icon0.png` (installed / registered titles)
 *   - `gamePath` → `<game folder>/sce_sys/icon0.png` (library scan, pre-install)
 * Pass whichever you have; `titleId` wins if both are given. On a 404 (homebrew
 * with no icon, or a not-yet-installed pkg) it falls back to a controller glyph
 * — same behaviour the Install Package / Installed Apps / Library screens each
 * reimplemented inline before this consolidated them.
 */
export function GameIcon({
  host,
  titleId,
  gamePath,
  size = 56,
  rounded = "rounded-md",
  className = "",
}: {
  host: string;
  titleId?: string | null;
  gamePath?: string | null;
  /** Square edge length in px. */
  size?: number;
  /** Tailwind rounding class for the frame. */
  rounded?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const hostReady = !!host.trim();
  const src =
    hostReady && titleId
      ? appIconUrl(transferAddr(host), titleId)
      : hostReady && gamePath
        ? gameIconUrl(transferAddr(host), gamePath)
        : null;
  // Reset the 404 fallback whenever the source changes — otherwise an instance
  // reused for a different title (list reorder) would stay a glyph even when
  // the new title has art.
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const show = !failed && !!src;
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-[var(--color-surface-3)] ${rounded} ${className}`}
      style={{ width: size, height: size }}
    >
      {show ? (
        <img
          src={src!}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <Gamepad2
          size={Math.round(size * 0.36)}
          className="text-[var(--color-muted)]"
        />
      )}
    </div>
  );
}

export default GameIcon;
