import type { HttpClient } from "./apply.ts";
import { POSTHOG_HOST } from "./config.ts";
import type { Json } from "./payloads.ts";

// The real PostHog client: Bearer personal API key, JSON in and out. A `next`
// URL is followed only on the same host, so the key never leaves PostHog. The
// key is never logged; an error names the method, path, status and body.

export function posthogClient(apiKey: string, host: string = POSTHOG_HOST): HttpClient {
  const base = new URL(host);

  async function send(method: string, pathOrUrl: string, body?: Json): Promise<unknown> {
    const url = new URL(pathOrUrl, base);
    if (url.origin !== base.origin) {
      throw new Error(`refusing to send the key to ${url.origin} (expected ${base.origin})`);
    }
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${url.pathname}${url.search} failed: ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    get: (pathOrUrl) => send("GET", pathOrUrl),
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
  };
}
