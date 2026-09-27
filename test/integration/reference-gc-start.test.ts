/**
 * 2.1.5b: the REAL plugin factory sweeps stale reference dirs exactly once at start,
 * fire-and-forget, and a rejecting GC is logged rather than thrown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

const gc = vi.hoisted(() => ({ calls: [] as string[], rejects: false }));
vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: (root: string) => {
    gc.calls.push(root);
    return gc.rejects ? Promise.reject(new Error("gc exploded")) : Promise.resolve({ removed: [], kept: [], failed: [] });
  },
}));

describe("reference GC at plugin start", () => {
  let dir: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrgc-"));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    invalidateConfigCache();
    gc.calls = []; gc.rejects = false;
  });
  afterEach(() => {
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
    invalidateConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ctx = (logs: unknown[]) => ({
    directory: dir, worktree: dir, project: {}, serverUrl: new URL("http://localhost"), $: () => {},
    client: { app: { log: async (opts: unknown) => { logs.push(opts); return {}; } }, session: {} },
  });

  it("calls gcStaleReferences once with the plugin directory, and logs a rejection", async () => {
    gc.rejects = true;
    const logs: unknown[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(ModelRouterPlugin(ctx(logs) as unknown as Parameters<typeof ModelRouterPlugin>[0])).resolves.toBeDefined();
      await vi.waitFor(() => expect(JSON.stringify(logs) + warn.mock.calls.flat().join(" ")).toContain("reference GC failed"));
    } finally {
      warn.mockRestore();
    }
    expect(gc.calls).toEqual([dir]);
  });
});
