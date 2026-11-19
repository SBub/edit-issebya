"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

// On the reels list: when one of the owner's exports finishes (an `exports`
// INSERT over Realtime; RLS decides what arrives), the list is read again, so
// that reel's Download icon appears without a reload. One more read when the
// subscription becomes ready covers an export that finished between the
// server's read and the subscription. It shows nothing itself: no notice, no
// sound, no dialog. No polling.
export function ExportsWatcher() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    let active = true;
    const channel = supabase
      .channel(`exports-${crypto.randomUUID()}`)
      .on("system", {}, (message: { extension?: string; status?: string }) => {
        // "Subscribed to PostgreSQL": the listener below is attached now.
        if (message.extension !== "postgres_changes" || message.status !== "ok") return;
        if (active) router.refresh();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "exports" }, () => {
        if (active) router.refresh();
      });
    // setAuth hands the session's token to Realtime before joining, so RLS
    // sees the owner.
    void supabase.realtime.setAuth().then(() => {
      if (active) channel.subscribe();
    });
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
