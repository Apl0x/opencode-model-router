/**
 * A real-plugin harness for the Phase 3.1 e2e suite: the REAL plugin factory with the REAL
 * verification wiring (real runArgv/runShell, real slot, real reference worktrees). Nothing is
 * mocked; only the opencode host is faked (its client and the hook call shapes), modelled on
 * test/integration/router-verify-tool.test.ts `makePlugin()`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../../src/index";
import { invalidateConfigCache } from "../../../src/router/config";

interface ToolHooks {
  tool?: Record<string, { execute(args: unknown, ctx?: { sessionID?: string; abort?: AbortSignal }): Promise<string> } | undefined>;
  "tool.execute.before": (input: unknown, output: { args: Record<string, unknown> }) => Promise<void>;
  "tool.execute.after": (input: unknown, output: { output: string; metadata: unknown }) => Promise<void>;
  "experimental.chat.system.transform": (
    input: { sessionID?: string; model?: { providerID: string; modelID: string } },
    output: { system: string[] },
  ) => Promise<void>;
  dispose?: () => Promise<void>;
}

export interface E2ETaskParams {
  sessionID: string;
  callID: string;
  prompt: string;
  description?: string;
  subagentType?: string /* default "medium" */;
  produce?: () => Promise<void>;
  output?: string;
}

export interface E2ETaskResult {
  output: string;
  beforeMs: number;
  afterMs: number;
  produceStartedAt: number;
  returnedAt: number;
}

export interface E2ECalls {
  create: unknown[];
  prompt: unknown[];
  abort: unknown[];
  delete: unknown[];
}

export interface E2EPlugin {
  task(p: E2ETaskParams): Promise<E2ETaskResult>;
  routerVerify(args: { handles?: string[]; pending?: boolean }, ctx?: { sessionID?: string; abort?: AbortSignal }): Promise<string>;
  systemPrompt(sessionID: string): Promise<string[]>;
  logs: unknown[];
  calls: E2ECalls;
  dispose(): Promise<void>;
}

const ENV_KEYS = ["HOME", "USERPROFILE", "MODEL_ROUTER_ENFORCE", "MODEL_ROUTER_VERIFIED_DELEGATE"] as const;

/** Ids starting with `orch` are proven root orchestrators; every other id is a child of one. */
function sessionInfo(id: string): { id: string; parentID?: string } {
  return id.startsWith("orch") ? { id } : { id, parentID: "orch" };
}

export async function createE2EPlugin(opts: {
  directory: string;
  home: string;
  verify?: Record<string, unknown>;
  enforcement?: Record<string, unknown>;
}): Promise<E2EPlugin> {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map(k => [k, process.env[k]]));
  const restoreEnv = (): void => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    invalidateConfigCache();
  };

  const overrides = join(opts.home, ".config", "opencode", "opencode-model-router.overrides.jsonc");
  mkdirSync(dirname(overrides), { recursive: true });
  writeFileSync(overrides, JSON.stringify({ enforcement: { ...opts.enforcement, verify: opts.verify ?? {} } }), "utf-8");
  process.env.HOME = opts.home;
  process.env.USERPROFILE = opts.home;
  process.env.MODEL_ROUTER_ENFORCE = "1";
  process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  invalidateConfigCache();

  const logs: unknown[] = [];
  const calls: E2ECalls = { create: [], prompt: [], abort: [], delete: [] };
  let created = 0;
  const ctx = {
    directory: opts.directory,
    worktree: opts.directory,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      app: {
        log: async (req: unknown) => {
          logs.push(req);
          return { data: true };
        },
      },
      session: {
        get: async (req: { path: { id: string } }) => ({ data: sessionInfo(req.path.id) }),
        create: async (req: unknown) => {
          calls.create.push(req);
          created++;
          return { data: { id: `sess_${created}` } };
        },
        prompt: async (req: unknown) => {
          calls.prompt.push(req);
          return { data: { parts: [{ type: "text", text: "DONE" }] } };
        },
        abort: async (req: unknown) => {
          calls.abort.push(req);
          return { data: true };
        },
        delete: async (req: unknown) => {
          calls.delete.push(req);
          return { data: true };
        },
      },
    },
  };

  let hooks: ToolHooks;
  try {
    hooks = (await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0])) as unknown as ToolHooks;
  } catch (error) {
    restoreEnv();
    throw error;
  }

  let disposed = false;
  return {
    logs,
    calls,
    async task(p: E2ETaskParams): Promise<E2ETaskResult> {
      const input = {
        tool: "task",
        sessionID: p.sessionID,
        callID: p.callID,
        args: { subagent_type: p.subagentType ?? "medium", prompt: p.prompt, description: p.description ?? "the work" },
      };
      const before = { args: { ...input.args } as Record<string, unknown> };
      const t0 = performance.now();
      await hooks["tool.execute.before"](input, before);
      const beforeMs = performance.now() - t0;
      const produceStartedAt = Date.now();
      if (p.produce !== undefined) await p.produce();
      const output = { output: p.output ?? "<task_result>\nDONE\n</task_result>", metadata: { sessionId: `child-${p.callID}` } };
      const t1 = performance.now();
      await hooks["tool.execute.after"]({ ...input, args: before.args }, output);
      const afterMs = performance.now() - t1;
      return { output: output.output, beforeMs, afterMs, produceStartedAt, returnedAt: Date.now() };
    },
    async routerVerify(args, toolCtx): Promise<string> {
      const t = hooks.tool?.router_verify;
      if (t === undefined) throw new Error("router_verify is not registered");
      return t.execute(args, { sessionID: toolCtx?.sessionID ?? "orch", abort: toolCtx?.abort ?? new AbortController().signal });
    },
    async systemPrompt(sessionID: string): Promise<string[]> {
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID, model: { providerID: "p", modelID: "m" } }, output);
      return output.system;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await hooks.dispose?.();
      } finally {
        restoreEnv();
      }
    },
  };
}

/** A prompt fragment carrying a testsPass acceptance block the DoD parser accepts. */
export function acceptance(command = "npm test"): string {
  return [
    "[acceptance]",
    `check: testsPass command="${command}"`,
    "criteria: the tests pass",
    "[/acceptance]",
  ].join("\n");
}
