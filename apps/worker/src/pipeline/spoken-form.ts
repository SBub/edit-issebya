// How a written word is said, for the word aligner only (align.ts). The
// aligner's model spells letters, so "2027", "50%" or "$20" give it nothing to
// place. Here each such word becomes the words a speaker says ("twenty twenty
// seven", "fifty percent", "twenty dollars"), which the aligner spells and
// times. The stored word and every shown text keep what Whisper wrote: nothing
// outside the aligner reads a spoken form. Where a writing has several
// readings the most common one is taken; the aligner scores each letter
// against the sound, so a small misreading moves a time by little. Pure.

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion"];
// Past the trillions (or with a leading zero) a number is read digit by digit.
const MAX_CARDINAL_DIGITS = 15;

const ORDINALS: Record<string, string> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};

// Said in place of the symbol, wherever it stands.
const SYMBOLS: Record<string, string> = {
  "%": "percent",
  "&": "and",
  "+": "plus",
  "@": "at",
  "=": "equals",
  "°": "degrees",
  "×": "times",
};

// [one, several]: "$1" is one dollar, "$20" twenty dollars.
const CURRENCIES: Record<string, [string, string]> = {
  $: ["dollar", "dollars"],
  "€": ["euro", "euros"],
  "£": ["pound", "pounds"],
};

// "1/2" is a half; any other slash is read as its numbers ("24/7", "50/50").
const FRACTIONS: Record<string, string[]> = {
  "1/2": ["one", "half"],
  "1/3": ["one", "third"],
  "2/3": ["two", "thirds"],
  "1/4": ["one", "quarter"],
  "3/4": ["three", "quarters"],
};

// A word after an amount that carries its unit: "$3.5 million" is said "three
// point five million dollars".
const MAGNITUDES = new Set(["hundred", "thousand", "million", "billion", "trillion", "k", "m"]);

// The languages with a reading here. Any other keeps the written word, and a
// word without letters is then placed by the sound (unspelled.ts).
const SPOKEN_LANGUAGES = new Set(["en"]);

function underThousand(value: number): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds > 0) words.push(ONES[hundreds]!, "hundred");
  if (rest >= 20) {
    words.push(TENS[Math.floor(rest / 10)]!);
    if (rest % 10 > 0) words.push(ONES[rest % 10]!);
  } else if (rest > 0) {
    words.push(ONES[rest]!);
  }
  return words;
}

function digitByDigit(digits: string): string[] {
  return [...digits].map((digit) => ONES[Number(digit)]!);
}

// A whole number as it is counted: "1250" is one thousand two hundred fifty.
// A leading zero or a number past the trillions is read digit by digit.
export function cardinal(digits: string): string[] {
  if (digits === "0") return ["zero"];
  if (digits.startsWith("0") || digits.length > MAX_CARDINAL_DIGITS) return digitByDigit(digits);
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3)
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  const words: string[] = [];
  groups.forEach((group, index) => {
    const value = Number(group);
    if (value === 0) return;
    words.push(...underThousand(value));
    const scale = SCALES[groups.length - 1 - index]!;
    if (scale) words.push(scale);
  });
  return words;
}

// Four bare digits from 1100 to 2099 are read as a year: "2027" twenty twenty
// seven, "1999" nineteen ninety nine, "1905" nineteen oh five, "1900" nineteen
// hundred, "2000" two thousand, "2005" two thousand five. Null otherwise.
function year(digits: string): string[] | null {
  if (!/^\d{4}$/.test(digits)) return null;
  const value = Number(digits);
  if (value < 1100 || value > 2099) return null;
  if (value >= 2000 && value <= 2009) return cardinal(digits);
  const head = underThousand(Math.floor(value / 100));
  const tail = value % 100;
  if (tail === 0) return [...head, "hundred"];
  if (tail < 10) return [...head, "oh", ONES[tail]!];
  return [...head, ...underThousand(tail)];
}

function ordinalOf(word: string): string {
  if (ORDINALS[word]) return ORDINALS[word];
  if (word.endsWith("y")) return `${word.slice(0, -1)}ieth`;
  return `${word}th`;
}

function pluralOf(word: string): string {
  if (word.endsWith("y")) return `${word.slice(0, -1)}ies`;
  if (word.endsWith("x")) return `${word}es`;
  return `${word}s`;
}

function lastChanged(words: string[], change: (word: string) => string): string[] {
  return words.map((word, index) => (index === words.length - 1 ? change(word) : word));
}

