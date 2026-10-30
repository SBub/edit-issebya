// The owner's per-device analytics opt-out. `?notrack` on any page stores
// NOTRACK_KEY = "1" in localStorage, `?track` removes it, and both parameters
// are then removed from the address bar. While the flag is set, PostHog is
// never initialised and no event is captured (see app_docs/analytics.md).
// Every storage access is wrapped: localStorage can throw (private mode,
// blocked storage), and then tracking simply stays on.

export const NOTRACK_KEY = "edit_notrack";

const PARAMS = ["notrack", "track"] as const;

/** Storage as far as the flag needs it; window.localStorage satisfies it. */
export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `?notrack` disables, `?track` enables (notrack wins if both), else null. */
export function notrackAction(search: string): "disable" | "enable" | null {
  const params = new URLSearchParams(search);
  if (params.has("notrack")) return "disable";
  if (params.has("track")) return "enable";
  return null;
}

/** The search string without the two switches, "" when nothing is left. */
export function searchWithoutSwitches(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of PARAMS) params.delete(name);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * Applies `?notrack` / `?track` to storage. Returns the cleaned search string
 * when a switch was present (the caller replaces the URL with it), else null.
 */
export function applyNotrackSwitch(
  storage: FlagStorage | undefined,
  search: string,
): string | null {
  const action = notrackAction(search);
  if (action === null) return null;
  try {
    if (action === "disable") storage?.setItem(NOTRACK_KEY, "1");
    else storage?.removeItem(NOTRACK_KEY);
  } catch {
    // Storage unavailable: the switch cannot be remembered on this device.
  }
  return searchWithoutSwitches(search);
}

/** Whether this device opted out. Never throws; false when storage fails. */
export function isTrackingDisabled(storage: FlagStorage | undefined): boolean {
  try {
    return storage?.getItem(NOTRACK_KEY) === "1";
  } catch {
    return false;
  }
}

/** window.localStorage, or undefined outside a browser or when access throws. */
export function browserStorage(): FlagStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
