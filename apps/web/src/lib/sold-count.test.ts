import { describe, expect, it } from "vitest";
import { countSold, isSoldSession } from "./sold-count";

const SOLD = { status: "complete", payment_status: "paid", metadata: { offer: "reels-8" } };

async function* pages<T>(...items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("isSoldSession", () => {
  it("counts only complete, paid sessions of this offer", () => {
    expect(isSoldSession(SOLD)).toBe(true);
    expect(isSoldSession({ ...SOLD, status: "open" })).toBe(false);
    expect(isSoldSession({ ...SOLD, status: "expired" })).toBe(false);
    expect(isSoldSession({ ...SOLD, payment_status: "unpaid" })).toBe(false);
    expect(isSoldSession({ ...SOLD, metadata: { offer: "other" } })).toBe(false);
    expect(isSoldSession({ ...SOLD, metadata: {} })).toBe(false);
    expect(isSoldSession({ ...SOLD, metadata: null })).toBe(false);
  });
});

describe("countSold", () => {
  it("walks every session and counts the sold ones", async () => {
    expect(await countSold(pages())).toBe(0);
    expect(
      await countSold(
        pages(SOLD, { ...SOLD, payment_status: "unpaid" }, SOLD, { ...SOLD, metadata: null }, SOLD),
      ),
    ).toBe(3);
  });
});
