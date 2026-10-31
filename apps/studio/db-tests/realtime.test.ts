import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

const WINDOW_MS = 5_000;

const admin = localSupabaseAdmin();
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let reelA: string;
const clients: SupabaseClient[] = [];
const channels: RealtimeChannel[] = [];

beforeAll(async () => {
  userA = await createTestUser(admin, "rt-a");
  userB = await createTestUser(admin, "rt-b");
  reelA = await insertReel(admin, { ownerId: userA.id, name: "rt.mov" });
});

afterAll(async () => {
  for (const [i, channel] of channels.entries()) await clients[i]?.removeChannel(channel);
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

async function subscribe(email: string, label: string, onUpdate: (payload: unknown) => void) {
  const { client, session } = await signedInClient(admin, email);
  await client.realtime.setAuth(session.access_token);
  const channel = client.channel(`reels-${label}-${crypto.randomUUID()}`);
  clients.push(client);
  channels.push(channel);
  // SUBSCRIBED arrives before the server has attached the postgres_changes
  // listener; its "Subscribed to PostgreSQL" system message is the real ready
  // signal, so an update sent earlier could be missed.
  await new Promise<void>((resolve, reject) => {
    channel
      .on("system", {}, (message: { extension?: string; status?: string }) => {
        if (message.extension !== "postgres_changes") return;
        if (message.status === "ok") resolve();
        else reject(new Error(`postgres_changes not attached: ${JSON.stringify(message)}`));
      })
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "reels", filter: `id=eq.${reelA}` },
        onUpdate,
      )
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          reject(err ?? new Error(`channel ${status}`));
        }
      });
  });
}

it("delivers the owner's change to the owner and nothing to another user", async () => {
  const seenByA: unknown[] = [];
  const seenByB: unknown[] = [];
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => (arrived = resolve));

  await subscribe(userA.email, "a", (payload) => {
    seenByA.push(payload);
    arrived();
  });
  await subscribe(userB.email, "b", (payload) => seenByB.push(payload));

  const { error } = await admin.from("reels").update({ status: "uploaded" }).eq("id", reelA);
  expect(error).toBeNull();

  // Positive control: A hears it within the window.
  await Promise.race([
    arrival,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("A received nothing")), WINDOW_MS),
    ),
  ]);
  expect(seenByA).toHaveLength(1);

  // Negative half: wait the full window after A's arrival, so a late leak is caught.
  await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
  expect(seenByB).toEqual([]);
}, 30_000);
