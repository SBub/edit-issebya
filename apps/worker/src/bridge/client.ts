import { request as httpRequest } from "node:http";
import { HEALTH_PATH, RUN_PATH, TOKEN_HEADER, type RunRequest, parseFrame } from "./protocol.ts";

// The bridge answered with a refusal or a failure (a bad token, arguments it
// does not allow, a program it could not start).
export class BridgeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeRefused";
  }
}

export interface BridgeExit {
  code: number | null;
  signal: string | null;
}

export interface BridgeCall extends RunRequest {
  url: string;
  token: string;
  signal?: AbortSignal;
  onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}

// Runs one call on a bridge: streams its output to onOutput and resolves with
// the program's exit. Rejects with BridgeRefused when the bridge refuses or
// fails, or with a plain Error when it cannot be reached.
export function callBridge(call: BridgeCall): Promise<BridgeExit> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ argv: call.argv, cwd: call.cwd, stdin: call.stdin });
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const req = httpRequest(
      new URL(RUN_PATH, call.url),
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          [TOKEN_HEADER]: call.token,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () =>
            settle(() => {
              let reason = text.trim();
              try {
                const parsed = JSON.parse(text) as { error?: unknown };
                if (typeof parsed.error === "string") reason = parsed.error;
              } catch {
                // The body is not JSON: keep the text.
              }
              reject(new BridgeRefused(`HTTP ${res.statusCode}: ${reason}`));
            }),
          );
          return;
        }
        let pending = "";
        let exit: BridgeExit | null = null;
        res.setEncoding("utf8");
        res.on("data", (text: string) => {
          pending += text;
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            newline = pending.indexOf("\n");
            if (line === "") continue;
            let frame;
            try {
              frame = parseFrame(line);
            } catch (error) {
              req.destroy();
              settle(() => reject(error instanceof Error ? error : new Error(String(error))));
              return;
            }
            if ("out" in frame) {
              call.onOutput(frame.out, Buffer.from(frame.data, "base64"));
            } else if ("exit" in frame) {
              exit = frame.exit;
            } else {
              settle(() => reject(new BridgeRefused(frame.error)));
              req.destroy();
              return;
            }
          }
        });
        res.on("end", () =>
          settle(() => {
            if (exit) resolve(exit);
            else reject(new Error("the bridge closed the connection before the program exited"));
          }),
        );
        res.on("error", (error) =>
          settle(() => reject(new Error(`the bridge connection failed: ${error.message}`))),
        );
      },
    );
    req.on("error", (error) =>
      settle(() => reject(new Error(`cannot reach the bridge at ${call.url}: ${error.message}`))),
    );
    call.signal?.addEventListener("abort", () => {
      req.destroy();
      settle(() => reject(new Error("the call was aborted")));
    });
    req.end(body);
  });
}

// The bridge's health answer: its name, when it is up and answers.
export async function checkBridgeHealth(url: string): Promise<string> {
  const response = await fetch(new URL(HEALTH_PATH, url), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const body = (await response.json()) as { ok?: unknown; name?: unknown };
  if (body.ok !== true) throw new Error(`${url} did not answer ok`);
  return typeof body.name === "string" ? body.name : "bridge";
}