// The pieces of a written word, tried in this order at each position.
const TIME = /(\d{1,2}):(\d{2})(?!\d)/y;
const FRACTION = /(\d+)\/(\d+)(?![\d/])/y;
const ORDINAL_ENDING = /(?:st|nd|rd|th)(?!\p{L})/iuy;
const PLURAL = /(\d+)'?s(?!\p{L})/iuy;
const DIGITS = /\d+/y;
const THOUSANDS = /,\d{3}(?!\d)/y;
const DECIMALS = /\.(\d+)/y;
const LETTERS = /[\p{L}\p{M}']+/uy;

function match(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

// The whole number written at `at`, bare or with thousands separators
// ("1,250,000"), as its digits and where it ends. Null when no digit is there.
function wholeAt(text: string, at: number): { digits: string; end: number } | null {
  const first = match(DIGITS, text, at);
  if (!first) return null;
  let digits = first[0];
  let end = at + digits.length;
  if (digits.length > 3) return { digits, end };
  for (let group = match(THOUSANDS, text, end); group; group = match(THOUSANDS, text, end)) {
    digits += group[0].slice(1);
    end += group[0].length;
  }
  return { digits, end };
}

// What marks a word as more than letters: a digit, a symbol that is said, a
// currency sign.
const WRITTEN = /[\d%&+@=°×$€£]/;

interface Reading {
  parts: string[];
  // When a currency amount ends the word ("$3.5", before "million" perhaps):
  // where its unit stands in `parts`, and the unit for several.
  unit: { index: number; plural: string } | null;
}

// One written word as spoken parts (English).
function readWord(text: string): Reading {
  const parts: string[] = [];
  // The unit of a currency sign in front of the amount being read.
  let currency: [string, string] | null = null;
  let unit: Reading["unit"] = null;
  let at = 0;
  const digitBefore = () => at > 0 && /\d/.test(text[at - 1]!);
  const digitAfter = (index: number) => /\d/.test(text[index] ?? "");
  while (at < text.length) {
    const char = text[at]!;
    let found: RegExpExecArray | null;
    const whole = wholeAt(text, at);
    const ordinal = whole && match(ORDINAL_ENDING, text, whole.end);
    if (CURRENCIES[char] && digitAfter(at + 1)) {
      currency = CURRENCIES[char];
      at += 1;
    } else if (CURRENCIES[char]) {
      // "20€", or the sign alone.
      parts.push(CURRENCIES[char][parts.at(-1) === "one" && parts.length === 1 ? 0 : 1]);
      at += 1;
    } else if (!currency && (found = match(TIME, text, at))) {
      const [, hours, minutes] = found as unknown as [string, string, string];
      parts.push(...cardinal(String(Number(hours))));
      if (minutes !== "00") {
        parts.push(
          ...(minutes.startsWith("0") ? ["oh", ONES[Number(minutes)]!] : cardinal(minutes)),
        );
      }
      at += found[0].length;
    } else if (!currency && (found = match(FRACTION, text, at)) && FRACTIONS[found[0]]) {
      parts.push(...FRACTIONS[found[0]]!);
      at += found[0].length;
    } else if (!currency && whole && ordinal) {
      parts.push(...lastChanged(cardinal(whole.digits), ordinalOf));
      at = whole.end + ordinal[0].length;
    } else if (!currency && (found = match(PLURAL, text, at))) {
      // "1990s", "80s", "20's".
      parts.push(...lastChanged(year(found[1]!) ?? cardinal(found[1]!), pluralOf));
      at += found[0].length;
    } else if (whole) {
      const decimals = match(DECIMALS, text, whole.end)?.[1];
      const end = whole.end + (decimals ? decimals.length + 1 : 0);
      const digits = whole.digits;
      if (currency) {
        const cents = decimals?.length === 2;
        parts.push(...cardinal(digits));
        if (decimals && !cents) parts.push("point", ...digitByDigit(decimals));
        // A magnitude written on the amount ("$5k") comes before the unit.
        const suffix = match(LETTERS, text, end);
        if (suffix && MAGNITUDES.has(suffix[0].toLowerCase())) {
          parts.push(suffix[0], currency[1]);
          at = end + suffix[0].length;
        } else {
          at = end;
          if (at === text.length) unit = { index: parts.length, plural: currency[1] };
          parts.push(currency[digits === "1" && !decimals ? 0 : 1]);
          if (cents && decimals !== "00") parts.push(...cardinal(String(Number(decimals))));
        }
        currency = null;
        continue;
      }
      // A year is four bare digits: no separator, no decimals, no percent.
      const plain = whole.end - at === digits.length && !decimals && text[end] !== "%";
      parts.push(...((plain ? year(digits) : null) ?? cardinal(digits)));
      if (decimals) parts.push("point", ...digitByDigit(decimals));
      at = end;
    } else if ((found = match(LETTERS, text, at))) {
      parts.push(found[0]);
      at += found[0].length;
    } else if (SYMBOLS[char]) {
      parts.push(SYMBOLS[char]);
      at += 1;
    } else if (char === "#" && digitAfter(at + 1)) {
      parts.push("number");
      at += 1;
    } else if ((char === "-" || char === "−") && at === 0 && digitAfter(1)) {
      parts.push("minus");
      at += 1;
    } else if ((char === "-" || char === "–") && digitBefore() && digitAfter(at + 1)) {
      // A range: "10-15" is ten to fifteen.
      parts.push("to");
      at += 1;
    } else {
      // Punctuation, a slash or a colon between numbers: nothing is said.
      at += 1;
    }
  }
  return { parts, unit };
}

// Each written word as the parts the aligner spells, in order: a word of
// letters is itself, unchanged; a word with digits or symbols is read. A
// currency amount followed by a magnitude word gives its unit to that word.
// A language without a reading here keeps every word as written.
export function spokenParts(texts: readonly string[], language: string): string[][] {
  if (!SPOKEN_LANGUAGES.has(language)) return texts.map((text) => [text]);
  const out: string[][] = [];
  let unit: Reading["unit"] = null;
  for (const text of texts) {
    const before = unit;
    unit = null;
    if (WRITTEN.test(text)) {
      const reading = readWord(text);
      out.push(reading.parts);
      unit = reading.unit;
    } else if (before && MAGNITUDES.has(text.toLowerCase().replace(/[^\p{L}]/gu, ""))) {
      out.at(-1)!.splice(before.index, 1);
      out.push([text, before.plural]);
    } else {
      out.push([text]);
    }
  }
  return out;
}
