// Prints a confirmation URL that signs a reviewer in to the studio on the
// local stack, without any email. Local only: the admin helper refuses a
// non-local Supabase URL. Usage:
//   PORT=<run port> yarn workspace @edit-issebya/studio e2e:sign-in-url
import { insertReel, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

const EMAIL = "studio-review@example.test";
const PORT = process.env.PORT ?? "3000";

const admin = localSupabaseAdmin();

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

console.log(await signInLink(admin, EMAIL, `http://localhost:${PORT}`));
