import { describe, expect, it } from "vitest";
import {
  decideWebhook,
  E2E_EMAIL_CONFIG,
  E2E_MOCK_RESEND_KEY,
  E2E_MOCK_WEBHOOK_SECRET,
  readEmailConfig,
  webhookSecret,
  type WebhookFacts,
} from "./webhook-config";

const FULL = {
  STRIPE_SECRET_KEY: "sk_test_x",
  RESEND_API_KEY: "re_x",
  EMAIL_FROM: "Sveta <sveta@example.com>",
  EMAIL_REPLY_TO: "owner@example.com",
  BOOKING_URL: "https://cal.example.com/call",
};
const OFF = { keyMissing: false, configMissing: false };

describe("webhookSecret", () => {
  it("reads STRIPE_WEBHOOK_SECRET, null when unset or blank", () => {
    expect(webhookSecret({ STRIPE_WEBHOOK_SECRET: " whsec_x " })).toBe("whsec_x");
    expect(webhookSecret({})).toBeNull();
    expect(webhookSecret({ STRIPE_WEBHOOK_SECRET: " " })).toBeNull();
  });

  it("is always the mock secret under the Stripe flag, and never without it", () => {
    expect(webhookSecret({ E2E_MOCK_STRIPE: "true", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toBe(
      E2E_MOCK_WEBHOOK_SECRET,
    );
    expect(webhookSecret({ E2E_MOCK_STRIPE: "TRUE" })).toBeNull();
  });
});

describe("readEmailConfig", () => {
  it("returns the config when everything is set", () => {
    expect(readEmailConfig(FULL, OFF)).toEqual({
      ok: true,
      config: {
        stripeKey: "sk_test_x",
        resendKey: "re_x",
        from: FULL.EMAIL_FROM,
        replyTo: FULL.EMAIL_REPLY_TO,
        bookingUrl: FULL.BOOKING_URL,
        termsUrl: "http://localhost:3000/terms#withdrawal",
      },
    });
  });

  it("links the withdrawal terms on the public site", () => {
    const result = readEmailConfig(
      { ...FULL, NEXT_PUBLIC_SITE_URL: "https://edit.issebya.com/" },
      OFF,
    );
    expect(result.ok && result.config.termsUrl).toBe("https://edit.issebya.com/terms#withdrawal");
    const vercel = readEmailConfig(
      { ...FULL, VERCEL_PROJECT_PRODUCTION_URL: "edit.issebya.com" },
      OFF,
    );
    expect(vercel.ok && vercel.config.termsUrl).toBe("https://edit.issebya.com/terms#withdrawal");
  });

  it("reports each missing variable by name", () => {
    for (const name of Object.keys(FULL) as (keyof typeof FULL)[]) {
      expect(readEmailConfig({ ...FULL, [name]: "" }, OFF)).toMatchObject({
        ok: false,
        missing: [name],
      });
    }
    expect(readEmailConfig({}, OFF)).toEqual({
      ok: false,
      stripeKey: null,
      missing: [
        "STRIPE_SECRET_KEY",
        "RESEND_API_KEY",
        "EMAIL_FROM",
        "EMAIL_REPLY_TO",
        "BOOKING_URL",
      ],
    });
  });

  it("rejects a BOOKING_URL that is not https", () => {
    for (const url of ["http://cal.example.com/call", "cal.example.com", "javascript:alert(1)"]) {
      expect(readEmailConfig({ ...FULL, BOOKING_URL: url }, OFF)).toEqual({
        ok: false,
        stripeKey: "sk_test_x",
        missing: ["BOOKING_URL"],
      });
    }
  });

  it("uses the fixed e2e values and the mock keys under both flags", () => {
    const result = readEmailConfig({ E2E_MOCK_STRIPE: "true", E2E_MOCK_RESEND: "true" }, OFF);
    expect(result).toEqual({
      ok: true,
      config: {
        stripeKey: "sk_test_e2e_mock",
        resendKey: E2E_MOCK_RESEND_KEY,
        ...E2E_EMAIL_CONFIG,
      },
    });
  });

  it("treats BOOKING_URL as missing under the configMissing toggle, only with the flag", () => {
    const mocked = { E2E_MOCK_STRIPE: "true", E2E_MOCK_RESEND: "true" };
    expect(readEmailConfig(mocked, { keyMissing: false, configMissing: true })).toEqual({
      ok: false,
      stripeKey: "sk_test_e2e_mock",
      missing: ["BOOKING_URL"],
    });
    expect(readEmailConfig(FULL, { keyMissing: false, configMissing: true }).ok).toBe(true);
  });
});

describe("decideWebhook", () => {
  const base: WebhookFacts = {
    secretSet: true,
    signatureValid: true,
    eventType: "checkout.session.completed",
    missingConfig: [],
  };
  const paid = { paymentStatus: "paid", alreadySent: false };

  it.each([
    ["no webhook secret", { ...base, secretSet: false, signatureValid: false }, 500],
    ["a bad or missing signature", { ...base, signatureValid: false }, 400],
    ["an unhandled event type", { ...base, eventType: "invoice.paid" }, 200],
    ["no Stripe key", { ...base, missingConfig: ["STRIPE_SECRET_KEY"] }, 500],
    ["a session not paid yet", { ...base, session: { ...paid, paymentStatus: "unpaid" } }, 200],
    ["a session already flagged", { ...base, session: { ...paid, alreadySent: true } }, 200],
    [
      "already flagged even with config missing",
      { ...base, missingConfig: ["BOOKING_URL"], session: { ...paid, alreadySent: true } },
      200,
    ],
    ["a missing Resend key", { ...base, missingConfig: ["RESEND_API_KEY"], session: paid }, 500],
    ["a missing sender", { ...base, missingConfig: ["EMAIL_FROM"], session: paid }, 500],
    ["a missing reply-to", { ...base, missingConfig: ["EMAIL_REPLY_TO"], session: paid }, 500],
    ["a missing booking link", { ...base, missingConfig: ["BOOKING_URL"], session: paid }, 500],
  ] as const)("answers %s with %i", (_label, facts, status) => {
    expect(decideWebhook(facts as WebhookFacts)).toMatchObject({ action: "respond", status });
  });

  it("retrieves the session for both handled types before deciding to send", () => {
    for (const eventType of [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ]) {
      expect(decideWebhook({ ...base, eventType })).toEqual({ action: "retrieve" });
      expect(decideWebhook({ ...base, eventType, session: paid })).toEqual({ action: "send" });
    }
  });
});
