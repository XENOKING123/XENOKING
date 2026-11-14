import { describe, expect, it } from "vitest";

import type { GameProfile, OptionSpec } from "../api/saveConverter";
import {
  filterGames,
  optionPayload,
  optionProblem,
  optionsFor,
  optionsReady,
  sourcePlatform,
  steamId64FromPath,
  targetPlatform,
} from "./saveConverter";

function game(patch: Partial<GameProfile> = {}): GameProfile {
  return {
    id: "monster-hunter-wilds",
    name: "Monster Hunter Wilds",
    status: "ready",
    aliases: ["MHWilds", "MH Wilds"],
    ps5: { title_ids: ["PPSA01234"], save_hint: "" },
    pc: { steam_app_id: 2246340, save_path: "" },
    files: [{ ps5: "data000.bin", pc: "data000.bin", label: "", required: true }],
    codec: "passthrough",
    options: [],
    notes: [],
    next_steps: { ps5_to_pc: [], pc_to_ps5: [] },
    credits: [],
    ...patch,
  };
}

const steamId: OptionSpec = {
  key: "steam_id64",
  label: "SteamID64",
  kind: "steam_id64",
  help: "",
  directions: ["ps5_to_pc"],
  required: true,
};

describe("filterGames", () => {
  const games = [
    game(),
    game({
      id: "elden-ring",
      name: "ELDEN RING",
      aliases: [],
      ps5: { title_ids: ["PPSA04608"], save_hint: "" },
      pc: { steam_app_id: 1245620, save_path: "" },
    }),
  ];

  it("returns everything for an empty search", () => {
    expect(filterGames(games, "")).toHaveLength(2);
    expect(filterGames(games, "   ")).toHaveLength(2);
  });

  it("matches name, alias, title id and steam app id", () => {
    const ids = (term: string) => filterGames(games, term).map((g) => g.id);
    expect(ids("monster")).toEqual(["monster-hunter-wilds"]);
    expect(ids("mhwilds")).toEqual(["monster-hunter-wilds"]);
    expect(ids("ppsa04608")).toEqual(["elden-ring"]);
    expect(ids("1245620")).toEqual(["elden-ring"]);
    expect(ids("zelda")).toEqual([]);
  });

  it("requires every word but ignores case and punctuation", () => {
    const ids = (term: string) => filterGames(games, term).map((g) => g.id);
    expect(ids("WILDS hunter")).toEqual(["monster-hunter-wilds"]);
    expect(ids("elden-ring")).toEqual(["elden-ring"]);
    expect(ids("monster ring")).toEqual([]);
  });
});

describe("optionProblem", () => {
  it("accepts a real-looking SteamID64", () => {
    expect(optionProblem(steamId, "76561198000000000")).toBeNull();
    expect(optionProblem(steamId, "  76561198000000000 ")).toBeNull();
    // First and last ids of the individual-account range.
    expect(optionProblem(steamId, "76561197960265729")).toBeNull();
    expect(optionProblem(steamId, "76561202255233023")).toBeNull();
  });

  it("rejects the usual mistakes", () => {
    for (const bad of [
      "12345678", // account id from the userdata folder name
      "7656119800000000", // 16 digits
      "765611980000000000", // 18 digits
      "76561197960265728", // account id 0
      "76561202255233024", // one past the last account id
      "99999999999999999", // outside the individual-account range
      "https://steamcommunity.com/profiles/76561198000000000",
    ]) {
      expect(optionProblem(steamId, bad), bad).not.toBeNull();
    }
  });

  it("treats blank as a problem only when the option is required", () => {
    expect(optionProblem(steamId, " ")).toBe("Required.");
    expect(optionProblem({ ...steamId, required: false }, "")).toBeNull();
  });

  it("accepts any text for a text option", () => {
    expect(optionProblem({ ...steamId, kind: "text" }, "anything")).toBeNull();
  });
});

