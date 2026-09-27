import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  detectRunner,
  effectiveWorkers,
  isNoAffected,
  isScopedSpec,
  isUnverifiable,
  planScopedRun,
  planStaticScoping,
  resolveEntry,
  REPORT_NAME_RE,
  STEM_MATCH_LIMIT,
  JS_TEST_GLOBS,
  PY_TEST_GLOBS,
  type ChangedPath,
  type DetectedRunner,
  type PlanScopedRunInput,
  type RunnerHost,
  type ScopedSpec,
  type TestSearchSeam,
  type Unverifiable,
} from "../../src/verify/runner";
import {
  isUnscoped,
  planRerun,
  planScopedLint,
  readResult,
  type LintSpec,
  type RunnerFs,
  type RunResult,
} from "../../src/verify/runner";
import type { FsSeam } from "../../src/verify/types";

// ---------------------------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------------------------

const UUID = "0123abcd-0000-4000-8000-00000000abcd";
const FIX = path.resolve(__dirname, "../fixtures/runner");

const POSIX_HOST: Partial<RunnerHost> = {
  platform: "linux",
  execPath: "/usr/bin/node",
  tmpdir: "/tmp",
  cores: 8,
  pathEnv: "",
  pytestAddopts: "",
  randomId: () => UUID,
};

const WIN_HOST: Partial<RunnerHost> = {
  ...POSIX_HOST,
  platform: "win32",
  execPath: "C:\\node\\node.exe",
  tmpdir: "C:\\Temp",
};

/** In-memory fs. `links` maps a directory prefix to its target, like a pnpm symlink. */
function memFs(files: Record<string, string>, win = false, links: Record<string, string> = {}, throwOn: string[] = []): FsSeam {
  const P = win ? path.win32 : path.posix;
  const k = (p: string) => (win ? p.toLowerCase() : p);
  const map = new Map(Object.entries(files).map(([p, c]) => [k(P.normalize(p)), c]));
  const follow = (p: string) => {
    let q = P.normalize(p);
    for (const [from, to] of Object.entries(links)) {
      if (k(q).startsWith(k(from) + P.sep)) q = to + q.slice(from.length);
    }
    return k(q);
  };
  return {
    fileExists: async (p) => map.has(follow(p)),
    readFile: async (p) => {
      const v = map.get(follow(p));
      if (v === undefined || throwOn.includes(p)) throw new Error(`ENOENT ${p}`);
      return v;
    },
  };
}

/** Real fs over the static fixtures, with a virtual `.git` at each given root (git cannot commit one). */
function fixtureFs(...roots: string[]): FsSeam {
  return {
    fileExists: async (p) => {
      if (path.basename(p) === ".git") return roots.some((r) => path.join(r, ".git") === p);
      return existsSync(p);
    },
    readFile: async (p) => readFileSync(p, "utf8"),
  };
}

const VITEST_PKG = JSON.stringify({ name: "vitest", version: "4.1.11", bin: { vitest: "./vitest.mjs" } });
const JEST_PKG = JSON.stringify({ name: "jest", version: "30.5.2", bin: "./bin/jest.js" });

function jsRepo(scripts: Record<string, string> = {}, extra: Record<string, string> = {}, root = "/r"): Record<string, string> {
  return {
    [`${root}/.git`]: "",
    [`${root}/package.json`]: JSON.stringify({ name: "app", scripts }),
    [`${root}/node_modules/vitest/package.json`]: VITEST_PKG,
    [`${root}/node_modules/vitest/vitest.mjs`]: "",
    [`${root}/node_modules/jest/package.json`]: JEST_PKG,
    [`${root}/node_modules/jest/bin/jest.js`]: "",
    ...extra,
  };
}

function pyRepo(extra: Record<string, string> = {}): Record<string, string> {
  return { "/r/.git": "", "/usr/bin/pytest": "", "/usr/bin/uv": "", ...extra };
}

function stubSearch(content: Record<string, readonly string[] | undefined> = {}, names: Record<string, readonly string[] | undefined> = {}): TestSearchSeam {
  return {
    findByContent: vi.fn(async (_root: string, needle: string) => (needle in content ? content[needle] : [])),
    findByName: vi.fn(async (_root: string, n: readonly string[]) => (n[0] in names ? names[n[0]] : [])),
  };
}

function input(over: Partial<PlanScopedRunInput> & { files?: Record<string, string>; win?: boolean }): PlanScopedRunInput {
  const { files, win, ...rest } = over;
  return {
    command: "vitest",
    cwd: "/r",
    changedFiles: [],
    budget: { maxWorkers: 2 },
    fs: memFs(files ?? jsRepo(), win),
    search: stubSearch(),
    host: win ? WIN_HOST : { ...POSIX_HOST, pathEnv: "/usr/bin" },
    ...rest,
  };
}

const changed = (...paths: string[]): ChangedPath[] => paths.map((p) => ({ path: p }));

function expectS6(x: object, code: string, reason?: string): void {
  expect(isUnverifiable(x)).toBe(true);
  const u = x as Unverifiable;
  expect(u.code).toBe(code);
  if (reason !== undefined) expect(u.reason).toBe(reason);
}

function spec(x: object): ScopedSpec {
  expect(isScopedSpec(x), JSON.stringify(x)).toBe(true);
  return x as ScopedSpec;
}

async function detect(command: string, files = jsRepo(), host = POSIX_HOST, cwd = "/r"): Promise<DetectedRunner> {
  const r = await detectRunner(command, cwd, memFs(files, host.platform === "win32"), host);
  expect(isUnverifiable(r), JSON.stringify(r)).toBe(false);
  return r as DetectedRunner;
}

async function detectS6(command: string, code: string, reason?: string, files = jsRepo()): Promise<void> {
  expectS6(await detectRunner(command, "/r", memFs(files), POSIX_HOST), code, reason);
}

// ---------------------------------------------------------------------------------------------
// B. Detection
// ---------------------------------------------------------------------------------------------

describe("detectRunner: direct forms", () => {
  it.each([
    ["vitest", "vitest", "direct"],
    ["npx vitest run", "vitest", "npx"],
    ["pnpm exec vitest", "vitest", "pnpm-exec"],
    ["jest", "jest", "direct"],
    ["npx jest", "jest", "npx"],
    ["pnpm exec jest --ci", "jest", "pnpm-exec"],
    ["pytest", "pytest", "direct"],
    ["uv run pytest -x", "pytest", "uv-run"],
  ])("%s", async (cmd, kind, launcher) => {
    const d = await detect(cmd);
    expect(d.kind).toBe(kind);
    expect(d.launcher).toBe(launcher);
    expect(d.source).toEqual({ type: "command" });
    expect(d.runnerCwd).toBe("/r");
    expect(d.gitRoot).toBe("/r");
  });

  it("uses the process defaults when no host is given", async () => {
    const root = path.join(FIX, "single");
    const d = await detectRunner("vitest", root, fixtureFs(root));
    expect(isUnverifiable(d)).toBe(false);
    expect((d as DetectedRunner).gitRoot).toBe(root);
  });

  it("no git root -> S6", async () => {
    expectS6(await detectRunner("vitest", "/r/a", memFs({}), POSIX_HOST), "no-git-root", "no git repository at or above /r/a");
  });
});

