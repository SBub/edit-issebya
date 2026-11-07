import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AiRecord, aiRecordKey, writeAiRecord } from "./ai-record.ts";

const REEL = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const RECORD: AiRecord = {
  format: 1,
  reel_id: REEL,
  version_id: VERSION,
  prompt_version: "reel-components@v1",
  hook_prompt_version: "reel-hook@v1",
  summary_prompt_version: "reel-version-summary@v1",
  calls: [],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ai-record-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the version's AI record", () => {
  it("lives beside the version's edit", () => {
    expect(aiRecordKey("dev/", REEL, VERSION)).toBe(
      `dev/reels/${REEL}/versions/${VERSION}.ai.json`,
    );
  });

  it("is written once as JSON and never rewritten", async () => {
    const storage = fakeStorage({ root, uploadUrlBase: "" });
    const key = await writeAiRecord(storage, "dev/", RECORD);
    expect(JSON.parse(new TextDecoder().decode((await storage.get(key))!))).toEqual(RECORD);
    await expect(writeAiRecord(storage, "dev/", RECORD)).rejects.toThrow(/never rewritten/);
  });
});
