import { describe, expect, it } from "vitest";
import { OFFLINE_AFTER_MS, formatOfflineSince, offlineAt, offlineSince } from "./worker-offline";

const NOW = new Date("2026-11-02T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe("offlineSince", () => {
  it("is null without any heartbeat", () => {
    expect(offlineSince([], NOW)).toBeNull();
    expect(offlineSince([{ heartbeat_at: null }], NOW)).toBeNull();
  });

  it("is online at 10 minutes and offline at 12", () => {
    expect(offlineSince([{ heartbeat_at: minutesAgo(10) }], NOW)).toBeNull();
    expect(offlineSince([{ heartbeat_at: minutesAgo(12) }], NOW)).toEqual(new Date(minutesAgo(12)));
  });

  it("takes the newest heartbeat over an older one", () => {
    expect(
      offlineSince([{ heartbeat_at: minutesAgo(30) }, { heartbeat_at: minutesAgo(2) }], NOW),
    ).toBeNull();
    expect(
      offlineSince([{ heartbeat_at: minutesAgo(30) }, { heartbeat_at: minutesAgo(20) }], NOW),
    ).toEqual(new Date(minutesAgo(20)));
  });
});

describe("offlineAt", () => {
  it("is the newest heartbeat plus eleven minutes", () => {
    expect(OFFLINE_AFTER_MS).toBe(660_000);
    expect(offlineAt([{ heartbeat_at: null }])).toBeNull();
    expect(offlineAt([{ heartbeat_at: minutesAgo(5) }, { heartbeat_at: minutesAgo(9) }])).toEqual(
      new Date(NOW.getTime() + 6 * 60_000),
    );
  });
});

describe("formatOfflineSince", () => {
  it("is 24-hour local time, zero padded", () => {
    expect(formatOfflineSince(new Date(2026, 10, 2, 7, 5))).toBe("Worker offline since 07:05");
    expect(formatOfflineSince(new Date(2026, 10, 2, 23, 59))).toBe("Worker offline since 23:59");
  });
});
