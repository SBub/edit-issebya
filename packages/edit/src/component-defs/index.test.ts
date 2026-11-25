import { describe, expect, it } from "vitest";
import { COMPONENTS } from "./index.ts";
import { COMPONENT_NAMES } from "./names.ts";

describe("COMPONENTS", () => {
  it.each(COMPONENT_NAMES)("%s names itself and its looks", (name) => {
    const component = COMPONENTS[name];
    expect(component.name).toBe(name);
    expect(component.defaultLook.component).toBe(name);
    for (const look of component.looks) expect(look.component).toBe(name);
  });
});
