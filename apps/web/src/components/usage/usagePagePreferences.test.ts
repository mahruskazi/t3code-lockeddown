import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const key = "t3code:usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Usage page preferences", () => {
  it("uses defaults when no preference has been saved", () => {
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", range: "30d" });
  });

  it.each(["24h", "7d", "30d", "90d", "mtd"] as const)(
    "round-trips every metric with the %s range",
    (range) => {
      for (const metric of ["cost", "tokens", "limits"] as const) {
        saveUsagePagePreferences({ metric, range });
        expect(readUsagePagePreferences()).toEqual({ metric, range });
      }
    },
  );

  it.each([
    ['{"metric":"tokens","windowDays":90}', { metric: "tokens", range: "90d" }],
    ['{"metric":"cost","windowDays":1}', { metric: "cost", range: "24h" }],
  ])("carries a range saved as a day count forward: %s", (value, expected) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual(expected);
  });

  it.each([
    "not-json",
    '{"metric":"unknown","range":"7d"}',
    '{"metric":"cost","range":"365d"}',
    '{"metric":"cost","windowDays":365}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", range: "30d" });
    saveUsagePagePreferences({ metric: "tokens", range: "7d" });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", range: "7d" });
  });

  it("contains write failures and can save again after storage recovers", () => {
    saveUsagePagePreferences({ metric: "cost", range: "30d" });
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveUsagePagePreferences({ metric: "tokens", range: "7d" })).not.toThrow();
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", range: "30d" });
    write.mockRestore();
    saveUsagePagePreferences({ metric: "limits", range: "7d" });
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", range: "7d" });
  });

  it("contains failures when the browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", range: "30d" });
    expect(() => saveUsagePagePreferences({ metric: "tokens", range: "7d" })).not.toThrow();
  });
});
