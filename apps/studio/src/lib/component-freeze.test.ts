import { readFileSync } from "node:fs";
import type { PlacedComponent } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import {
  canEditText,
  canRewrap,
  componentLabel,
  componentOption,
  scaledVisual,
} from "./owner-edit.ts";

// THE STUDIO FREEZE (app_docs/component-template.md, step 0): for each placed
// component of the every-component answer (packages/edit freezes it as
// `every-components.json`), what the Edit tool says about it: its label, its
// list line, whether its text can be edited, whether its lines can be set
// again. Step 4 moves these into the component classes and must not change
// them. Ids, words and boxes only; no prompt wording. If packages/edit's
// freeze changes, refresh this one too (`-u component-freeze`).
const url = new URL(
  "../../../../packages/edit/src/testdata/freeze/every-components.json",
  import.meta.url,
);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's own committed test data
const components = JSON.parse(readFileSync(url, "utf8")) as PlacedComponent[];

describe("studio component freeze", () => {
  it("says the same about every placed component", async () => {
    const said = components.map((component) => ({
      id: component.id,
      component: component.component,
      label: componentLabel(component.component),
      option: componentOption(component),
      canEditText: canEditText(component),
      canRewrap: canRewrap(component),
    }));
    // A turned and an upright card scaled by the same share.
    const visual = { x: 100, y: 200, width: 300, height: 400 };
    const scaled = [0, 30, 90].map((rotation) => ({
      rotation,
      box: scaledVisual({ ...visual, rotation }, 1.5),
    }));
    await expect(`${JSON.stringify({ said, scaled }, null, 2)}\n`).toMatchFileSnapshot(
      "./testdata/component-freeze.json",
    );
  });
});
