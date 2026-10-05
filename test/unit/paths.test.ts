import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isWithinDir } from "../../src/verify/paths";

describe("isWithinDir", () => {
  const base = join(tmpdir(), "repo");
  it("contains descendants and itself after path resolution", () => {
    expect(isWithinDir(join(base, "sub", "file.ts"), base)).toBe(true);
    expect(isWithinDir(base, base)).toBe(true);
    expect(isWithinDir(join(base, "sub", "..", "file.ts"), base)).toBe(true);
  });
  it("keeps children whose names start with two dots inside", () => {
    expect(isWithinDir(join(base, "..cache", "file.ts"), base)).toBe(true);
    expect(isWithinDir(join(base, "...", "file.ts"), base)).toBe(true);
  });
  it("excludes parents and sibling-prefix directories", () => {
    expect(isWithinDir(resolve(base, ".."), base)).toBe(false);
    expect(isWithinDir(join(`${base}-v2`, "file.ts"), base)).toBe(false);
  });
  it.runIf(process.platform === "win32")("compares case-insensitively and excludes other drives", () => {
    expect(isWithinDir("D:\\GIT\\Repo\\file.ts", "d:\\git\\repo")).toBe(true);
    expect(isWithinDir("E:\\git\\repo\\file.ts", "D:\\git\\repo")).toBe(false);
  });
});
