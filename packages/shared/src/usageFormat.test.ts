// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import { formatHourShort, makePeriodWindow, makeWindow } from "./usageFormat.ts";

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EDT",
    );
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EST",
    );
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});

describe("makePeriodWindow", () => {
  it("runs month to date from the 1st of the viewer's month through today", () => {
    vi.stubEnv("TZ", "UTC");
    const window = makePeriodWindow("mtd", new Date("2026-10-16T12:00:00Z"));
    expect(window).toMatchObject({
      sinceDay: "2026-10-01",
      untilDay: "2026-10-16",
      resolution: "day",
    });
    expect(makePeriodWindow("mtd", new Date("2026-10-01T00:30:00Z")).sinceDay).toBe("2026-10-01");
    vi.unstubAllEnvs();
  });

  it("keeps the fixed periods on upstream's day and hour windows", () => {
    const now = new Date("2026-10-16T12:37:00Z");
    expect(makePeriodWindow(1, now)).toEqual(makeWindow(1, now, "hour"));
    expect(makePeriodWindow(30, now)).toEqual(makeWindow(30, now));
  });
});
