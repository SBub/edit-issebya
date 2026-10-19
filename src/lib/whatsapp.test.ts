import { describe, expect, it } from "vitest";
import { whatsAppUrl } from "./whatsapp";

const NUMBER = "351920742845";
const TEXT = "Hi, I saw your reel editing offer and have a few questions before I start";

describe("whatsAppUrl", () => {
  it("builds a wa.me link with the number and the encoded text", () => {
    const url = whatsAppUrl(NUMBER, TEXT);
    expect(url).toBe(`https://wa.me/351920742845?text=${encodeURIComponent(TEXT)}`);
    expect(url.startsWith("https://wa.me/351920742845?text=")).toBe(true);
  });

  it("gives the text back exactly, comma included", () => {
    expect(new URL(whatsAppUrl(NUMBER, TEXT)).searchParams.get("text")).toBe(TEXT);
  });

  it("round-trips reserved characters and spaces", () => {
    const text = "A & B? See #1 and 2 + 2 = 4";
    expect(new URL(whatsAppUrl(NUMBER, text)).searchParams.get("text")).toBe(text);
  });
});
