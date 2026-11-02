// The committed goldens (written by `yarn workspace @edit-issebya/edit golden`
// from the Node build), as text, for both test projects.
import baselineHtml from "../testdata/golden/baseline-short-speech.html?raw";
import baselineWidths from "../testdata/golden/baseline-short-speech.widths.json?raw";
import rethinkHtml from "../testdata/golden/rethink-work-hand.html?raw";
import rethinkWidths from "../testdata/golden/rethink-work-hand.widths.json?raw";

export const GOLDENS: Record<string, { html: string; widths: string }> = {
  "baseline-short-speech": { html: baselineHtml, widths: baselineWidths },
  "rethink-work-hand": { html: rethinkHtml, widths: rethinkWidths },
};
