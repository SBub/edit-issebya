import { describe, expect, it } from "vitest";
import { canPlayFrom, whenReady } from "./media-ready";

class FakeMedia extends EventTarget {
  readyState = 4;
  seeking = false;
  currentTime = 0;
  listeners = 0;
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.listeners += 1;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.listeners -= 1;
    super.removeEventListener(...args);
  }
}

const settled = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
};

describe("canPlayFrom", () => {
  it("needs future data and no seek in flight", () => {
    const el = new FakeMedia();
    expect(canPlayFrom(el)).toBe(true);
    el.readyState = 3;
    expect(canPlayFrom(el)).toBe(true);
    el.readyState = 2;
    expect(canPlayFrom(el)).toBe(false);
    el.readyState = 4;
    el.seeking = true;
    expect(canPlayFrom(el)).toBe(false);
  });
});

describe("canPlayFrom at a time", () => {
  it("needs the element to stand at that time", () => {
    const el = new FakeMedia();
    el.currentTime = 12;
    expect(canPlayFrom(el, 12.1)).toBe(true);
    expect(canPlayFrom(el, 0)).toBe(false);
  });
});

describe("whenReady", () => {
  it("waits until a requested seek has landed", async () => {
    const el = new FakeMedia();
    const ready = whenReady([el], new AbortController().signal, 8);
    expect(await settled(ready)).toBe(false);
    el.currentTime = 8;
    el.dispatchEvent(new Event("timeupdate"));
    expect(await settled(ready)).toBe(true);
  });

  it("resolves at once when every element is ready", async () => {
    const elements = [new FakeMedia(), new FakeMedia()];
    await expect(whenReady(elements, new AbortController().signal)).resolves.toBeUndefined();
    expect(elements.map((el) => el.listeners)).toEqual([0, 0]);
  });

  it("waits for the second element", async () => {
    const slow = new FakeMedia();
    slow.readyState = 1;
    const ready = whenReady([new FakeMedia(), slow], new AbortController().signal);
    expect(await settled(ready)).toBe(false);
    slow.readyState = 3;
    slow.dispatchEvent(new Event("canplay"));
    expect(await settled(ready)).toBe(true);
    expect(slow.listeners).toBe(0);
  });

  it("is blocked by a seeking element until it has seeked", async () => {
    const seeking = new FakeMedia();
    seeking.seeking = true;
    const ready = whenReady([seeking], new AbortController().signal);
    seeking.dispatchEvent(new Event("canplaythrough"));
    expect(await settled(ready)).toBe(false);
    seeking.seeking = false;
    seeking.dispatchEvent(new Event("seeked"));
    expect(await settled(ready)).toBe(true);
  });

  it("rejects on abort and leaves no listener", async () => {
    const el = new FakeMedia();
    el.readyState = 0;
    const controller = new AbortController();
    const ready = whenReady([el], controller.signal);
    controller.abort();
    await expect(ready).rejects.toMatchObject({ name: "AbortError" });
    expect(el.listeners).toBe(0);
  });

  it("rejects at once on an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(whenReady([new FakeMedia()], controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
