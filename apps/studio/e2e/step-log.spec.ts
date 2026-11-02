import { expect, test } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let reelId: string;

test.beforeAll(async () => {
  owner = await createTestUser(admin, "step-log");
  reelId = await insertReel(admin, {
    ownerId: owner.id,
    name: "failed-take.mov",
    status: "failed",
  });
  // A finished job: never claimable, so no worker on the stack picks it up.
  const job = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: owner.id, status: "failed", error_tail: "probe failed" })
    .select("id")
    .single();
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);
  const step = await admin.from("steps").insert({
    job_id: job.data.id,
    reel_id: reelId,
    owner_id: owner.id,
    name: "probe",
    status: "failed",
    summary: "probe failed, 2 seconds",
    error_tail: "line 99\nline 100",
  });
  if (step.error) throw new Error(`step not inserted: ${step.error.message}`);
});

test.afterAll(async () => {
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a failed step shows its summary and its error tail collapsed", async ({ page, baseURL }) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reelId}`);

  await expect(page.getByTestId("step-line")).toHaveText("probe: probe failed, 2 seconds");
  const tail = page.getByTestId("step-error-tail");
  await expect(tail).toBeVisible();
  await expect(tail.getByText("line 100")).toBeHidden();

  await tail.getByText("Show error").click();
  await expect(tail.getByText("line 100")).toBeVisible();
});
