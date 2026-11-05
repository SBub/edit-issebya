// The committed goldens (written by `yarn workspace @edit-issebya/edit golden`
// from the Node build), as text, for both test projects.
import baselineHtml from "../testdata/golden/baseline-short-speech.html?raw";
import baselineWidths from "../testdata/golden/baseline-short-speech.widths.json?raw";
import behindHtml from "../testdata/golden/rethink-work-behind.html?raw";
import behindWidths from "../testdata/golden/rethink-work-behind.widths.json?raw";
import engineHtml from "../testdata/golden/rethink-work-engine.html?raw";
import engineWidths from "../testdata/golden/rethink-work-engine.widths.json?raw";
import readableHtml from "../testdata/golden/rethink-work-readable.html?raw";
import readableWidths from "../testdata/golden/rethink-work-readable.widths.json?raw";
import requestHtml from "../testdata/golden/rethink-work-request.html?raw";
import requestWidths from "../testdata/golden/rethink-work-request.widths.json?raw";
import rethinkHtml from "../testdata/golden/rethink-work-hand.html?raw";
import rethinkWidths from "../testdata/golden/rethink-work-hand.widths.json?raw";
import transitionsHtml from "../testdata/golden/rethink-work-transitions.html?raw";
import transitionsWidths from "../testdata/golden/rethink-work-transitions.widths.json?raw";
import frontHtml from "../testdata/golden/rethink-work-front.html?raw";
import frontWidths from "../testdata/golden/rethink-work-front.widths.json?raw";
import hookHtml from "../testdata/golden/rethink-work-hook.html?raw";
import hookWidths from "../testdata/golden/rethink-work-hook.widths.json?raw";

export const GOLDENS: Record<string, { html: string; widths: string }> = {
  "baseline-short-speech": { html: baselineHtml, widths: baselineWidths },
  "rethink-work-hand": { html: rethinkHtml, widths: rethinkWidths },
  "rethink-work-behind": { html: behindHtml, widths: behindWidths },
  "rethink-work-engine": { html: engineHtml, widths: engineWidths },
  "rethink-work-readable": { html: readableHtml, widths: readableWidths },
  "rethink-work-request": { html: requestHtml, widths: requestWidths },
  "rethink-work-transitions": { html: transitionsHtml, widths: transitionsWidths },
  "rethink-work-hook": { html: hookHtml, widths: hookWidths },
  "rethink-work-front": { html: frontHtml, widths: frontWidths },
};
