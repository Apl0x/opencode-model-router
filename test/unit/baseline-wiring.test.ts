import { beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createVerificationWiring } from "../../src/verify/wiring";
import { createChangedFileStore, type TreeSnapshot } from "../../src/verify/dispatch";
import { accept } from "../../src/verify/gate";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";

const state = vi.hoisted(() => ({
  snapshot: undefined as TreeSnapshot | undefined,
  code: 0, stdout: "", commands: [] as string[], budgets: [] as number[],
  held: false, finish: undefined as (() => void) | undefined,
}));
vi.mock("../../src/verify/tree", () => ({ snapshotTree: async () => state.snapshot }));
vi.mock("../../src/verify/exec", () => ({
  runShell: (command: string, opts: { timeoutMs: number }) => new Promise(resolve => {
    state.commands.push(command); state.budgets.push(opts.timeoutMs);
    const finish = () => resolve({ code: state.code, stdout: state.stdout, stderr: "", timedOut: false });
    if (state.held) state.finish = finish; else finish();
  }),
}));
const cwd = resolve("baseline-wiring-project");
const dod: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "pnpm test" }] };
beforeEach(() => Object.assign(state, { snapshot: { cwd, head: "HEAD", fingerprint: "before", dirty: true, files: [{ path: resolve(cwd, "old.ts"), status: " M" }] }, code: 0, stdout: "", commands: [], budgets: [], held: false, finish: undefined }));
function harness() {
  const cfg: RouterConfig = { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify: { baselineTimeoutMs: 1234 } } };
  const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => cfg });
  const store = createChangedFileStore();
  return { cfg, wiring, store };
}
describe("tree snapshot against a real git repository", () => {
  const withRepo = async (body: (repo: string) => Promise<void>) => {
    const repo = mkdtempSync(join(tmpdir(), "omr-tree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false");
      mkdirSync(join(repo, "sub"));
      writeFileSync(join(repo, "a.test.ts"), "export const a = 1;\n");
      writeFileSync(join(repo, "sub", "keep.ts"), "export {};\n");
      git("add", "-A"); git("commit", "-q", "-m", "init");
      git("mv", "a.test.ts", "b.test.ts");
      await body(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  };
  const real = () => vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");

  it("records the rename source as previousPath", async () => {
    const { snapshotTree } = await real();
    await withRepo(async repo => {
      const snapshot = await snapshotTree(repo, new AbortController().signal);
      const top = realpathSync.native(repo);
      const renamed = snapshot?.files.find(f => f.status.includes("R"));
      expect(renamed).toBeDefined();
      expect(realpathSync.native(renamed!.path)).toBe(join(top, "b.test.ts"));
      expect(renamed!.previousPath && resolve(renamed!.previousPath).toLowerCase())
        .toBe(resolve(snapshot!.root!, "a.test.ts").toLowerCase());
    });
  });

  it("records the real top-level path when captured from a subdirectory", async () => {
    const { snapshotTree } = await real();
    await withRepo(async repo => {
      const snapshot = await snapshotTree(join(repo, "sub"), new AbortController().signal);
      expect(snapshot?.root).toBe(realpathSync.native(repo));
      expect(snapshot?.cwd).toBe(realpathSync.native(join(repo, "sub")));
    });
  });
});

describe("baseline wiring", () => {
  it("does not await capture and consumes the original reference after the producer changes the tree", async () => {
    const { wiring, store } = harness(); state.held = true;
    expect(wiring.beginVerification(store, "dispatch", undefined, dod)).toBeUndefined();
    await vi.waitFor(() => expect(state.finish).toBeDefined());
    expect(state.commands).toEqual(["pnpm test"]);
    state.finish?.();
    expect(await store.baseline("dispatch", "pnpm test", "HEAD")).toBeDefined();
    state.held = false; state.code = 1; state.stdout = "FAILED new-test - assertion\n=== 1 failed ===";
    state.snapshot = { ...state.snapshot!, fingerprint: "after", files: [...state.snapshot!.files, { path: resolve(cwd, "new.ts"), status: "??" }] };
    const prepared = await wiring.prepareVerification(store, "dispatch", "child");
    expect(prepared.changedFiles.map(f => f.path)).toEqual([resolve(cwd, "new.ts")]);
    const deps = wiring.buildGateDeps(); deps.deterministic.testBaseline = prepared.testBaseline;
    const result = await accept({ dod }, { ...prepared, finalReturnText: "done", declaredOutputs: [], producerSessionID: "child", producerTier: "medium" }, deps);
    expect(result.accepted).toBe(false); expect(result.verdict.reasons[0]).toContain("new-test");
    expect(state.budgets[0]).toBe(1234);
  });
  it("disabled capture still snapshots changed files and disabled consumption ignores a cached baseline", async () => {
    const { cfg, wiring, store } = harness();
    wiring.beginVerification(store, "warm", undefined, dod);
    await store.baseline("warm", "pnpm test", "HEAD");
    cfg.enforcement!.verify!.testBaseline = false;
    wiring.beginVerification(store, "disabled", undefined, dod);
    await store.baseline("disabled", "pnpm test", "HEAD");
    expect(state.commands).toEqual(["pnpm test"]);
    expect((await wiring.prepareVerification(store, "disabled", "child")).changeBaseline).toBe("available");
    expect(await (await wiring.prepareVerification(store, "warm", "child")).testBaseline("pnpm test")).toBeUndefined();
  });
  it("read-only dispatches run no tests and forbidden commands never execute", async () => {
    const { wiring, store } = harness();
    wiring.beginVerification(store, "readonly", undefined, { ...dod, kind: "checker", checks: [], criteria: ["investigate"] });
    expect(await store.baseline("readonly", "npm test", "HEAD")).toBeUndefined();
    wiring.beginVerification(store, "blocked", undefined, { ...dod, checks: [{ kind: "testsPass", command: "npm test && evil" }] });
    expect(await store.baseline("blocked", "npm test && evil", "HEAD")).toBeUndefined();
    expect(state.commands).toEqual([]);
  });
});
