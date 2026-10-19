import {
  BOOKING_LINK_TEXT,
  BOOKING_TOKEN,
  CONFIRMATION_EMAIL,
  NAME_TOKEN,
  type EmailBlock,
} from "../content/confirmation-email";
import { CALL_REQUEST_FIELDS } from "./call-request";
import { UTM_KEYS } from "./utm";

// The two emails sent after a paid Checkout Session. Pure and deterministic:
// the same input always gives the same bodies (no timestamps, no random ids),
// because Resend rejects a reused idempotency key with a different payload.

export interface BuiltEmail {
  subject: string;
  text: string;
  html?: string;
}

// Plain string replacement: split and join, so a `$` in a name is never read
// as a replacement pattern.
function fill(line: string, token: string, value: string): string {
  return line.split(token).join(value);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textLine(line: string, name: string, bookingUrl: string): string {
  return fill(fill(line, NAME_TOKEN, name), BOOKING_TOKEN, `${BOOKING_LINK_TEXT}: ${bookingUrl}`);
}

function htmlLine(line: string, name: string, bookingUrl: string): string {
  const link = `<a href="${escapeHtml(bookingUrl)}">${BOOKING_LINK_TEXT}</a>`;
  return fill(fill(escapeHtml(line), NAME_TOKEN, escapeHtml(name)), BOOKING_TOKEN, link);
}

function blockText(block: EmailBlock, name: string, bookingUrl: string): string {
  switch (block.kind) {
    case "paragraph":
      return [...(block.heading ? [block.heading] : []), ...block.lines]
        .map((line) => textLine(line, name, bookingUrl))
        .join("\n");
    case "bullets":
      return block.items.map((item) => `- ${item}`).join("\n");
    case "steps":
      return [block.heading, ...block.items.map((item, index) => `${index + 1}. ${item}`)].join(
        "\n",
      );
  }
}

function blockHtml(block: EmailBlock, name: string, bookingUrl: string): string {
  switch (block.kind) {
    case "paragraph": {
      const lines = block.lines.map((line) => htmlLine(line, name, bookingUrl));
      const heading = block.heading ? [`<strong>${escapeHtml(block.heading)}</strong>`] : [];
      return `<p>${[...heading, ...lines].join("<br>\n")}</p>`;
    }
    case "bullets":
      return `<ul>\n${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n")}\n</ul>`;
    case "steps":
      return [
        `<p><strong>${escapeHtml(block.heading)}</strong></p>`,
        `<ol>\n${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n")}\n</ol>`,
      ].join("\n");
  }
}

/** The buyer's confirmation email: the owner's copy with the name and booking link filled in. */
export function buildBuyerEmail({
  name,
  bookingUrl,
}: {
  name: string;
  bookingUrl: string;
}): Required<BuiltEmail> {
  const trimmed = name.trim();
  const blocks: readonly EmailBlock[] = CONFIRMATION_EMAIL.blocks;
  return {
    subject: CONFIRMATION_EMAIL.subject,
    text: blocks.map((block) => blockText(block, trimmed, bookingUrl)).join("\n\n"),
    html: `${blocks.map((block) => blockHtml(block, trimmed, bookingUrl)).join("\n")}\n`,
  };
}

// The metadata keys the owner sees, in form order, the newsletter choice, then
// UTM order. The form's `terms` field travels as `terms_accepted`
// (toCheckoutMetadata).
const OWNER_NOTICE_KEYS: readonly string[] = [
  ...CALL_REQUEST_FIELDS.map((field) => (field === "terms" ? "terms_accepted" : field)),
  "newsletter",
  ...UTM_KEYS,
];

/**
 * The owner's notice: every known metadata key and value of the session (socials
 * one link per line), then the session id, amount and currency. Plain text only.
 */
export function buildOwnerNotice({
  sessionId,
  metadata,
  amountTotal,
  currency,
}: {
  sessionId: string;
  metadata: Record<string, string>;
  amountTotal: number | null;
  currency: string | null;
}): BuiltEmail {
  const lines: string[] = [];
  for (const key of OWNER_NOTICE_KEYS) {
    const value = metadata[key];
    if (value === undefined) continue;
    if (key === "socials") {
      lines.push(value === "" ? "socials: (none)" : `socials:\n${value}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(
    "",
    `session: ${sessionId}`,
    `amount_total: ${amountTotal ?? ""}`,
    `currency: ${currency ?? ""}`,
  );
  return {
    subject: `New payment: ${(metadata.name ?? "").trim()}`,
    text: `${lines.join("\n")}\n`,
  };
}
