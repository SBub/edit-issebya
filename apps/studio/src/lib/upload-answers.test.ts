import { describe, expect, it, vi } from "vitest";
import { observeUploadAnswers } from "./upload-answers";

const ENDPOINT = "/studio/api/uploads";

function target(answer: () => Response) {
  const original = vi.fn(async () => answer()) as unknown as typeof fetch;
  return { fetch: original, original };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("observeUploadAnswers", () => {
  it("records a failed upload route answer with its status and error code", async () => {
    const t = target(() => json(500, { error: "failed" }));
    const observer = observeUploadAnswers(t, ENDPOINT);
    const response = await t.fetch("/studio/api/uploads/s3/multipart", { method: "POST" });
    expect(observer.last()).toEqual({ status: 500, error: "failed" });
    // The caller still reads the body.
    expect(await response.json()).toEqual({ error: "failed" });
    observer.stop();
  });

  it("ignores an ok answer and another endpoint's error", async () => {
    let answer = json(200, { key: "k" });
    const t = target(() => answer);
    const observer = observeUploadAnswers(t, ENDPOINT);
    await t.fetch("/studio/api/uploads/s3/multipart");
    answer = json(500, { error: "failed" });
    await t.fetch("https://example.test/other");
    await t.fetch(new URL("http://localhost/studio/reels"));
    expect(observer.last()).toBeNull();
    observer.stop();
  });

  it("records a non-JSON answer with error null", async () => {
    const t = target(() => new Response("<html>bad gateway</html>", { status: 503 }));
    const observer = observeUploadAnswers(t, ENDPOINT);
    await t.fetch(new Request("http://localhost/studio/api/uploads/s3/multipart/u/complete"));
    expect(observer.last()).toEqual({ status: 503, error: null });
    observer.stop();
  });

  it("restores the original fetch on stop, only while its wrapper is installed", () => {
    const t = target(() => json(200, {}));
    const observer = observeUploadAnswers(t, ENDPOINT);
    expect(t.fetch).not.toBe(t.original);
    observer.stop();
    expect(t.fetch).toBe(t.original);

    const again = observeUploadAnswers(t, ENDPOINT);
    const other = vi.fn() as unknown as typeof fetch;
    t.fetch = other;
    again.stop();
    expect(t.fetch).toBe(other);
  });
});
