// The committed goldens (written by `yarn workspace @edit-issebya/edit golden`
// from the Node build), as text, for both test projects.
import baselineHtml from "../testdata/golden/baseline-short-speech.html?raw";
import baselineWidths from "../testdata/golden/baseline-short-speech.widths.json?raw";
import baselineHookHtml from "../testdata/golden/baseline-short-speech-hook.html?raw";
import baselineHookWidths from "../testdata/golden/baseline-short-speech-hook.widths.json?raw";
import engineHtml from "../testdata/golden/rethink-work-engine.html?raw";
import engineWidths from "../testdata/golden/rethink-work-engine.widths.json?raw";
import requestHtml from "../testdata/golden/rethink-work-request.html?raw";
import requestWidths from "../testdata/golden/rethink-work-request.widths.json?raw";
import transitionsHtml from "../testdata/golden/rethink-work-transitions.html?raw";
import transitionsWidths from "../testdata/golden/rethink-work-transitions.widths.json?raw";
import hookHtml from "../testdata/golden/rethink-work-hook.html?raw";
import hookWidths from "../testdata/golden/rethink-work-hook.widths.json?raw";

export const GOLDENS: Record<string, { html: string; widths: string }> = {
  "baseline-short-speech": { html: baselineHtml, widths: baselineWidths },
  "baseline-short-speech-hook": { html: baselineHookHtml, widths: baselineHookWidths },
  "rethink-work-engine": { html: engineHtml, widths: engineWidths },
  "rethink-work-request": { html: requestHtml, widths: requestWidths },
  "rethink-work-transitions": { html: transitionsHtml, widths: transitionsWidths },
  "rethink-work-hook": { html: hookHtml, widths: hookWidths },
};