describe("per-direction options", () => {
  const withOption = game({ options: [steamId] });

  it("only asks for an option in the directions that use it", () => {
    expect(optionsFor(withOption, "ps5_to_pc")).toHaveLength(1);
    expect(optionsFor(withOption, "pc_to_ps5")).toHaveLength(0);
    // Empty `directions` means both.
    const both = game({ options: [{ ...steamId, directions: [] }] });
    expect(optionsFor(both, "pc_to_ps5")).toHaveLength(1);
  });

  it("is ready once every applicable option is valid", () => {
    expect(optionsReady(withOption, "ps5_to_pc", {})).toBe(false);
    expect(optionsReady(withOption, "ps5_to_pc", { steam_id64: "123" })).toBe(
      false,
    );
    expect(
      optionsReady(withOption, "ps5_to_pc", {
        steam_id64: "76561198000000000",
      }),
    ).toBe(true);
    // Not needed in the other direction at all.
    expect(optionsReady(withOption, "pc_to_ps5", {})).toBe(true);
  });

  it("sends only trimmed values that apply to the direction", () => {
    const values = { steam_id64: " 76561198000000000 ", stale: "x" };
    expect(optionPayload(withOption, "ps5_to_pc", values)).toEqual({
      steam_id64: "76561198000000000",
    });
    expect(optionPayload(withOption, "pc_to_ps5", values)).toEqual({});
  });
});

describe("steamId64FromPath", () => {
  it("reads the account id out of a Steam userdata path", () => {
    // 76561197960265728 + 1003123
    expect(
      steamId64FromPath(
        "C:\\Program Files (x86)\\Steam\\userdata\\1003123\\2246340\\remote\\win64_save",
      ),
    ).toBe("76561197961268851");
    expect(
      steamId64FromPath("/home/me/.steam/steam/userdata/1003123/2246340/remote"),
    ).toBe("76561197961268851");
    // The account folder itself, with nothing after it.
    expect(steamId64FromPath("D:\\Steam\\USERDATA\\1")).toBe(
      "76561197960265729",
    );
  });

  it("carries correctly across the 10-digit boundary", () => {
    // Largest account id: 76561197960265728 + 4294967295.
    expect(steamId64FromPath("/steam/userdata/4294967295/1/remote")).toBe(
      "76561202255233023",
    );
    // 7960265728 + 2039734272 = 10000000000 exactly.
    expect(steamId64FromPath("/steam/userdata/2039734272/1")).toBe(
      "76561200000000000",
    );
    expect(steamId64FromPath("/steam/userdata/2039734271/1")).toBe(
      "76561199999999999",
    );
  });

  it("produces ids the option validator accepts", () => {
    for (const account of ["1", "1003123", "2039734272", "4294967295"]) {
      const id = steamId64FromPath(`/steam/userdata/${account}/2246340`);
      expect(id).not.toBeNull();
      expect(optionProblem(steamId, id ?? ""), account).toBeNull();
    }
  });

  it("returns null for anything that isn't a Steam account folder", () => {
    for (const path of [
      "",
      "C:\\Users\\me\\Desktop\\win64_save",
      "/steam/userdata/",
      "/steam/userdata/0/2246340", // account id 0 doesn't exist
      "/steam/userdata/4294967296/2246340", // doesn't fit 32 bits
      "/steam/userdata/12345678901/2246340", // too many digits
      "/steam/userdata/abc/2246340",
      "/steam/myuserdata/123/2246340",
    ]) {
      expect(steamId64FromPath(path), path).toBeNull();
    }
  });
});

describe("platform names", () => {
  it("reads source and target from the direction", () => {
    expect(sourcePlatform("ps5_to_pc")).toBe("PS5");
    expect(targetPlatform("ps5_to_pc")).toBe("PC");
    expect(sourcePlatform("pc_to_ps5")).toBe("PC");
    expect(targetPlatform("pc_to_ps5")).toBe("PS5");
  });
});
