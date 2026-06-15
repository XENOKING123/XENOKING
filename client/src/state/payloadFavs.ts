import { create } from "zustand";

// XENO Payloads favorites — star your go-to payloads so they sort to the top.
// Persisted to localStorage; ids are PayloadInfo.id.
const KEY = "xeno.payload.favs";

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface FavState {
  favs: string[];
  isFav: (id: string) => boolean;
  toggle: (id: string) => void;
}

export const usePayloadFavs = create<FavState>((set, get) => ({
  favs: load(),
  isFav: (id) => get().favs.includes(id),
  toggle: (id) =>
    set((s) => {
      const next = s.favs.includes(id)
        ? s.favs.filter((x) => x !== id)
        : [...s.favs, id];
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* quota — ignore */
      }
      return { favs: next };
    }),
}));