describe("detectRunner: package scripts", () => {
  const scripts = { test: "vitest run", lint: "jest" };
  it.each([
    ["npm test", "npm", "test"],
    ["npm t", "npm", "test"],
    ["npm run lint", "npm", "lint"],
    ["npm run-script lint", "npm", "lint"],
    ["pnpm test", "pnpm", "test"],
    ["pnpm t", "pnpm", "test"],
    ["pnpm run lint", "pnpm", "lint"],
    ["yarn test", "yarn", "test"],
    ["yarn run lint", "yarn", "lint"],
    ["bun run test", "bun", "test"],
  ])("%s -> scripts.%s", async (cmd, manager, name) => {
    const d = await detect(cmd, jsRepo(scripts));
    expect(d.source).toEqual({ type: "script", manager, name: name === "lint" ? "lint" : "test", packageJson: "/r/package.json" });
    expect(d.kind).toBe(name === "lint" ? "jest" : "vitest");
  });

  it("bun test is Bun's own runner -> S6 (O.1)", async () => {
    await detectS6("bun test", "bun-test", `"bun test" runs Bun's built-in test runner, not scripts.test (use "bun run test")`, jsRepo(scripts));
  });

  it("vitest run --coverage: coverage dropped with a note, and the pre hook noted", async () => {
    const root = path.join(FIX, "single");
    const d = (await detectRunner("npm test", root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform })) as DetectedRunner;
    expect(d.keptArgs).toEqual([]);
    expect(d.notes).toContain("coverage disabled for the scoped run");
    expect(d.notes).toContain("scripts.pretest is not run by the scoped command");
    expect(d.runnerCwd).toBe(root);
  });

  it("jest script with extra flags keeps them and records the cap", async () => {
    const root = path.join(FIX, "single");
    const d = (await detectRunner("npm run unit", root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform })) as DetectedRunner;
    expect(d.kind).toBe("jest");
    expect(d.keptArgs).toEqual(["--ci"]);
    expect(d.userWorkers).toEqual({ count: 4 });
  });

  it.each([
    ["npm run bad", "composite", 'composite scripts.bad: "&&"'],
    ["npm run seq", "composite", 'composite scripts.seq: ";"'],
    ["npm run dot", "unsupported-command", 'unsupported command "dotenv" in scripts.dot'],
    ["npm run xenvc", "composite", 'composite scripts.xenvc: "&&"'],
    ["npm run nested", "unsupported-command", 'unsupported command "npm" in scripts.nested'],
    ["npm run quote", "unterminated-quote", "unterminated quote in scripts.quote"],
  ])("fixture %s -> S6 naming the construct", async (cmd, code, reason) => {
    const root = path.join(FIX, "single");
    expectS6(await detectRunner(cmd, root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform }), code, reason);
  });

  it("cross-env X=1 Y=\"a b\" vitest run -> env", async () => {
    const root = path.join(FIX, "single");
    const d = (await detectRunner("npm run xenv", root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform })) as DetectedRunner;
    expect(d.env).toEqual({ X: "1", Y: "a b" });
    expect(d.kind).toBe("vitest");
  });

  it("missing, non-string, unparseable and absent package.json", async () => {
    const root = path.join(FIX, "single");
    const h = { ...POSIX_HOST, platform: process.platform };
    expectS6(await detectRunner("npm run num", root, fixtureFs(root), h), "no-script", `package.json has no string scripts.num: ${path.join(root, "package.json")}`);
    expectS6(await detectRunner("npm run nope", root, fixtureFs(root), h), "no-script");
    const broken = path.join(FIX, "broken-json");
    expectS6(await detectRunner("npm test", broken, fixtureFs(broken), h), "bad-package-json", `unreadable package.json: ${path.join(broken, "package.json")}`);
    await detectS6("npm test", "bad-package-json", undefined, { "/r/.git": "", "/r/package.json": "[]" });
    await detectS6("npm test", "no-script", undefined, { "/r/.git": "", "/r/package.json": "{}" });
    await detectS6("npm test", "no-package-json", "no package.json between /r and the git root", { "/r/.git": "" });
  });

  it("nearest package.json wins, walking up to the git root", async () => {
    const files = jsRepo({ test: "jest" }, { "/r/pkg/package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const d = await detect("npm test", files, POSIX_HOST, "/r/pkg/src");
    expect(d.kind).toBe("vitest");
    expect(d.runnerCwd).toBe("/r/pkg");
  });

  it("npm: flags before -- are ignored with a note, args after -- are appended", async () => {
    const d = await detect("npm test --silent -- --bail 1 -t x", jsRepo({ test: "vitest" }));
    expect(d.keptArgs).toEqual(["--bail", "1", "-t", "x"]);
    expect(d.notes).toContain("npm options ignored: --silent");
    const d2 = await detect("npm test --silent", jsRepo({ test: "vitest" }));
    expect(d2.keptArgs).toEqual([]);
  });

  it("pnpm/yarn/bun: tokens after the script name are appended minus a leading --", async () => {
    expect((await detect("pnpm test -- -t x", jsRepo({ test: "vitest" }))).keptArgs).toEqual(["-t", "x"]);
    expect((await detect("yarn test -t x", jsRepo({ test: "vitest" }))).keptArgs).toEqual(["-t", "x"]);
  });

  it("script env merges over command-level cross-env, and pnpm exec is allowed inside a script", async () => {
    const d = await detect("cross-env A=1 B=2 npm test", jsRepo({ test: "cross-env B=3 pnpm exec jest" }));
    expect(d.env).toEqual({ A: "1", B: "3" });
    expect(d.launcher).toBe("pnpm-exec");
  });

  it("package-manager heads other than exec inside a script -> unsupported", async () => {
    await detectS6("npm test", "unsupported-command", 'unsupported command "bun" in scripts.test', jsRepo({ test: "bun test" }));
    await detectS6("npm test", "unsupported-command", 'unsupported command "pnpm" in scripts.test', jsRepo({ test: "pnpm build" }));
  });
});

describe("detectRunner: C parsing", () => {
  it.each([
    ["vitest run && eslint .", "&&"],
    ["vitest || x", "||"],
    ["vitest | x", "|"],
    ["vitest & x", "&"],
    ["vitest > out", ">"],
    ["vitest < in", "<"],
    ["vitest `x`", "`"],
    ["vitest $(x)", "$("],
    ["vitest $HOME", "$"],
    ["vitest %FOO%", "%FOO%"],
    ["vitest\nx", "newline"],
    ["vitest\rx", "newline"],
    ["cross-env X=1 vitest run && eslint .", "&&"],
  ])("composite %j -> %s", async (cmd, construct) => {
    await detectS6(cmd, "composite", `composite command: "${construct}"`);
  });

  it("a bare 50% is not a composite construct", async () => {
    expect((await detect("vitest --maxWorkers=50%")).userWorkers).toEqual({ percent: 50 });
  });

  it("tokenizer: quotes, escapes, joins and literal backslashes", async () => {
    const d = await detect(`vitest -t "a \\"b\\" c" -t 'x y' a"b c"d --root C:\\x ""`);
    expect(d.keptArgs).toEqual(["-t", 'a "b" c', "-t", "x y", "--root", "C:\\x"]);
    expect(d.notes).toContain("vitest filters dropped: ab cd, ");
  });

  it.each([`vitest "run`, `vitest 'run`])("unterminated %s", async (cmd) => {
    await detectS6(cmd, "unterminated-quote", "unterminated quote in command");
  });

  it.each([
    ["dotenv -- vitest run", "dotenv"],
    ["npx -y vitest", "npx -y"],
    ["npx", "npx"],
    ["pnpm dlx vitest", "pnpm dlx"],
    ["pnpm exec mocha", "pnpm exec mocha"],
    ["pnpm exec", "pnpm exec"],
    ["uv run python -c x", "uv run python"],
    ["uv run", "uv run"],
    ["uv pip install", "uv pip"],
    ["uv", "uv"],
    ["uvx pytest", "uvx"],
    ["node --test", "node"],
    ["mocha", "mocha"],
    ["cross-env-shell vitest", "cross-env-shell"],
    ["cross-env X=1", "cross-env"],
    ["npm install", "npm install"],
    ["npm run", "npm run"],
    ["pnpm install", "pnpm install"],
    ["yarn", "yarn"],
    ["bun x", "bun x"],
    ["", ""],
  ])("unsupported %j -> %j", async (cmd, prefix) => {
    await detectS6(cmd, "unsupported-command", `unsupported command "${prefix}" in command`);
  });

  it("inline env without cross-env -> S6", async () => {
    await detectS6("CI=1 vitest", "inline-env", 'inline environment assignment "CI=" in command (only cross-env is supported)');
  });

  it("cross-env later assignment of the same name wins", async () => {
    expect((await detect("cross-env X=1 X=2 vitest")).env).toEqual({ X: "2" });
  });
});

// ---------------------------------------------------------------------------------------------
// D. User arguments
// ---------------------------------------------------------------------------------------------

describe("detectRunner: vitest arguments", () => {
  it("drops adapter-owned flags and keeps the rest in order", async () => {
    const d = await detect(
      "vitest run --reporter json --outputFile=x --coverage.reporter=text --coverage.all --changed HEAD --watch --config v.ts --browser --sequence.shuffle --globals --typecheck.enabled=true x",
    );
    expect(d.keptArgs).toEqual(["--config", "v.ts", "--browser", "--sequence.shuffle", "--globals", "--typecheck.enabled=true"]);
    expect(d.notes).toEqual(["coverage disabled for the scoped run", "vitest filters dropped: x"]);
  });

  it.each([
    ["vitest", undefined],
    ["vitest --maxWorkers 4", { count: 4 }],
    ["vitest --maxWorkers=1 --max-workers=8", { count: 8 }],
    ["vitest --maxWorkers=50%", { percent: 50 }],
    ["vitest --no-file-parallelism", { count: 1 }],
    ["vitest --fileParallelism=false", { count: 1 }],
  ])("%s -> cap %j", async (cmd, cap) => {
    expect((await detect(cmd)).userWorkers).toEqual(cap);
  });

  it("no-file-parallelism is kept; cap tokens are removed", async () => {
    expect((await detect("vitest --no-file-parallelism --maxWorkers=3")).keptArgs).toEqual(["--no-file-parallelism"]);
  });

  it.each(["abc", "0", "1.5", "-1", "0%", "150%", "99999999999999999999"])("invalid cap %s is ignored with a note", async (v) => {
    const d = await detect(`vitest --maxWorkers=${v}`);
    expect(d.userWorkers).toBeUndefined();
    expect(d.notes).toContain(`invalid worker cap "${v}" ignored`);
  });

  it("a cap with no value is invalid", async () => {
    expect((await detect("vitest --maxWorkers")).notes).toContain('invalid worker cap "" ignored');
  });

  it("-- is unsupported", async () => {
    await detectS6("vitest run -- a", "unsupported-argument", 'unsupported vitest argument "--" in command');
  });

  it.each(["bench", "list", "init", "typecheck"])("subcommand %s -> S6", async (sub) => {
    await detectS6(`vitest ${sub}`, "unsupported-subcommand", `unsupported vitest subcommand "${sub}" in command`);
  });

  it("only the first positional is a subcommand", async () => {
    expect((await detect("vitest run related")).notes).toContain("vitest filters dropped: related");
  });

  it("unknown options: = form and flags kept, value-looking next token ambiguous", async () => {
    expect((await detect("vitest --foo=1 --bar --baz")).keptArgs).toEqual(["--foo=1", "--bar", "--baz"]);
    await detectS6("vitest --foo bar", "ambiguous-option", 'ambiguous vitest option "--foo" in command: cannot tell whether "bar" is its value');
  });
});

describe("detectRunner: jest arguments", () => {
  it("drops, caps and keeps per D.3", async () => {
    const d = await detect("jest --json --reporters default summary --ci --outputFile o.json --bail --testPathPatterns a b -e --coverage x");
    expect(d.keptArgs).toEqual(["--ci", "--bail", "--testPathPatterns", "a", "b", "-e"]);
    expect(d.notes).toEqual(["coverage disabled for the scoped run", "jest filters dropped: x"]);
  });

  it.each([
    ["jest -w4", { count: 4 }],
    ["jest -w 3", { count: 3 }],
    ["jest --maxWorkers=25%", { percent: 25 }],
    ["jest -i", { count: 1 }],
    ["jest --runInBand", { count: 1 }],
  ])("%s -> cap %j", async (cmd, cap) => {
    const d = await detect(cmd);
    expect(d.userWorkers).toEqual(cap);
    expect(d.keptArgs).toEqual([]);
  });

  it("--showConfig -> S6", async () => {
    await detectS6("jest --showConfig", "unsupported-argument", 'unsupported jest argument "--showConfig" in command');
  });

  it("-c attached value is kept", async () => {
    expect((await detect("jest -cjest.config.js")).keptArgs).toEqual(["-cjest.config.js"]);
  });
});

