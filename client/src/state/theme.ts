import { create } from "zustand";
import { THEMES } from "./themesList";

/** XENO theme system: "dark" is the attribute-less @theme default; every other
 *  id maps to a `:root[data-theme="<id>"]` block in themes.css (50 of them).
 *  Storage key kept at "ps5upload.theme" so settings survive the upgrade. */
export type Theme = string;

const STORAGE_KEY = "ps5upload.theme";

const VALID_THEMES: Theme[] = ["dark", ...THEMES.map((t) => t.id)];

/** Read the persisted theme synchronously so the first paint is correct.
 *  Returning "dark" as the fallback keeps parity with the app's historical
 *  look for users who've never toggled. */
function initialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
  return stored && VALID_THEMES.includes(stored) ? stored : "xenoking";
}

/** Write the theme attribute onto <html>. Our `index.css` keys both
 *  the light and oled overrides off `:root[data-theme="<name>"]`; the
 *  dark theme is the attribute-less default so we remove the attr
 *  rather than set it. */
function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  if (theme === "dark") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** Cycles dark → light → oled → dark. Three clicks returns to
   *  the starting theme. The picker in Settings (when one exists)
   *  can call setTheme directly for a non-cyclic UX. */
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    window.localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    // quick-cycle a few favourites; the picker (palette button) has all 50.
    const order: Theme[] = ["dark", "ocean", "ember", "matrix", "daylight", "synthwave"];
    const idx = order.indexOf(get().theme);
    const next: Theme = order[(idx + 1) % order.length];
    window.localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    set({ theme: next });
  },
}));

// Apply the initial theme on module load so the very first paint is
// right — beats waiting for React to mount.
if (typeof document !== "undefined") {
  applyTheme(initialTheme());
}
