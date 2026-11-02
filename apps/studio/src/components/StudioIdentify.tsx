"use client";

import { useEffect } from "react";
import { identify } from "@/lib/track";

// Identifies the signed-in user with PostHog on every signed-in page load
// (persistence is memory-only, so nothing carries over). Syncing an external
// system is what an effect is for. Renders nothing.
export function StudioIdentify({ userId }: { userId: string }) {
  useEffect(() => {
    identify(userId);
  }, [userId]);
  return null;
}