describe("detectRunner: pytest arguments and xdist evidence", () => {
  it("drops the adapter's own flags, keeps the rest", async () => {
    const d = await detect("pytest -q -p no:cacheprovider -pno:cacheprovider -p myplugin -rA --cov src --junitxml=j.xml -x -k slow", pyRepo());
    expect(d.keptArgs).toEqual(["-p", "myplugin", "-rA", "-x", "-k", "slow"]);
    expect(d.xdist).toBe(false);
    expect(d.covInConfig).toBe(false);
  });

  it("-p with no value is kept as a flag", async () => {
    expect((await detect("pytest -p", pyRepo())).keptArgs).toEqual(["-p"]);
  });

  it.each([
    ["pytest -n4", { count: 4 }, true],
    ["pytest -n auto", { auto: true }, true],
    ["pytest --numprocesses=logical", { auto: true }, true],
    ["pytest -n 0", { count: 0 }, true],
    ["pytest --dist loadfile", undefined, true],
    ["pytest -n 2 -p no:xdist", { count: 2 }, false],
    ["pytest -pno:xdist -n 2", { count: 2 }, false],
  ])("%s -> cap %j, xdist %s", async (cmd, cap, xdist) => {
    const d = await detect(cmd, pyRepo());
    expect(d.userWorkers).toEqual(cap);
    expect(d.xdist).toBe(xdist);
  });

  it("a percent cap is invalid for pytest", async () => {
    expect((await detect("pytest -n 50%", pyRepo())).notes).toContain('invalid worker cap "50%" ignored');
  });

  it("positionals become absolute path scopes", async () => {
    expect((await detect("pytest tests/unit", pyRepo())).pathScopes).toEqual(["/r/tests/unit"]);
  });

  it.each(["tests/x.py::test_a", "tests/*.py", "../out"])("path scope %s -> S6", async (p) => {
    await detectS6(`pytest ${p}`, "unsupported-argument", `unsupported pytest argument "${p}" in command`, pyRepo());
  });

  it.each(["--co", "--collect-only", "--version", "-h"])("%s -> S6", async (f) => {
    await detectS6(`pytest ${f}`, "unsupported-argument", undefined, pyRepo());
  });

  it("config addopts supply xdist, cov and the cap from the nearest config dir", async () => {
    const files = pyRepo({
      "/r/pyproject.toml": '[tool.pytest.ini_options]\naddopts = ["-n", "auto", "--cov=pkg"]\n',
      "/r/sub/pytest.ini": "[pytest]\naddopts = -n 1\n",
    });
    const root = await detect("pytest", files);
    expect(root).toMatchObject({ xdist: true, covInConfig: true, userWorkers: { auto: true } });
    const sub = await detect("pytest", files, POSIX_HOST, "/r/sub");
    expect(sub).toMatchObject({ xdist: true, covInConfig: false, userWorkers: { count: 1 } });
  });

  it("a command cap wins over the config value", async () => {
    const d = await detect("pytest -n 3", pyRepo({ "/r/setup.cfg": "[tool:pytest]\naddopts = -n 1" }));
    expect(d.userWorkers).toEqual({ count: 3 });
  });

  it("PYTEST_ADDOPTS is evidence too", async () => {
    const d = await detect("pytest", pyRepo(), { ...POSIX_HOST, pytestAddopts: "-n 6 --cov" });
    expect(d).toMatchObject({ xdist: true, covInConfig: true, userWorkers: { count: 6 } });
  });

  it("an unreadable config file is noted, not fatal", async () => {
    const files = pyRepo({ "/r/tox.ini": "x" });
    const r = (await detectRunner("pytest", "/r", memFs(files, false, {}, ["/r/tox.ini"]), POSIX_HOST)) as DetectedRunner;
    expect(r.notes).toContain("unreadable pytest config ignored: /r/tox.ini");
    expect(r.xdist).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// E. Worker cap
// ---------------------------------------------------------------------------------------------

describe("effectiveWorkers (section 1.5-11)", () => {
  const B = { maxWorkers: 2 };
  it("follows the section E table", () => {
    expect(effectiveWorkers(undefined, B, 8)).toBe(2);
    expect(effectiveWorkers({ count: 1 }, B, 8)).toBe(1);
    expect(effectiveWorkers({ count: 8 }, B, 8)).toBe(2);
    expect(effectiveWorkers({ count: 0 }, B, 8)).toBe(0);
    expect(effectiveWorkers({ percent: 50 }, B, 16)).toBe(2);
    expect(effectiveWorkers({ percent: 50 }, B, 1)).toBe(1);
    expect(effectiveWorkers({ percent: 1 }, { maxWorkers: 8 }, 16)).toBe(1);
    expect(effectiveWorkers({ auto: true }, B, 1)).toBe(1);
    expect(effectiveWorkers({ auto: true }, B, 16)).toBe(2);
  });

  it("invalid budget, cores and caps fall back safely", () => {
    expect(effectiveWorkers(undefined, { maxWorkers: 0 }, 8)).toBe(1);
    expect(effectiveWorkers(undefined, { maxWorkers: 1.5 }, 8)).toBe(1);
    expect(effectiveWorkers({ auto: true }, { maxWorkers: 4 }, Number.NaN)).toBe(1);
    expect(effectiveWorkers({ count: -1 }, B, 8)).toBe(2);
    expect(effectiveWorkers({ percent: 150 }, B, 8)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// F. Entry resolution
// ---------------------------------------------------------------------------------------------

describe("resolveEntry", () => {
  const req = (kind: "vitest" | "jest" | "pytest" | "eslint", launcher: "direct" | "uv-run" = "direct", gitRoot = "/r") => ({ kind, launcher, gitRoot });

  it("vitest object bin and jest string bin from static fixtures", async () => {
    const root = path.join(FIX, "single");
    const h = { ...POSIX_HOST, platform: process.platform };
    expect(await resolveEntry({ kind: "vitest", launcher: "npx", gitRoot: root }, root, fixtureFs(root), h)).toEqual({
      file: "/usr/bin/node",
      prefix: [path.join(root, "node_modules", "vitest", "vitest.mjs")],
      entry: path.join(root, "node_modules", "vitest", "vitest.mjs"),
      version: "4.1.11",
    });
    const j = await resolveEntry({ kind: "jest", launcher: "direct", gitRoot: root }, root, fixtureFs(root), h);
    expect(j).toMatchObject({ entry: path.join(root, "node_modules", "jest", "bin", "jest.js"), version: "30.5.2" });
  });

  it("monorepo: hoisted runner found at the root from a package cwd", async () => {
    const root = path.join(FIX, "monorepo");
    const app = path.join(root, "packages", "app");
    const e = await resolveEntry({ kind: "vitest", launcher: "direct", gitRoot: root }, app, fixtureFs(root), { ...POSIX_HOST, platform: process.platform });
    expect(e).toMatchObject({ entry: path.join(root, "node_modules", "vitest", "vitest.mjs") });
  });

  it("pnpm .pnpm store layout: the lexical symlink path goes into argv", async () => {
    const store = "/r/node_modules/.pnpm/vitest@4.1.11/node_modules/vitest";
    const fs = memFs({ "/r/.git": "", [`${store}/package.json`]: VITEST_PKG, [`${store}/vitest.mjs`]: "" }, false, { "/r/node_modules/vitest": store });
    expect(await resolveEntry(req("vitest"), "/r", fs, POSIX_HOST)).toMatchObject({ entry: "/r/node_modules/vitest/vitest.mjs" });
  });

  it("runner missing -> runner not installed; yarn pnp named", async () => {
    const root = path.join(FIX, "no-runner");
    expectS6(
      await resolveEntry({ kind: "jest", launcher: "direct", gitRoot: root }, root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform }),
      "runner-not-installed",
      "runner not installed: jest",
    );
    expectS6(await resolveEntry(req("eslint"), "/r", memFs({ "/r/.pnp.cjs": "" }), POSIX_HOST), "yarn-pnp", "yarn Plug'n'Play has no node_modules to resolve eslint from");
    expectS6(await resolveEntry(req("vitest"), "/elsewhere", memFs({ "/elsewhere/node_modules/vitest/package.json": VITEST_PKG }), POSIX_HOST), "runner-not-installed");
  });

  it.each([
    ["{", "unreadable package.json /r/node_modules/vitest/package.json"],
    [JSON.stringify({ name: "evil", bin: "./v.js" }), 'package name is not "vitest"'],
    [JSON.stringify({ name: "vitest" }), "no bin entry"],
    [JSON.stringify({ name: "vitest", bin: { other: "./v.js" } }), "no bin entry"],
    [JSON.stringify({ name: "vitest", bin: "../../evil.js" }), "bin escapes the package directory"],
    [JSON.stringify({ name: "vitest", bin: "." }), "bin escapes the package directory"],
    [JSON.stringify({ name: "vitest", bin: "./v.sh" }), "bin is not a .js, .mjs or .cjs file"],
    [JSON.stringify({ name: "vitest", bin: "./missing.cjs" }), "bin entry missing: /r/node_modules/vitest/missing.cjs"],
  ])("bad bin %s", async (pj, detail) => {
    const fs = memFs({ "/r/node_modules/vitest/package.json": pj });
    expectS6(await resolveEntry(req("vitest"), "/r", fs, POSIX_HOST), "bad-bin", `invalid bin for vitest: ${detail}`);
  });

  it("no version field is fine", async () => {
    const fs = memFs({ "/r/node_modules/eslint/package.json": JSON.stringify({ name: "eslint", bin: { eslint: "bin/eslint.js" } }), "/r/node_modules/eslint/bin/eslint.js": "" });
    const e = await resolveEntry(req("eslint"), "/r", fs, POSIX_HOST);
    expect(e).toEqual({ file: "/usr/bin/node", prefix: ["/r/node_modules/eslint/bin/eslint.js"], entry: "/r/node_modules/eslint/bin/eslint.js" });
  });

  it("pytest: first absolute PATH hit, relative entries skipped", async () => {
    const fs = memFs({ "/cwd-rel/pytest": "", "/opt/py/bin/pytest": "", "/usr/bin/pytest": "" });
    const e = await resolveEntry(req("pytest"), "/r", fs, { ...POSIX_HOST, pathEnv: ".:bin::/opt/py/bin:/usr/bin" });
    expect(e).toEqual({ file: "/opt/py/bin/pytest", prefix: [], entry: "/opt/py/bin/pytest" });
  });

  it("pytest on win32 uses pytest.exe and the ; delimiter", async () => {
    const fs = memFs({ "C:\\py\\Scripts\\pytest.exe": "" }, true);
    const e = await resolveEntry(req("pytest", "direct", "C:\\repo"), "C:\\repo", fs, { ...WIN_HOST, pathEnv: "C:\\nope;C:\\py\\Scripts" });
    expect(e).toMatchObject({ file: "C:\\py\\Scripts\\pytest.exe" });
  });

  it("pytest venv fallback and missing", async () => {
    const fs = memFs({ "/r/.venv/bin/pytest": "" });
    const r = await resolveEntry(req("pytest"), "/r/sub", fs, POSIX_HOST);
    expect(r).toMatchObject({ file: "/r/.venv/bin/pytest" });
    const win = await resolveEntry(req("pytest", "direct", "C:\\r"), "C:\\r", memFs({ "C:\\r\\.venv\\Scripts\\pytest.exe": "" }, true), WIN_HOST);
    expect(win).toMatchObject({ file: "C:\\r\\.venv\\Scripts\\pytest.exe" });
    expectS6(await resolveEntry(req("pytest"), "/r", memFs({}), POSIX_HOST), "runner-not-installed", "runner not installed: pytest");
  });

  it("uv: PATH only", async () => {
    const e = await resolveEntry(req("pytest", "uv-run"), "/r", memFs({ "/usr/bin/uv": "" }), { ...POSIX_HOST, pathEnv: "/usr/bin" });
    expect(e).toEqual({ file: "/usr/bin/uv", prefix: ["run", "pytest"], entry: "/usr/bin/uv" });
    expectS6(await resolveEntry(req("pytest", "uv-run"), "/r", memFs({ "/r/.venv/bin/pytest": "" }), POSIX_HOST), "runner-not-installed", "runner not installed: uv");
  });
});

// ---------------------------------------------------------------------------------------------
// G + H. planScopedRun
// ---------------------------------------------------------------------------------------------

const vitestArgs = (files: string[], n = 2) => [
  "/r/node_modules/vitest/vitest.mjs", "related", ...files, "--run", "--passWithNoTests", `--maxWorkers=${n}`,
  "--coverage.enabled=false", "--reporter=json", `--outputFile=/tmp/omr-verify-${UUID}.json`,
];

describe("planScopedRun: empty and unavailable", () => {
  it("unavailable -> S6; [] -> NoAffected", async () => {
    expectS6(await planScopedRun(input({ changedFiles: "unavailable" })), "attribution-unavailable", "change attribution unavailable");
    expect(await planScopedRun(input({ changedFiles: [] }))).toEqual({ noAffected: true, note: "no changed files, no affected tests" });
  });

  it("detection failures pass through", async () => {
    expectS6(await planScopedRun(input({ command: "vitest && x", changedFiles: changed("a.ts") })), "composite");
  });
});

describe("planScopedRun: vitest", () => {
  const src = { "/r/src/a.ts": "", "/r/src/b.ts": "" };

  it("builds the H argv with absolute sorted inputs, never a --", async () => {
    const s = spec(await planScopedRun(input({ files: jsRepo({}, src), changedFiles: changed("src/b.ts", "/r/src/a.ts", "src/a.ts") })));
    expect(s.file).toBe("/usr/bin/node");
    expect(s.args).toEqual(vitestArgs(["/r/src/a.ts", "/r/src/b.ts"]));
    expect(s.args).not.toContain("--");
    expect(s).toMatchObject({ runner: "vitest", mode: "related", cwd: "/r", env: {}, gitRoot: "/r", entry: "/r/node_modules/vitest/vitest.mjs", inputsAreTests: false, workers: 2 });
    expect(s.reportPath).toBe(`/tmp/omr-verify-${UUID}.json`);
    expect(REPORT_NAME_RE.test(path.posix.basename(s.reportPath))).toBe(true);
  });

  it.each([
    ["vitest", undefined, 2],
    ["vitest --maxWorkers=1", undefined, 1],
    ["vitest --maxWorkers=8", undefined, 2],
    ["vitest --maxWorkers 4", undefined, 2],
    ["vitest --maxWorkers=abc", undefined, 2],
    ["vitest --maxWorkers=50%", 1, 1],
    ["vitest --maxWorkers=50%", 16, 2],
  ])("%s (cores %s) -> exactly one --maxWorkers=%i", async (command, cores, n) => {
    const s = spec(await planScopedRun(input({ command, cores, files: jsRepo({}, src), changedFiles: changed("src/a.ts") })));
    const caps = s.args.filter((a) => a.startsWith("--maxWorkers") || a.startsWith("--max-workers"));
    expect(caps).toEqual([`--maxWorkers=${n}`]);
    expect(s.workers).toBe(n);
  });

  it("cross-env env reaches the spec", async () => {
    const s = spec(await planScopedRun(input({ command: 'cross-env X=1 Y="a b" vitest run', files: jsRepo({}, src), changedFiles: changed("src/a.ts") })));
    expect(s.env).toEqual({ X: "1", Y: "a b" });
  });

  it("monorepo fixture: script in a package, runner hoisted to the root", async () => {
    const root = path.join(FIX, "monorepo");
    const app = path.join(root, "packages", "app");
    const s = spec(
      await planScopedRun({
        command: "npm test",
        cwd: app,
        changedFiles: changed("src/math.ts"),
        budget: { maxWorkers: 2 },
        fs: fixtureFs(root),
        search: stubSearch(),
        host: { ...POSIX_HOST, platform: process.platform, tmpdir: tmpdir() },
      }),
    );
    expect(s.cwd).toBe(app);
    expect(s.entry).toBe(path.join(root, "node_modules", "vitest", "vitest.mjs"));
    expect(s.inputs).toEqual([path.join(app, "src", "math.ts")]);
    expect(s.args.filter((a) => a.startsWith("--maxWorkers"))).toEqual(["--maxWorkers=2"]);
    expect(path.dirname(s.reportPath)).toBe(path.resolve(tmpdir()));
  });

  it("runner missing -> S6 runner not installed", async () => {
    const files = { "/r/.git": "", "/r/package.json": "{}", "/r/src/a.ts": "" };
    expectS6(await planScopedRun(input({ files, changedFiles: changed("src/a.ts") })), "runner-not-installed", "runner not installed: vitest");
  });

  it("docs-only change needs no runner at all", async () => {
    const files = { "/r/.git": "", "/r/README.md": "", "/r/LICENSE": "", "/r/.github/workflows/ci.yml": "", "/r/pnpm-lock.yaml": "" };
    expect(await planScopedRun(input({ files, changedFiles: changed("README.md", "LICENSE", ".github/workflows/ci.yml", "pnpm-lock.yaml") }))).toEqual({
      noAffected: true,
      note: "no affected tests: no changed file is a test input",
    });
  });
});

describe("planScopedRun: changed-file normalization", () => {
  it("drops files outside the git root and .. traversal leaving it; keeps inside-root .. normalized", async () => {
    const files = jsRepo({}, { "/r/packages/b/x.ts": "" });
    const s = spec(
      await planScopedRun(input({ cwd: "/r", files, changedFiles: changed("/other/x.ts", "src/../../x.ts", "packages/a/../b/x.ts", ".", "bad\0.ts") })),
    );
    expect(s.inputs).toEqual(["/r/packages/b/x.ts"]);
    expect(s.notes).toEqual(expect.arrayContaining([
      "dropped outside the git root: /other/x.ts",
      "dropped outside the git root: src/../../x.ts",
      "dropped outside the git root: .",
      "dropped a path containing a NUL byte",
    ]));
  });

  it("everything dropped -> NoAffected", async () => {
    expect(isNoAffected(await planScopedRun(input({ changedFiles: changed("../x.ts") })))).toBe(true);
  });

  it("win32: drive-letter case, separators and other drives", async () => {
    const files = {
      "C:\\repo\\.git": "",
      "C:\\repo\\node_modules\\vitest\\package.json": VITEST_PKG,
      "C:\\repo\\node_modules\\vitest\\vitest.mjs": "",
      "C:\\repo\\src\\a.ts": "",
    };
    const s = spec(
      await planScopedRun(input({ win: true, files, cwd: "C:\\repo", changedFiles: changed("c:\\repo\\src\\a.ts", "src/a.ts", "C:\\REPO\\SRC\\A.TS", "D:\\repo\\src\\a.ts") })),
    );
    expect(s.inputs).toEqual(["C:\\repo\\src\\a.ts"]);
    expect(s.file).toBe("C:\\node\\node.exe");
    expect(s.reportPath).toBe(`C:\\Temp\\omr-verify-${UUID}.json`);
    expect(s.notes).toContain("dropped outside the git root: D:\\repo\\src\\a.ts");
  });

  it("spaces and unicode stay one argv element each", async () => {
    const f = "/r/src/my file ü 日本.ts";
    const s = spec(await planScopedRun(input({ files: jsRepo({}, { [f]: "" }), changedFiles: changed("src/my file ü 日本.ts") })));
    expect(s.args).toContain(f);
  });

  it("security: hostile names never become flags or shell text", async () => {
    const names = ["--config=evil.js", "a&b.ts", "$(rm -rf).ts", `q"u'o.ts`, "-n"];
    const extra = Object.fromEntries(names.map((n) => [`/r/${n}`, ""]));
    const v = spec(await planScopedRun(input({ files: jsRepo({}, extra), changedFiles: changed(...names) })));
    for (const n of names) expect(v.args).toContain(`/r/${n}`);
    for (const n of names) expect(v.args).not.toContain(n);
    expect(v.args).not.toContain("--");
    expect(v.inputs.every((i) => i.startsWith("/r/"))).toBe(true);

    const j = spec(await planScopedRun(input({ command: "jest", files: jsRepo({}, extra), changedFiles: changed(...names) })));
    const dd = j.args.indexOf("--");
    expect(dd).toBeGreaterThan(0);
    expect(j.args.slice(dd + 1)).toEqual(j.inputs);
  });
});

describe("planScopedRun: deletions, renames, config triggers", () => {
  it("deleted source with stem-matching tests runs those tests", async () => {
    const search = stubSearch({ math: ["/r/test/math.test.ts", "/r/test/gone.test.ts", "/outside/x.test.ts"] });
    const s = spec(await planScopedRun(input({ files: jsRepo({}, { "/r/test/math.test.ts": "" }), changedFiles: changed("src/math.ts"), search })));
    expect(s.inputs).toEqual(["/r/test/math.test.ts"]);
    expect(search.findByContent).toHaveBeenCalledWith("/r", "math", JS_TEST_GLOBS);
  });

  it("index and __init__ use the parent directory name", async () => {
    const search = stubSearch({ util: ["/r/t/util.test.ts"] });
    const s = spec(await planScopedRun(input({ files: jsRepo({}, { "/r/t/util.test.ts": "" }), changedFiles: changed("src/util/index.ts"), search })));
    expect(s.inputs).toEqual(["/r/t/util.test.ts"]);
  });

  it("deleted source with none -> S6; search failure; too common", async () => {
    expectS6(await planScopedRun(input({ changedFiles: changed("src/math.ts") })), "deleted-no-tests", 'deleted source src/math.ts: no test file references "math"');
    expectS6(await planScopedRun(input({ changedFiles: changed("src/math.ts"), search: stubSearch({ math: undefined }) })), "search-failed", "test search failed for src/math.ts");
    const many = Array.from({ length: STEM_MATCH_LIMIT + 1 }, (_, i) => `/r/t/${i}.test.ts`);
    expectS6(
      await planScopedRun(input({ changedFiles: changed("src/math.ts"), search: stubSearch({ math: many }) })),
      "stem-too-common",
      'deleted source src/math.ts: "math" appears in 21 test files (limit 20)',
    );
  });

  it("deleted test file -> note only", async () => {
    expect(await planScopedRun(input({ changedFiles: changed("test/a.test.ts", "src/__tests__/b.ts") }))).toEqual({
      noAffected: true,
      note: "no affected tests: no changed file is a test input",
    });
  });

  it("rename: the destination is an input, the source goes through the stem search", async () => {
    const search = stubSearch({ old: ["/r/t/old.test.ts"] });
    const s = spec(
      await planScopedRun(input({ files: jsRepo({}, { "/r/src/new.ts": "", "/r/t/old.test.ts": "" }), changedFiles: [{ path: "src/new.ts", previousPath: "src/old.ts" }], search })),
    );
    expect(s.inputs).toEqual(["/r/src/new.ts", "/r/t/old.test.ts"]);
  });

  it.each([
    ["vitest", "vitest.config.ts"],
    ["vitest", "packages/a/vite.config.mjs"],
    ["vitest", "tsconfig.build.json"],
    ["vitest", "packages/a/package.json"],
    ["jest", "babel.config.js"],
    ["jest", ".babelrc"],
    ["jest", "jest.config.ts"],
  ])("%s: %s -> config-changed", async (command, f) => {
    expectS6(await planScopedRun(input({ command, changedFiles: changed("src/a.ts", f) })), "config-changed", `config file changed: ${f}`);
  });

  it("the package.json that supplied the script is a trigger even when deleted", async () => {
    const files = jsRepo({}, { "/r/pkg/package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    expectS6(await planScopedRun(input({ command: "npm test", cwd: "/r/pkg", files, changedFiles: changed("package.json") })), "config-changed", "config file changed: pkg/package.json");
  });

  it("win32 trigger names match case-insensitively", async () => {
    const files = { "C:\\repo\\.git": "" };
    expectS6(await planScopedRun(input({ win: true, files, cwd: "C:\\repo", changedFiles: changed("Vitest.Config.ts") })), "config-changed", "config file changed: Vitest.Config.ts");
  });
});

describe("planScopedRun: jest", () => {
  it("argv: kept args, then adapter flags, then -- and files", async () => {
    const s = spec(await planScopedRun(input({ command: "npx jest --ci -w 8", files: jsRepo({}, { "/r/src/a.ts": "" }), changedFiles: changed("src/a.ts") })));
    expect(s.args).toEqual([
      "/r/node_modules/jest/bin/jest.js", "--ci", "--findRelatedTests", "--passWithNoTests", "--maxWorkers=2", "--coverage=false", "--json",
      `--outputFile=/tmp/omr-verify-${UUID}.json`, "--", "/r/src/a.ts",
    ]);
    expect(s.workers).toBe(2);
  });
});

describe("planScopedRun: pytest", () => {
  const mods = { "/r/src/pkg/mod.py": "", "/r/tests/test_mod.py": "", "/r/tests/pkg/mod_test.py": "" };
  const nameSearch = () => stubSearch({}, { "test_mod.py": ["/r/tests/test_mod.py", "/r/tests/pkg/mod_test.py"] });

  it("src/pkg/mod.py -> tests/test_mod.py and tests/pkg/mod_test.py", async () => {
    const search = nameSearch();
    const s = spec(await planScopedRun(input({ command: "pytest", files: pyRepo(mods), changedFiles: changed("src/pkg/mod.py"), search })));
    expect(search.findByName).toHaveBeenCalledWith("/r", ["test_mod.py", "mod_test.py"]);
    expect(s.inputs).toEqual(["/r/tests/pkg/mod_test.py", "/r/tests/test_mod.py"]);
    expect(s.args).toEqual(["-q", "-p", "no:cacheprovider", `--junitxml=/tmp/omr-verify-${UUID}.xml`, "--", "/r/tests/pkg/mod_test.py", "/r/tests/test_mod.py"]);
    expect(s).toMatchObject({ file: "/usr/bin/pytest", inputsAreTests: true, workers: null, env: { PYTEST_XDIST_AUTO_NUM_WORKERS: "2" } });
  });

  it("xdist, cov in config and uv run", async () => {
    const files = pyRepo({ ...mods, "/r/pytest.ini": "[pytest]\naddopts = -n auto --cov" });
    const s = spec(await planScopedRun(input({ command: "uv run pytest -x", files, changedFiles: changed("tests/test_mod.py") })));
    expect(s.file).toBe("/usr/bin/uv");
    expect(s.args).toEqual(["run", "pytest", "-x", "-q", "-p", "no:cacheprovider", `--junitxml=/tmp/omr-verify-${UUID}.xml`, "-n", "2", "--no-cov", "--", "/r/tests/test_mod.py"]);
    expect(s.workers).toBe(2);
  });

  it("-n 0 stays 0 and the auto env uses min(cores, budget)", async () => {
    const s = spec(await planScopedRun(input({ command: "pytest -n 0", cores: 1, files: pyRepo(mods), changedFiles: changed("tests/test_mod.py") })));
    expect(s.args.slice(s.args.indexOf("-n"), s.args.indexOf("-n") + 2)).toEqual(["-n", "0"]);
    expect(s.env.PYTEST_XDIST_AUTO_NUM_WORKERS).toBe("1");
  });

  it("conftest.py changed -> S6", async () => {
    expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/conftest.py") })), "config-changed", "config file changed: tests/conftest.py");
  });

  it("module with no named tests -> NoAffected pytest note; non-py skipped", async () => {
    const r = await planScopedRun(input({ command: "pytest", files: pyRepo(mods), changedFiles: changed("src/pkg/mod.py", "data.json") }));
    expect(r).toEqual({ noAffected: true, note: "no affected tests: no test files map to the changed modules" });
  });

  it("name search failure -> S6", async () => {
    const search = stubSearch({}, { "test_mod.py": undefined });
    expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(mods), changedFiles: changed("src/pkg/mod.py"), search })), "search-failed");
  });

  it("path scopes and runnerCwd filter test inputs", async () => {
    const files = pyRepo({ ...mods, "/r/other/test_x.py": "" });
    const r = await planScopedRun(input({ command: "pytest tests/unit", files, changedFiles: changed("tests/test_mod.py", "other/test_x.py") }));
    expect(r).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
  });

  it("deleted module: content and name hits; none -> S6; failures; too common", async () => {
    const files = pyRepo({ "/r/tests/test_mod.py": "", "/r/tests/test_use.py": "" });
    const ok = spec(
      await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py"), search: stubSearch({ mod: ["/r/tests/test_use.py"] }, { "test_mod.py": ["/r/tests/test_mod.py"] }) })),
    );
    expect(ok.inputs).toEqual(["/r/tests/test_mod.py", "/r/tests/test_use.py"]);
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py") })), "deleted-no-tests");
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py"), search: stubSearch({ mod: undefined }) })), "search-failed");
    const many = Array.from({ length: 21 }, (_, i) => `/r/tests/test_${i}.py`);
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py"), search: stubSearch({ mod: many }) })), "stem-too-common");
    const s = stubSearch({ mod: ["/r/tests/test_use.py"] });
    await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py"), search: s }));
    expect(s.findByContent).toHaveBeenCalledWith("/r", "mod", PY_TEST_GLOBS);
  });

  it("deleted test file -> note", async () => {
    const r = await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/test_gone.py") }));
    expect(r).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
  });
});

describe("planScopedRun: report path and argv length", () => {
  it("tmpdir inside the repo -> S6", async () => {
    const files = jsRepo({}, { "/r/src/a.ts": "" });
    expectS6(
      await planScopedRun(input({ files, changedFiles: changed("src/a.ts"), host: { ...POSIX_HOST, tmpdir: "/r/tmp" } })),
      "tmpdir-in-repo",
      "temp dir is inside the repository: /r/tmp",
    );
  });

  it("too many inputs -> S6 argv-too-long", async () => {
    const names = Array.from({ length: 400 }, (_, i) => `src/${"x".repeat(80)}${i}.ts`);
    const files = jsRepo({}, Object.fromEntries(names.map((n) => [`/r/${n}`, ""])));
    expectS6(await planScopedRun(input({ files, changedFiles: changed(...names) })), "argv-too-long", "too many inputs for one command line: 400 files");
  });
});

// ---------------------------------------------------------------------------------------------
// planStaticScoping
// ---------------------------------------------------------------------------------------------

describe("planStaticScoping", () => {
  const st = (over: Parameters<typeof input>[0]) => {
    const { search: _s, ...rest } = input(over);
    return planStaticScoping(rest);
  };

  it("unavailable, empty and detection failures", async () => {
    expectS6(await st({ changedFiles: "unavailable" }), "attribution-unavailable");
    expect(isNoAffected(await st({ changedFiles: [] }))).toBe(true);
    expectS6(await st({ command: "bun test", changedFiles: changed("a.ts") }), "bun-test");
  });

  it("counts pending searches without running any", async () => {
    expect(await st({ files: jsRepo({}, { "/r/src/a.ts": "" }), changedFiles: changed("src/a.ts", "src/gone.ts") })).toEqual({
      scopable: true,
      runner: "vitest",
      pendingSearches: 1,
      notes: [],
    });
    expect(await st({ command: "pytest", files: pyRepo({ "/r/src/m.py": "" }), changedFiles: changed("src/m.py", "src/g.py") })).toMatchObject({
      scopable: true,
      runner: "pytest",
      pendingSearches: 2,
    });
  });

  it("nothing decidable -> NoAffected; static S6s still apply", async () => {
    expect(await st({ changedFiles: changed("docs/a.md") })).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
    expectS6(await st({ changedFiles: changed("vitest.config.ts") }), "config-changed");
    expectS6(await st({ files: jsRepo({}, { "/r/a.ts": "" }), changedFiles: changed("a.ts"), host: { ...POSIX_HOST, tmpdir: "/r" } }), "tmpdir-in-repo");
    expectS6(await st({ files: { "/r/.git": "", "/r/a.ts": "" }, changedFiles: changed("a.ts") }), "runner-not-installed");
  });

  it("pytest entry notes surface (venv fallback)", async () => {
    const r = await st({ command: "pytest", files: { "/r/.git": "", "/r/.venv/bin/pytest": "", "/r/tests/test_a.py": "" }, changedFiles: changed("tests/test_a.py") });
    expect(r).toMatchObject({ scopable: true, pendingSearches: 0, notes: ["pytest resolved from /r/.venv/bin/pytest"] });
  });
});

// ---------------------------------------------------------------------------------------------
// I. readResult
// ---------------------------------------------------------------------------------------------

const REPORTS = path.join(FIX, "reports");
const RPT_JSON = `/tmp/omr-verify-${UUID}.json`;
const RPT_XML = `/tmp/omr-verify-${UUID}.xml`;

/** A captured report with its placeholders substituted. `root` is JSON-escaped for .json reports. */
function report(name: string, root: string): string {
  const raw = readFileSync(path.join(REPORTS, name), "utf8");
  const r = name.endsWith(".json") ? JSON.stringify(root).slice(1, -1) : root;
  return raw.split("<ROOT>").join(r).split("<REPO>").join("repo").split("<PYTHON>").join("py").split("<HOST>").join("host");
}

/** In-memory RunnerFs that records reads and unlinks. */
function resultFs(files: Record<string, string>, unlinkFails = false): RunnerFs & { unlinked: string[]; reads: string[] } {
  const unlinked: string[] = [];
  const reads: string[] = [];
  return {
    unlinked,
    reads,
    fileExists: async (p) => p in files,
    readFile: async (p) => {
      reads.push(p);
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    unlink: async (p) => {
      unlinked.push(p);
      if (unlinkFails) throw new Error(`EPERM ${p}`);
    },
  };
}

function mkSpec(over: Partial<ScopedSpec> = {}): ScopedSpec {
  return {
    runner: "vitest",
    mode: "related",
    file: "/usr/bin/node",
    args: [],
    cwd: "/root/vitest-proj",
    env: {},
    reportPath: RPT_JSON,
    gitRoot: "/root",
    entry: "/root/node_modules/vitest/vitest.mjs",
    inputs: [],
    inputsAreTests: false,
    workers: 2,
    notes: [],
    ...over,
  };
}

const exec = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });

async function read(sp: ScopedSpec, files: Record<string, string>, code: number, host = POSIX_HOST, stdout = ""): Promise<RunResult & { fs: ReturnType<typeof resultFs> }> {
  const fs = resultFs(files);
  const r = await readResult(sp, exec(code, stdout), fs, host);
  return { ...r, fs };
}

describe("readResult: vitest JSON", () => {
  it("failures give <file> > <ancestors> > <title> ids and delete the report", async () => {
    const r = await read(mkSpec(), { [RPT_JSON]: report("vitest-fail.json", "/root") }, 1);
    expect(r.failingIds).toEqual(["test/str.test.js > str > bad"]);
    expect(r.failingFiles).toEqual(["/root/vitest-proj/test/str.test.js"]);
    expect(r).toMatchObject({ total: 3, complete: true, collectionError: false, source: "report" });
    expect(r.note).toBeUndefined();
    expect(r.fs.unlinked).toEqual([RPT_JSON]);
  });

  it("pass and zero tests", async () => {
    const pass = await read(mkSpec(), { [RPT_JSON]: report("vitest-pass.json", "/root") }, 0);
    expect(pass).toMatchObject({ failingIds: [], failingFiles: [], total: 1, complete: true, collectionError: false });
    const none = await read(mkSpec(), { [RPT_JSON]: report("vitest-none.json", "/root") }, 0);
    expect(none).toMatchObject({ failingIds: [], total: 0, complete: true });
  });

  it("an import-time throw (assertionResults []) is a bare file id and a collection error", async () => {
    const r = await read(mkSpec(), { [RPT_JSON]: report("vitest-collect-error.json", "/root") }, 1);
    expect(r.failingIds).toEqual(["test/throws.test.js"]);
    expect(r.failingFiles).toEqual(["/root/vitest-proj/test/throws.test.js"]);
    expect(r).toMatchObject({ collectionError: true, complete: true, total: 1 });
  });

  it("non-zero exit with a report listing no failure is incomplete", async () => {
    const r = await read(mkSpec(), { [RPT_JSON]: report("vitest-pass.json", "/root") }, 1);
    expect(r).toMatchObject({ complete: false, collectionError: false, note: "runner exited 1 but its report lists no failure" });
  });

  it("tolerates odd suite shapes: non-record, nameless, no assertionResults, no titles, no total", async () => {
    const json = JSON.stringify({
      testResults: [
        null,
        { status: "failed" },
        { name: "/root/vitest-proj/a.test.ts", status: "failed", assertionResults: [{ status: "failed", title: "t" }] },
        { name: "/root/vitest-proj/b.test.ts", status: "passed" },
      ],
    });
    const r = await read(mkSpec(), { [RPT_JSON]: json }, 1);
    expect(r).toMatchObject({ failingIds: ["a.test.ts > t"], total: undefined, complete: true, collectionError: false });
  });
});

describe("readResult: jest JSON (win32 names)", () => {
  const W = { ...WIN_HOST };
  const wspec = (over: Partial<ScopedSpec> = {}) =>
    mkSpec({ runner: "jest", cwd: "C:\\root\\jest-proj", gitRoot: "C:\\root", reportPath: `C:\\Temp\\omr-verify-${UUID}.json`, ...over });
  const at = `C:\\Temp\\omr-verify-${UUID}.json`;

  it("failures map to cwd-relative / ids and native failingFiles", async () => {
    const r = await read(wspec(), { [at]: report("jest-fail.json", "C:\\root") }, 1, W);
    expect(r.failingIds).toEqual(["test/str.test.js > str > bad"]);
    expect(r.failingFiles).toEqual(["C:\\root\\jest-proj\\test\\str.test.js"]);
    expect(r).toMatchObject({ total: 3, complete: true, collectionError: false });
    expect(r.fs.unlinked).toEqual([at]);
  });

  it("'Test suite failed to run' (numRuntimeErrorTestSuites) is a collection error", async () => {
    const r = await read(wspec(), { [at]: report("jest-collect-error.json", "C:\\root") }, 1, W);
    expect(r.failingIds).toEqual(["test/broken.test.js"]);
    expect(r).toMatchObject({ collectionError: true, complete: true, total: 1 });
  });

  it("numRuntimeErrorTestSuites alone marks a collection error", async () => {
    const r = await read(wspec(), { [at]: JSON.stringify({ numRuntimeErrorTestSuites: 1, numTotalTests: 0, testResults: [] }) }, 1, W);
    expect(r).toMatchObject({ failingIds: [], collectionError: true, complete: true, total: 0 });
  });

  it("pass and none", async () => {
    expect(await read(wspec(), { [at]: report("jest-pass.json", "C:\\root") }, 0, W)).toMatchObject({ failingIds: [], total: 1, complete: true });
    expect(await read(wspec(), { [at]: report("jest-none.json", "C:\\root") }, 0, W)).toMatchObject({ failingIds: [], total: 0, complete: true });
  });

  it("the tmpdir check is case-insensitive on win32", async () => {
    const lower = `c:\\temp\\omr-verify-${UUID}.json`;
    const r = await read(wspec({ reportPath: lower }), { [lower]: report("jest-pass.json", "C:\\root") }, 0, W);
    expect(r.source).toBe("report");
    expect(r.fs.unlinked).toEqual([lower]);
  });
});

describe("readResult: fallback to text", () => {
  it("truncated JSON falls back to observeTests: incomplete, collection error on non-zero exit", async () => {
    const full = report("vitest-fail.json", "/root");
    const r = await read(mkSpec(), { [RPT_JSON]: full.slice(0, 200) }, 1, POSIX_HOST, "FAIL test/str.test.js > str > bad\n");
    expect(r).toMatchObject({
      failingIds: ["test/str.test.js > str > bad"],
      failingFiles: ["/root/vitest-proj/test/str.test.js"],
      total: undefined,
      complete: false,
      collectionError: true,
      source: "text",
      note: "runner exited 1 without a usable report",
    });
    expect(r.fs.unlinked).toEqual([RPT_JSON]);
  });

  it("vitest syntax error: exit 1 and no report is never a pass", async () => {
    const r = await read(mkSpec(), {}, 1);
    expect(r).toMatchObject({ failingIds: [], collectionError: true, complete: false, source: "text" });
    expect(r.fs.unlinked).toEqual([RPT_JSON]);
  });

  it("exit 0 without a report is noted and incomplete", async () => {
    const r = await read(mkSpec(), {}, 0);
    expect(r).toMatchObject({ collectionError: false, complete: false, note: "runner exited 0 without writing its report" });
  });

  it("a JSON value without testResults is unusable", async () => {
    expect((await read(mkSpec(), { [RPT_JSON]: "[]" }, 1)).source).toBe("text");
    expect((await read(mkSpec(), { [RPT_JSON]: "{}" }, 1)).source).toBe("text");
  });

  it("pytest FAILED lines map files; ids without a separator have no file", async () => {
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p" });
    const r = await read(sp, {}, 1, POSIX_HOST, "FAILED tests/test_a.py::test_x - boom\n--- FAIL: TestGo (0.01s)\n");
    expect(r.failingIds).toEqual(["TestGo", "tests/test_a.py::test_x"]);
    expect(r.failingFiles).toEqual(["/root/p/tests/test_a.py"]);
  });

  it("a report already deleted (unlink rejects) still yields a result", async () => {
    const fs = resultFs({}, true);
    const r = await readResult(mkSpec(), exec(1), fs, POSIX_HOST);
    expect(r.source).toBe("text");
    expect(fs.unlinked).toEqual([RPT_JSON]);
  });
});

describe("readResult: N.4 report path guard", () => {
  for (const bad of ["/etc/passwd", "/tmp/evil.json", `/tmp/sub/omr-verify-${UUID}.json`, `/r/omr-verify-${UUID}.json`, `/tmp/omr-verify-${UUID}.txt`]) {
    it(`never reads or deletes ${bad}`, async () => {
      const fs = resultFs({ [bad]: report("vitest-pass.json", "/root") });
      const r = await readResult(mkSpec({ reportPath: bad }), exec(0), fs, POSIX_HOST);
      expect(fs.unlinked).toEqual([]);
      expect(fs.reads).toEqual([]);
      expect(r).toMatchObject({ source: "text", complete: false, note: `report path rejected: ${bad}` });
    });
  }

  it("uses the process tmpdir by default", async () => {
    const p = path.join(tmpdir(), `omr-verify-${UUID}.json`);
    const fs = resultFs({ [p]: report("vitest-pass.json", "/root") });
    await readResult(mkSpec({ reportPath: p, cwd: "/root/vitest-proj" }), exec(0), fs);
    expect(fs.unlinked).toEqual([p]);
  });
});

describe("readResult: pytest junit", () => {
  const inputs = ["/root/pytest-proj/tests/test_math.py", "/root/pytest-proj/tests/test_str.py", "/root/pytest-proj/tests/test_broken.py"];
  const pspec = (over: Partial<ScopedSpec> = {}) =>
    mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/pytest-proj", gitRoot: "/root", inputs, inputsAreTests: true, ...over });

  it("classname maps to the file via the longest module suffix", async () => {
    const r = await read(pspec(), { [RPT_XML]: report("pytest-fail.xml", "/root") }, 1);
    expect(r.failingIds).toEqual(["tests/test_str.py::TestStr::test_bad"]);
    expect(r.failingFiles).toEqual(["/root/pytest-proj/tests/test_str.py"]);
    expect(r).toMatchObject({ total: 3, complete: true, collectionError: false, source: "report" });
    expect(r.fs.unlinked).toEqual([RPT_XML]);
  });

  it("xdist report (ANSI escapes, reordered cases) gives the same ids", async () => {
    const r = await read(pspec(), { [RPT_XML]: report("pytest-xdist-fail.xml", "/root") }, 1);
    expect(r.failingIds).toEqual(["tests/test_str.py::TestStr::test_bad"]);
    expect(r.total).toBe(3);
  });

  it("collection <error> is a bare file id, not counted in total (exit 2)", async () => {
    const r = await read(pspec(), { [RPT_XML]: report("pytest-collect-error.xml", "/root") }, 2);
    expect(r.failingIds).toEqual(["tests/test_broken.py"]);
    expect(r).toMatchObject({ collectionError: true, total: 0, complete: true });
  });

  it("exit 5: no tests collected is complete with total 0; pass is complete", async () => {
    expect(await read(pspec(), { [RPT_XML]: report("pytest-none.xml", "/root") }, 5)).toMatchObject({ failingIds: [], total: 0, complete: true });
    expect(await read(pspec(), { [RPT_XML]: report("pytest-pass.xml", "/root") }, 0)).toMatchObject({ failingIds: [], total: 1, complete: true });
  });

  it("exit 4 and 3 are incomplete with their notes", async () => {
    expect(await read(pspec(), { [RPT_XML]: report("pytest-missing.xml", "/root") }, 4)).toMatchObject({ complete: false, note: "pytest usage error (exit 4)" });
    expect(await read(pspec(), { [RPT_XML]: report("pytest-none.xml", "/root") }, 3)).toMatchObject({ complete: false, note: "pytest internal error (exit 3)" });
  });

  it("exit 1 with no failure in the report is incomplete", async () => {
    expect(await read(pspec(), { [RPT_XML]: report("pytest-pass.xml", "/root") }, 1)).toMatchObject({ complete: false, note: "runner exited 1 but its report lists no failure" });
  });

  it("unmapped classnames keep a raw id and make the result incomplete", async () => {
    const r = await read(pspec({ inputs: [] }), { [RPT_XML]: report("pytest-fail.xml", "/root") }, 1);
    expect(r).toMatchObject({ failingIds: ["tests.test_str.TestStr::test_bad"], failingFiles: [], complete: false, note: "pytest classname not mapped to a test file: tests.test_str.TestStr" });
    const c = await read(pspec({ inputs: [] }), { [RPT_XML]: report("pytest-collect-error.xml", "/root") }, 2);
    expect(c).toMatchObject({ failingIds: ["tests.test_broken"], collectionError: true, complete: false });
  });

  it("setup <error> is a failure; entities decode; <skipped> is not a failure; truncated XML falls back", async () => {
    const xml =
      '<?xml version="1.0"?><testsuites><testsuite>' +
      '<testcase classname="tests.test_math" name="test_p[a&amp;b&#65;&#x42;&lt;&gt;&quot;&apos;]"><error message="fixture failed">x</error></testcase>' +
      '<testcase classname="tests.test_math" name="test_s"><skipped message="s"/></testcase>' +
      "<testcase /></testsuite></testsuites>";
    const r = await read(pspec(), { [RPT_XML]: xml }, 1);
    // The attribute-less <testcase /> has classname "": an unmapped collection pseudo-case with an empty id.
    expect(r.failingIds).toEqual(["", "tests/test_math.py::test_p[a&bAB<>\"']"]);
    expect(r).toMatchObject({ total: 2, collectionError: true, complete: false });
    const t = await read(pspec(), { [RPT_XML]: report("pytest-fail.xml", "/root").slice(0, 300) }, 1);
    expect(t.source).toBe("text");
  });
});

// ---------------------------------------------------------------------------------------------
// planRerun (1.3.2.e)
// ---------------------------------------------------------------------------------------------

describe("planRerun", () => {
  const budget = { maxWorkers: 2 };
  const host = { ...POSIX_HOST, pathEnv: "/usr/bin" };
  const VITEST_ENTRY = "/r/node_modules/vitest/vitest.mjs";

  it("vitest: run exactly the existing files, never a --, workers capped", async () => {
    const files = jsRepo({}, { "/r/test/a.test.ts": "", "/r/test/b.test.ts": "" });
    const det = await detect("vitest run --maxWorkers=8 --silent", files);
    const r = spec(
      await planRerun(det, ["/r/test/b.test.ts", "/r/test/a.test.ts", "/r/test/gone.test.ts", "rel.test.ts", "/elsewhere/x.test.ts", "/r/test/a.test.ts"], "/r", budget, {
        fs: memFs(files),
        host,
      }),
    );
    expect(r.args).toEqual([
      VITEST_ENTRY, "run", "/r/test/a.test.ts", "/r/test/b.test.ts", "--silent", "--passWithNoTests", "--maxWorkers=2",
      "--coverage.enabled=false", "--reporter=json", `--outputFile=${RPT_JSON}`,
    ]);
    expect(r.args).not.toContain("--");
    expect(r).toMatchObject({ mode: "rerun", inputsAreTests: true, workers: 2, cwd: "/r", gitRoot: "/r", file: "/usr/bin/node", entry: VITEST_ENTRY });
    expect(r.notes).toEqual([
      "rerun file missing in this tree: test/gone.test.ts",
      "rerun file dropped (relative or outside the git root): rel.test.ts",
      "rerun file dropped (relative or outside the git root): /elsewhere/x.test.ts",
    ]);
  });

  it("jest: --runTestsByPath with -- before the files", async () => {
    const files = jsRepo({}, { "/r/test/a.test.js": "" });
    const det = await detect("jest -i", files);
    const r = spec(await planRerun(det, ["/r/test/a.test.js"], "/r", budget, { fs: memFs(files), host, cores: 4 }));
    expect(r.args).toEqual([
      "/r/node_modules/jest/bin/jest.js", "--runTestsByPath", "--passWithNoTests", "--maxWorkers=1", "--coverage=false", "--json",
      `--outputFile=${RPT_JSON}`, "--", "/r/test/a.test.js",
    ]);
  });

  it("pytest: same argv as scoped, -- before the files", async () => {
    const files = pyRepo({ "/r/tests/test_a.py": "" });
    const det = await detect("pytest", files, host);
    const r = spec(await planRerun(det, ["/r/tests/test_a.py"], "/r", budget, { fs: memFs(files), host }));
    expect(r.file).toBe("/usr/bin/pytest");
    expect(r.args).toEqual(["-q", "-p", "no:cacheprovider", `--junitxml=${RPT_XML}`, "--", "/r/tests/test_a.py"]);
    expect(r.workers).toBeNull();
  });

  it("reference worktree: the current tree's entry is reused, ids stay cwd-relative", async () => {
    const cur = jsRepo();
    const det = await detect("vitest", cur);
    const entry = await resolveEntry(det, "/r", memFs(cur), host);
    if (isUnverifiable(entry)) throw new Error(entry.reason);
    const refFiles = { "/ref/.git": "", "/ref/test/a.test.ts": "" };
    const withEntry = spec(await planRerun(det, ["/ref/test/a.test.ts"], "/ref", budget, { fs: memFs(refFiles), host, entry }));
    expect(withEntry).toMatchObject({ cwd: "/ref", gitRoot: "/ref", entry: VITEST_ENTRY, inputs: ["/ref/test/a.test.ts"] });
    expectS6(await planRerun(det, ["/ref/test/a.test.ts"], "/ref", budget, { fs: memFs(refFiles), host }), "runner-not-installed");
  });

  it("nothing left -> NoAffected; no git root and tmpdir-in-repo -> S6", async () => {
    const det = await detect("vitest");
    expect(await planRerun(det, ["/r/test/gone.test.ts"], "/r", budget, { fs: memFs(jsRepo()), host })).toEqual({
      noAffected: true,
      note: "no rerun: none of the test files exist in this tree",
    });
    expectS6(await planRerun(det, ["/x/a.test.ts"], "/x", budget, { fs: memFs({ "/x/a.test.ts": "" }), host }), "no-git-root");
    const files = jsRepo({}, { "/r/a.test.ts": "" });
    expectS6(await planRerun(det, ["/r/a.test.ts"], "/r", budget, { fs: memFs(files), host: { ...host, tmpdir: "/r/tmp" } }), "tmpdir-in-repo");
  });

  it("entry notes (pytest venv) are carried", async () => {
    const files = { "/r/.git": "", "/r/.venv/bin/pytest": "", "/r/tests/test_a.py": "" };
    const det = await detect("pytest", files, POSIX_HOST);
    const r = spec(await planRerun(det, ["/r/tests/test_a.py"], "/r", budget, { fs: memFs(files), host: POSIX_HOST }));
    expect(r.notes).toEqual(["pytest resolved from /r/.venv/bin/pytest"]);
  });
});

// ---------------------------------------------------------------------------------------------
// K. planScopedLint (1.3.2.g)
// ---------------------------------------------------------------------------------------------

const ESLINT_ENTRY = "/r/node_modules/eslint/bin/eslint.js";
function lintRepo(version = "9.1.0", scripts: Record<string, string> = {}, extra: Record<string, string> = {}): Record<string, string> {
  return jsRepo(scripts, {
    "/r/node_modules/eslint/package.json": JSON.stringify({ name: "eslint", version, bin: { eslint: "./bin/eslint.js" } }),
    [ESLINT_ENTRY]: "",
    "/r/src/a.ts": "",
    "/r/src/b.vue": "",
    "/r/lib/c.js": "",
    "/r/README.md": "",
    ...extra,
  });
}

async function lint(command: string, changedFiles: ChangedPath[] | "unavailable", files = lintRepo(), host: Partial<RunnerHost> = POSIX_HOST) {
  const { search: _s, ...rest } = input({ command, changedFiles, files, win: host.platform === "win32" });
  return planScopedLint({ ...rest, host });
}

function lintSpec(x: object): LintSpec {
  expect(isUnscoped(x) || isNoAffected(x), JSON.stringify(x)).toBe(false);
  return x as LintSpec;
}

function expectUnscoped(x: object, reason: string): void {
  expect(x).toEqual({ unscoped: true, reason });
}

describe("planScopedLint", () => {
  it("plain eslint: only changed lintable files, absolute, with --no-warn-ignored on v9", async () => {
    const r = lintSpec(await lint("eslint --fix --cache .", changed("src/a.ts", "README.md", "src/b.vue", "src/gone.ts", "../out.ts")));
    expect(r.args).toEqual([ESLINT_ENTRY, "--cache", "--no-warn-ignored", "/r/src/a.ts"]);
    expect(r).toMatchObject({ runner: "eslint", file: "/usr/bin/node", cwd: "/r", gitRoot: "/r", entry: ESLINT_ENTRY, inputs: ["/r/src/a.ts"], workers: null });
    expect(r.notes).toEqual(["dropped outside the git root: ../out.ts"]);
  });

  it("npm run lint script: --ext, path scopes and --concurrency capped", async () => {
    const files = lintRepo("9.1.0", { lint: "eslint --ext .vue,ts --concurrency 4 src" });
    const r = lintSpec(await lint("npm run lint", changed("src/a.ts", "src/b.vue", "lib/c.js"), files));
    expect(r.args).toEqual([ESLINT_ENTRY, "--ext", ".vue,ts", "--concurrency=2", "--no-warn-ignored", "/r/src/a.ts", "/r/src/b.vue"]);
    expect(r.workers).toBe(2);
  });

  it("--ext= form, --concurrency off kept, --concurrency=auto", async () => {
    const a = lintSpec(await lint("eslint --ext=vue --concurrency off", changed("src/a.ts", "src/b.vue")));
    expect(a.args).toEqual([ESLINT_ENTRY, "--ext=vue", "--concurrency", "off", "--no-warn-ignored", "/r/src/b.vue"]);
    expect(a.workers).toBeNull();
    expect(lintSpec(await lint("npx eslint --concurrency=auto", changed("src/a.ts"))).args).toContain("--concurrency=2");
  });

  it("eslint < 9: no --no-warn-ignored; --max-warnings -> Unscoped", async () => {
    const r = lintSpec(await lint("pnpm exec eslint", changed("src/a.ts"), lintRepo("8.57.0")));
    expect(r.args).toEqual([ESLINT_ENTRY, "/r/src/a.ts"]);
    expectUnscoped(await lint("eslint --max-warnings 0", changed("src/a.ts"), lintRepo("8.57.0")), "eslint <9 cannot scope ignored files under --max-warnings");
    expectUnscoped(await lint("eslint --max-warnings=0", changed("src/a.ts"), lintRepo("8.57.0")), "eslint <9 cannot scope ignored files under --max-warnings");
  });

  it("composites and unsupported commands -> Unscoped with the B/C reason", async () => {
    expectUnscoped(await lint("npm run lint", changed("src/a.ts"), lintRepo("9.1.0", { lint: "tsc && eslint ." })), 'composite scripts.lint: "&&"');
    expectUnscoped(await lint("next lint", changed("src/a.ts")), 'unsupported command "next" in command');
    expectUnscoped(await lint("vitest", changed("src/a.ts")), 'unsupported command "vitest" in command');
    expectUnscoped(await lint("pytest", changed("src/a.ts")), 'unsupported command "pytest" in command');
    expectUnscoped(await lint("uv run pytest", changed("src/a.ts")), 'unsupported command "uv run pytest" in command');
    expectUnscoped(await lint("npx vitest", changed("src/a.ts")), 'unsupported command "npx vitest" in command');
    expectUnscoped(await lint("eslint --init", changed("src/a.ts")), 'unsupported eslint argument "--init" in command');
    expectUnscoped(await lint("eslint src/**", changed("src/a.ts")), 'eslint glob pattern in command: "src/**"');
    expectUnscoped(await lint("eslint ../elsewhere", changed("src/a.ts")), 'unsupported eslint argument "../elsewhere" in command');
  });

  it("unavailable, empty, config changes, nothing lintable, not installed", async () => {
    expectUnscoped(await lint("eslint", "unavailable"), "change attribution unavailable");
    expect(await lint("eslint", [])).toEqual({ noAffected: true, note: "no changed lintable files" });
    expectUnscoped(await lint("eslint", changed("src/a.ts", "eslint.config.js")), "eslint config changed: eslint.config.js");
    expectUnscoped(await lint("eslint", changed("pkg/.eslintrc.json")), "eslint config changed: pkg/.eslintrc.json");
    expect(await lint("eslint src", changed("README.md", "lib/c.js"))).toEqual({ noAffected: true, note: "no changed lintable files" });
    expectUnscoped(await lint("eslint", changed("src/a.ts"), jsRepo({}, { "/r/src/a.ts": "" })), "runner not installed: eslint");
  });

  it("win32: config trigger match is case-insensitive", async () => {
    const files = Object.fromEntries(Object.entries(lintRepo()).map(([k, v]) => [`C:${k.replace(/\//g, "\\")}`, v]));
    const host = { ...WIN_HOST };
    const { search: _s, ...rest } = input({ command: "eslint", changedFiles: changed("ESLint.Config.JS"), files, win: true, cwd: "C:\\r" });
    expectUnscoped(await planScopedLint({ ...rest, host }), "eslint config changed: ESLint.Config.JS");
    const ok = await planScopedLint({ ...rest, changedFiles: changed("src\\A.TS"), host });
    expect(lintSpec(ok).inputs).toEqual(["C:\\r\\src\\A.TS"]);
  });

  it("too many files -> Unscoped", async () => {
    const extra: Record<string, string> = {};
    const names: string[] = [];
    for (let i = 0; i < 300; i++) {
      const n = `src/${"x".repeat(120)}${i}.ts`;
      extra[`/r/${n}`] = "";
      names.push(n);
    }
    expectUnscoped(await lint("eslint", changed(...names), lintRepo("9.1.0", {}, extra)), "too many inputs for one command line: 300 files");
  });
});
