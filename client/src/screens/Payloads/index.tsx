import { Boxes, Rocket, Star } from "lucide-react";

import TabbedShell, { type TabbedShellTab } from "../../layout/TabbedShell";
import { useTr } from "../../state/lang";
import CatalogPanel from "./CatalogPanel";
import SendPanel from "./SendPanel";
import WebSendPanel from "./WebSendPanel";
import FavoritesPanel from "./FavoritesPanel";
import { isOnConsole } from "../../lib/webBridge";

/**
 * Payloads screen — two URL-routed tabs:
 *
 *   - **catalog**: curated GitHub-released third-party homebrew.
 *   - **send**: arbitrary ELF/BIN/JS/LUA/JAR picker. Includes
 *     playlists and recent-sends history.
 *
 * (Historically split across /payloads and the old /send-payload route;
 * merged under ?tab=send for a cleaner sidebar. Legacy redirects remain
 * for old bookmarks.)
 *
 * The shell (URL contract + tablist + a11y + keyboard nav + page
 * header) lives in `layout/TabbedShell`; this file is just tab
 * metadata and a panel switch.
 */

type TabId = "catalog" | "send" | "favorites";

export default function PayloadsScreen() {
  const tr = useTr();
  const tabs: ReadonlyArray<TabbedShellTab<TabId>> = [
    {
      id: "catalog",
      icon: Boxes,
      key: "payloads_tab_catalog",
      fallback: "Catalog",
      description: tr(
        "payloads_description_catalog",
        undefined,
        "Curated third-party PS5 homebrew payloads. Check for the latest release, download once, then send to your PS5 with one click. Versions cache locally so you can also bundle a USB autoloader stick.",
      ),
    },
    {
      id: "send",
      icon: Rocket,
      key: "payloads_tab_send",
      fallback: "Send file",
      description: tr(
        "payloads_description_send",
        undefined,
        "Send any PS5 payload file — .elf, .bin, .js, .lua, or .jar (kstuff, custom homebrew loaders, browser-stage exploits, plugin scripts, BD-JB JARs) — to your PS5. Same flow as the Connection tab, just pointed at a file you choose. Note: BD-JB-style .jar payloads need a JAR-aware loader on a non-9021 port — set the port to whatever your loader listens on.",
      ),
    },
    {
      id: "favorites",
      icon: Star,
      key: "payloads_tab_favorites",
      fallback: "Favorites",
      description: tr(
        "payloads_description_favorites",
        undefined,
        "Your own folder of payloads — star the ones you reach for, and inject all your favorites with one click. Your folder and favorites are remembered across launches.",
      ),
    },
  ];

  return (
    <TabbedShell
      idPrefix="payloads"
      titleIcon={Boxes}
      titleKey="payloads"
      titleFallback="Payloads"
      tabs={tabs}
      renderPanel={(id) =>
        id === "send"
          ? isOnConsole()
            ? <WebSendPanel />
            : <SendPanel />
          : id === "favorites"
            ? <FavoritesPanel />
            : <CatalogPanel />
      }
    />
  );
}
