// Uppy's Companion client (@uppy/aws-s3 6.3.0, lib/s3-client/CompanionS3.js,
// `_fetch`) calls the global fetch and, on an answer that is not ok, throws
// only `Companion request failed: <statusText>`: the status and the JSON
// `error` code are lost, and statusText is empty over HTTP/2. This observer
// wraps fetch for the duration of one upload and remembers the last error
// answer of the studio's upload routes. Every other request passes through
// untouched. Re-check it when Uppy is upgraded.

export interface UploadErrorAnswer {
  status: number;
  /** The answer's JSON `error` code; null when absent or not JSON. */
  error: string | null;
}

export interface UploadAnswerObserver {
  last(): UploadErrorAnswer | null;
  /** Restores the original fetch, unless something else replaced the wrapper since. */
  stop(): void;
}

const BASE = "http://localhost";

function pathOf(input: RequestInfo | URL): string | null {
  try {
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    return new URL(url, BASE).pathname;
  } catch {
    return null;
  }
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    const error =
      typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}

export function observeUploadAnswers(
  target: { fetch: typeof fetch },
  endpoint: string,
): UploadAnswerObserver {
  const original = target.fetch;
  const prefix = new URL(endpoint, BASE).pathname;
  let last: UploadErrorAnswer | null = null;

  const wrapper: typeof fetch = async (input, init) => {
    const response = await original.call(target, input, init);
    const path = pathOf(input);
    if (!response.ok && path !== null && path.startsWith(prefix)) {
      last = { status: response.status, error: await errorCode(response) };
    }
    return response;
  };
  target.fetch = wrapper;

  return {
    last: () => last,
    stop() {
      if (target.fetch === wrapper) target.fetch = original;
    },
  };
}
