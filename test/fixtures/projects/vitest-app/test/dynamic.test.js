import { describe, expect, it } from "vitest";

// Known blind spot (plan §5): the specifier is computed at run time, so no static import
// graph (vitest related, jest --findRelatedTests) links this file to src/m07.js.
const which = ["m", String(7).padStart(2, "0")].join("");

describe("dynamic import", () => {
  it("loads a module through a computed specifier", async () => {
    const mod = await import(`../src/${which}.js`);
    expect(mod.value07(1)).toBe(8);
  });

  it("reads the module name", async () => {
    const mod = await import(`../src/${which}.js`);
    expect(mod.name07).toBe("m07");
  });
});
