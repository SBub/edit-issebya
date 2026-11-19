import { describe, expect, it } from "vitest";
import { cardinal, spokenParts } from "./spoken-form.ts";

// One written word as it is said.
const said = (text: string) => spokenParts([text], "en")[0]!.join(" ");

describe("spokenParts: years", () => {
  it.each([
    ["2027", "twenty twenty seven"],
    ["2027.", "twenty twenty seven"],
    ["(2027)", "twenty twenty seven"],
    ["2000", "two thousand"],
    ["2005", "two thousand five"],
    ["2010", "twenty ten"],
    ["1999", "nineteen ninety nine"],
    ["1905", "nineteen oh five"],
    ["1900", "nineteen hundred"],
  ])("%s is %s", (text, spoken) => {
    expect(said(text)).toBe(spoken);
  });

  it("reads four digits outside 1100 to 2099 as a count", () => {
    expect(said("2100")).toBe("two thousand one hundred");
    expect(said("1000")).toBe("one thousand");
  });

  it("reads decades", () => {
    expect(said("1990s")).toBe("nineteen nineties");
    expect(said("80s")).toBe("eighties");
    expect(said("20's")).toBe("twenties");
  });
});

describe("spokenParts: numbers", () => {
  it.each([
    ["0", "zero"],
    ["7", "seven"],
    ["13", "thirteen"],
    ["42", "forty two"],
    ["100", "one hundred"],
    ["415", "four hundred fifteen"],
    ["10000", "ten thousand"],
    ["1000000", "one million"],
  ])("counts %s as %s", (text, spoken) => {
    expect(said(text)).toBe(spoken);
  });

  it("reads thousands separators as one number, never as a year", () => {
    expect(said("1,000")).toBe("one thousand");
    expect(said("2,027")).toBe("two thousand twenty seven");
    expect(said("1,250,000")).toBe("one million two hundred fifty thousand");
  });

  it("reads a leading zero or a very long number digit by digit", () => {
    expect(said("007")).toBe("zero zero seven");
    expect(cardinal("1234567890123456")).toHaveLength(16);
  });

  it("reads decimals with point and the digits after it one by one", () => {
    expect(said("3.5")).toBe("three point five");
    expect(said("0.25")).toBe("zero point two five");
    // A full stop after a number is not a decimal point.
    expect(said("3.")).toBe("three");
  });

  it.each([
    ["1st", "first"],
    ["2nd", "second"],
    ["3rd", "third"],
    ["5th", "fifth"],
    ["12th", "twelfth"],
    ["20th.", "twentieth"],
    ["21st", "twenty first"],
    ["100th", "one hundredth"],
  ])("reads the ordinal %s as %s", (text, spoken) => {
    expect(said(text)).toBe(spoken);
  });
});

describe("spokenParts: symbols", () => {
  it("reads percent, and a number before it as a count", () => {
    expect(said("50%")).toBe("fifty percent");
    expect(said("3.5%")).toBe("three point five percent");
    expect(said("2027%")).toBe("two thousand twenty seven percent");
    expect(said("%")).toBe("percent");
  });

  it.each([
    ["$20", "twenty dollars"],
    ["$1", "one dollar"],
    ["$2000", "two thousand dollars"],
    ["$3.50", "three dollars fifty"],
    ["$20.00", "twenty dollars"],
    ["$5k", "five k dollars"],
    ["€20", "twenty euros"],
    ["£5", "five pounds"],
    ["20€", "twenty euros"],
    ["$", "dollars"],
  ])("reads the amount %s as %s", (text, spoken) => {
    expect(said(text)).toBe(spoken);
  });

  it("says the unit after a magnitude word that follows the amount", () => {
    expect(spokenParts(["$3.5", "million", "in", "$1", "billion.", "$20", "more"], "en")).toEqual([
      ["three", "point", "five"],
      ["million", "dollars"],
      ["in"],
      ["one"],
      ["billion.", "dollars"],
      ["twenty", "dollars"],
      ["more"],
    ]);
  });

  it("reads and, plus, at, equals, degrees, number", () => {
    expect(said("&")).toBe("and");
    expect(said("R&D")).toBe("R and D");
    expect(said("18+")).toBe("eighteen plus");
    expect(said("1+1=2")).toBe("one plus one equals two");
    expect(said("@home")).toBe("at home");
    expect(said("-5°")).toBe("minus five degrees");
    expect(said("#1")).toBe("number one");
  });

  it("reads a time", () => {
    expect(said("9:30")).toBe("nine thirty");
    expect(said("9:05")).toBe("nine oh five");
    expect(said("9:00")).toBe("nine");
    expect(said("9:30am")).toBe("nine thirty am");
  });

  it("reads a slash as its numbers, the common fractions as fractions, a dash as to", () => {
    expect(said("24/7")).toBe("twenty four seven");
    expect(said("50/50")).toBe("fifty fifty");
    expect(said("1/2")).toBe("one half");
    expect(said("3/4")).toBe("three quarters");
    expect(said("10-15")).toBe("ten to fifteen");
    expect(said("16:9")).toBe("sixteen nine");
  });

  it("keeps the letters next to digits", () => {
    expect(said("COVID-19")).toBe("COVID nineteen");
    expect(said("5G")).toBe("five G");
  });
});

describe("spokenParts: what it leaves alone", () => {
  it("returns a word of letters as written, punctuation included", () => {
    expect(spokenParts(["Don't,", "twenty-seven", "U.S.", "million"], "en")).toEqual([
      ["Don't,"],
      ["twenty-seven"],
      ["U.S."],
      ["million"],
    ]);
  });

  it("says nothing for punctuation alone", () => {
    expect(spokenParts(["-", "..."], "en")).toEqual([["-"], ["..."]]);
  });

  it("keeps every word as written in a language it has no reading for", () => {
    expect(spokenParts(["2027", "50%", "$20"], "ru")).toEqual([["2027"], ["50%"], ["$20"]]);
  });

  it("never changes the texts it was given", () => {
    const texts = Object.freeze(["2027.", "50%"]);
    spokenParts(texts, "en");
    expect(texts).toEqual(["2027.", "50%"]);
  });
});
