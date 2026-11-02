import { describe, expect, it, vi } from "vitest";
import { withKeepAwake } from "./keep-awake.ts";

function fakeSpawn(events: string[]) {
  const kill = vi.fn(() => {
    events.push("kill");
    return true;
  });
  const child = { kill, on: vi.fn(() => child) };
  const spawn = vi.fn((file: string, args: string[]) => {
    events.push(`spawn ${file} ${args.join(" ")}`);
    return child;
  });
  return { spawn, kill };
}

describe("withKeepAwake", () => {
  it("runs the job under caffeinate on macOS and stops it after", async () => {
    const events: string[] = [];
    const { spawn, kill } = fakeSpawn(events);
    const result = await withKeepAwake(
      async () => {
        events.push("work");
        return 7;
      },
      { platform: "darwin", pid: 4242, spawn },
    );
    expect(result).toBe(7);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-w", "4242"], {
      stdio: "ignore",
    });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(events).toEqual(["spawn /usr/bin/caffeinate -i -w 4242", "work", "kill"]);
  });

  it("stops caffeinate when the job fails, and the failure propagates", async () => {
    const events: string[] = [];
    const { spawn, kill } = fakeSpawn(events);
    await expect(
      withKeepAwake(
        async () => {
          events.push("work");
          throw new Error("job failed");
        },
        { platform: "darwin", pid: 1, spawn },
      ),
    ).rejects.toThrow("job failed");
    expect(kill).toHaveBeenCalledOnce();
    expect(events).toEqual(["spawn /usr/bin/caffeinate -i -w 1", "work", "kill"]);
  });

  it("spawns nothing on Linux", async () => {
    const { spawn } = fakeSpawn([]);
    expect(await withKeepAwake(async () => "ok", { platform: "linux", spawn })).toBe("ok");
    expect(spawn).not.toHaveBeenCalled();
  });
});
