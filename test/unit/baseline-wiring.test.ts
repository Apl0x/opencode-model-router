import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
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
