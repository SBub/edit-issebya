import { describe, expect, it } from "vitest";
import { buildBuyerEmail, buildOwnerNotice, escapeHtml } from "./confirmation-email";

const BOOKING_URL = "https://booking.example.com/call";
const TERMS_URL = "https://edit.issebya.com/terms#withdrawal";

// The owner's copy, character for character, for the name "Ana Test".
const EXPECTED_TEXT = `Hi Ana Test,

Thank you, your payment is confirmed. I'm looking forward to working on your reels.

Next step: book your discovery call
Pick a time that works for you:
👉 Book your call: https://booking.example.com/call

On the call, we'll go through your brand, your audience and what makes you different. I use that to design the visual identity for your reels.

How to prepare
The more I know before the call, the sharper your visual identity will be. Please have these ready:

- Your ICP: who you want to reach. Their role, industry, what keeps them up at night.
- Your UVP: what makes you different from others in your space, in a sentence or two.
- Brand assets: logo, colours and fonts, if you have them.
- References: 2 or 3 reels or accounts whose look you like (they don't have to be in your industry).
- Your channels: links to the profiles where the reels will go.

Rough notes are fine. We'll sharpen them together on the call.

What happens after the call
1. I send you a proposed visual identity for your reels, along with a recording guide.
2. Once your visual identity is ready, your 30 days start. Send me footage for all 8 reels within that time.
3. For each reel, you send the A and B roll, and I deliver the edited reel within 24 hours.

Work starts right away. See https://edit.issebya.com/terms#withdrawal for cancellations

If anything comes up, just reply to this email.

Talk soon,
Sveta`;

describe("the buyer email", () => {
  it("has the exact subject and plain text", () => {
    const email = buildBuyerEmail({
      name: "  Ana Test ",
      bookingUrl: BOOKING_URL,
      termsUrl: TERMS_URL,
    });
    expect(email.subject).toBe("You're in. Let's book your discovery call");
    expect(email.text).toBe(EXPECTED_TEXT);
  });

  it("is deterministic", () => {
    const a = buildBuyerEmail({ name: "Ana Test", bookingUrl: BOOKING_URL, termsUrl: TERMS_URL });
    const b = buildBuyerEmail({ name: "Ana Test", bookingUrl: BOOKING_URL, termsUrl: TERMS_URL });
    expect(a).toEqual(b);
  });

  it("has simple HTML: the booking and terms links, the three headings in bold, both lists", () => {
    const { html } = buildBuyerEmail({
      name: "Ana Test",
      bookingUrl: BOOKING_URL,
      termsUrl: TERMS_URL,
    });
    expect(html).toContain(`👉 <a href="${BOOKING_URL}">Book your call</a>`);
    expect(html).toContain(`See <a href="${TERMS_URL}">${TERMS_URL}</a> for cancellations`);
    expect(html.match(/<a /g)).toHaveLength(2);
    for (const heading of [
      "Next step: book your discovery call",
      "How to prepare",
      "What happens after the call",
    ]) {
      expect(html).toContain(`<strong>${heading}</strong>`);
    }
    expect(html.match(/<li>/g)).toHaveLength(8);
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).not.toMatch(/<img|<style|<link|style=/);
  });

  it("escapes the name in HTML and keeps it verbatim in plain text", () => {
    const email = buildBuyerEmail({
      name: "<b>x</b>",
      bookingUrl: BOOKING_URL,
      termsUrl: TERMS_URL,
    });
    expect(email.html).toContain("Hi &lt;b&gt;x&lt;/b&gt;,");
    expect(email.html).not.toContain("<b>x</b>");
    expect(email.text.startsWith("Hi <b>x</b>,\n")).toBe(true);
  });

  it("never reads a $ in the name as a replacement pattern", () => {
    expect(
      buildBuyerEmail({ name: "A$&B", bookingUrl: BOOKING_URL, termsUrl: TERMS_URL }).text,
    ).toMatch(/^Hi A\$&B,/);
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("the owner notice", () => {
  it("lists the metadata in form then UTM order, then the session facts", () => {
    const notice = buildOwnerNotice({
      sessionId: "cs_test_1",
      metadata: {
        utm_campaign: "spring",
        terms_accepted: "true",
        newsletter: "true",
        socials: "https://instagram.com/ana\nhttps://ana.example.com/",
        email: "ana@example.com",
        name: "Ana Test",
        utm_source: "ig",
        unrelated: "never shown",
      },
      amountTotal: 99000,
      currency: "eur",
    });
    expect(notice.subject).toBe("New payment: Ana Test");
    expect(notice.text).toBe(
      [
        "name: Ana Test",
        "email: ana@example.com",
        "socials:",
        "https://instagram.com/ana",
        "https://ana.example.com/",
        "terms_accepted: true",
        "newsletter: true",
        "utm_source: ig",
        "utm_campaign: spring",
        "",
        "session: cs_test_1",
        "amount_total: 99000",
        "currency: eur",
        "",
      ].join("\n"),
    );
    expect(notice).not.toHaveProperty("html");
  });
});
