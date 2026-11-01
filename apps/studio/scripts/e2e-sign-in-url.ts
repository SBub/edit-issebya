// Prints a confirmation URL that signs a reviewer in to the studio on the
// local stack, without any email. Local only: the admin helper refuses a
// non-local Supabase URL. The review user gets three sample reels, one of them
// processed with a live preview, seeded from `fixtures/pipeline/` into this
// worktree's `.e2e-storage/` (the dev server needs `E2E_MOCK_STORAGE=true`);
// its page is printed on stderr. Usage:
//   PORT=<run port> yarn workspace @edit-issebya/studio e2e:sign-in-url
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { insertReel, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { seedProcessedReel } from "../test-support/pipeline.ts";

const EMAIL = "studio-review@example.test";
const PORT = process.env.PORT ?? "3000";
const PROCESSED_NAME = "sample-processed-take.mp4";
const PREFIX = "review/";

const admin = localSupabaseAdmin();
const storage = fakeStorage({ root: e2eStorageRoot(), uploadUrlBase: "" });

async function reviewUserId(): Promise<string> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((user) => user.email === EMAIL);
    if (found) return found.id;
    if (data.users.length < 1000) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email: EMAIL, email_confirm: true });
  if (error || !data.user) throw new Error(`review user not created: ${error?.message}`);
  return data.user.id;
}

const ownerId = await reviewUserId();
const { count, error } = await admin
  .from("reels")
  .select("id", { count: "exact", head: true })
  .eq("owner_id", ownerId);
if (error) throw new Error(`reels not counted: ${error.message}`);
if (!count) {
  await insertReel(admin, {
    ownerId,
    name: "sample-first-take.mov",
    status: "uploaded",
    createdAt: "2026-01-01T09:00:00Z",
  });
  await insertReel(admin, {
    ownerId,
    name: "sample-second-take.mov",
    status: "received",
    createdAt: "2026-02-01T09:00:00Z",
  });
}

// The received sample shows a finished job and its step log.
const { data: received, error: receivedError } = await admin
  .from("reels")
  .select("id")
  .eq("owner_id", ownerId)
  .eq("status", "received")
  .limit(1)
  .maybeSingle();
if (receivedError) throw new Error(`received reel not read: ${receivedError.message}`);
if (received) {
  const { count: jobs, error: jobsError } = await admin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("reel_id", received.id);
  if (jobsError) throw new Error(`jobs not counted: ${jobsError.message}`);
  if (!jobs) {
    const now = new Date().toISOString();
    const { data: job, error: jobError } = await admin
      .from("jobs")
      .insert({
        reel_id: received.id,
        owner_id: ownerId,
        status: "done",
        attempts: 1,
        started_at: now,
        finished_at: now,
      })
      .select("id")
      .single();
    if (jobError || !job) throw new Error(`sample job not inserted: ${jobError?.message}`);
    const { error: stepError } = await admin.from("steps").insert({
      job_id: job.id,
      reel_id: received.id,
      owner_id: ownerId,
      name: "receive",
      status: "done",
      summary: "footage received, 12.3 MB",
      finished_at: now,
    });
    if (stepError) throw new Error(`sample step not inserted: ${stepError.message}`);
  }
}

// The processed sample shows the live preview. Its rows are in the shared
// stack but its objects only in the worktree that seeded it, so a reel whose
// version object is missing here is replaced, never patched.
const { data: processed, error: processedError } = await admin
  .from("reels")
  .select("id, current_version_id")
  .eq("owner_id", ownerId)
  .eq("source_name", PROCESSED_NAME)
  .limit(1)
  .maybeSingle();
if (processedError) throw new Error(`processed reel not read: ${processedError.message}`);
let processedId: string | null = null;
if (processed?.current_version_id) {
  const { data: version, error: versionError } = await admin
    .from("versions")
    .select("r2_key")
    .eq("id", processed.current_version_id)
    .single();
  if (versionError) throw new Error(`processed version not read: ${versionError.message}`);
  if (await storage.get(version.r2_key as string)) processedId = processed.id as string;
}
if (!processedId) {
  if (processed) {
    const { error: deleteError } = await admin.from("reels").delete().eq("id", processed.id);
    if (deleteError) throw new Error(`stale processed reel not deleted: ${deleteError.message}`);
  }
  processedId = await insertReel(admin, {
    ownerId,
    name: PROCESSED_NAME,
    status: "uploaded",
    createdAt: "2026-03-01T09:00:00Z",
  });
  await seedProcessedReel(admin, storage, { prefix: PREFIX, reelId: processedId });
}
console.error(`processed sample reel: http://localhost:${PORT}/studio/reels/${processedId}`);

console.log(await signInLink(admin, EMAIL, `http://localhost:${PORT}`));
