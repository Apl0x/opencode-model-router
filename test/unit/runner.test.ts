import { afterAll, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath as fsRealpath } from "node:fs/promises";
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
  CONFIG_SIZE_LIMIT,
  DEFAULT_PYTHON_FILES,
  SEARCH_LIMIT,
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
  type PlannerFs,
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
  env: {},
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
    expect(d.keptArgs).toEqual(["-t", "x"]);
    expect(d.notes).toContain("npm options ignored: --silent");
    expect(d.notes).toContain("early-exit option dropped for a full failure inventory");
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

  it.each(["--foo=1", "--bar", "--foo bar", "-z"])("unknown option %s fails closed (QA-1.3-10)", async (a) => {
    await detectS6(`vitest ${a}`, "unsupported-argument", `unsupported vitest argument "${a.split(" ")[0]}" in command`);
  });
});

describe("detectRunner: jest arguments", () => {
  it("drops, caps and keeps per D.3", async () => {
    const d = await detect("jest --json --reporters default summary --ci --outputFile o.json --bail --testPathPatterns a b -e --coverage x");
    expect(d.keptArgs).toEqual(["--ci", "--testPathPatterns", "a", "b", "-e"]);
    expect(d.notes).toEqual(["early-exit option dropped for a full failure inventory", "coverage disabled for the scoped run", "jest filters dropped: x"]);
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

  it("-c=value is kept; -cvalue is S6 because yargs reads it as grouped flags (QA-1.3-10)", async () => {
    expect((await detect("jest -c=jest.config.js")).keptArgs).toEqual(["-c=jest.config.js"]);
    await detectS6("jest -cjest.config.js", "unsupported-argument", 'unsupported jest argument "-cjest.config.js" in command');
  });
});

describe("detectRunner: pytest arguments and xdist evidence", () => {
  it("drops the adapter's own flags, keeps the rest", async () => {
    const d = await detect("pytest -q -p no:cacheprovider -pno:cacheprovider -p myplugin -rA --cov src --junitxml=j.xml -x -k slow", pyRepo());
    expect(d.keptArgs).toEqual(["-p", "myplugin", "-rA", "-k", "slow"]);
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
    const files = { "/r/.git": "", "/r/README.md": "", "/r/LICENSE": "", "/r/.github/workflows/ci.yml": "" };
    expect(await planScopedRun(input({ files, changedFiles: changed("README.md", "LICENSE", ".github/workflows/ci.yml") }))).toEqual({
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

  it("everything dropped -> S6 attribution-unavailable, never NoAffected (QA-1.3-7)", async () => {
    expectS6(
      await planScopedRun(input({ changedFiles: changed("../x.ts", "bad\0.ts") })),
      "attribution-unavailable",
      "change attribution unavailable: no changed path lies inside the git root",
    );
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
    expect(s.args).toEqual(["-q", "-p", "no:cacheprovider", `--junitxml=/tmp/omr-verify-${UUID}.xml`, "--maxfail=0", "--", "/r/tests/pkg/mod_test.py", "/r/tests/test_mod.py"]);
    expect(s).toMatchObject({ file: "/usr/bin/pytest", inputsAreTests: true, workers: null, env: { PYTEST_XDIST_AUTO_NUM_WORKERS: "2" } });
  });

  it("xdist, cov in config and uv run", async () => {
    const files = pyRepo({ ...mods, "/r/pytest.ini": "[pytest]\naddopts = -n auto --cov" });
    const s = spec(await planScopedRun(input({ command: "uv run pytest -x", files, changedFiles: changed("tests/test_mod.py") })));
    expect(s.file).toBe("/usr/bin/uv");
    expect(s.args).toEqual(["run", "pytest", "-q", "-p", "no:cacheprovider", `--junitxml=/tmp/omr-verify-${UUID}.xml`, "--maxfail=0", "-n", "2", "--no-cov", "--", "/r/tests/test_mod.py"]);
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

  it("exit 5: nothing collected from test-file inputs is incomplete (QA-1.3-19); pass is complete", async () => {
    expect(await read(pspec(), { [RPT_XML]: report("pytest-none.xml", "/root") }, 5)).toMatchObject({
      failingIds: [],
      total: 0,
      complete: false,
      note: "pytest ran no tests although a test file was passed",
    });
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
    // The attribute-less <testcase /> is a passing case (QA-1.3-22: classname "" alone is not a collection error).
    expect(r.failingIds).toEqual(["tests/test_math.py::test_p[a&bAB<>\"']"]);
    expect(r).toMatchObject({ total: 3, collectionError: false, complete: true });
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
    expect(r.args).toEqual(["-q", "-p", "no:cacheprovider", `--junitxml=${RPT_XML}`, "--maxfail=0", "--", "/r/tests/test_a.py"]);
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
  it("plain eslint v9: every existing changed file, absolute, with --no-warn-ignored (QA-1.3-9)", async () => {
    const r = lintSpec(await lint("eslint --fix --cache .", changed("src/a.ts", "README.md", "src/b.vue", "src/gone.ts", "../out.ts")));
    const all = ["/r/README.md", "/r/src/a.ts", "/r/src/b.vue"];
    expect(r.args).toEqual([ESLINT_ENTRY, "--cache", "--no-warn-ignored", ...all]);
    expect(r).toMatchObject({ runner: "eslint", file: "/usr/bin/node", cwd: "/r", gitRoot: "/r", entry: ESLINT_ENTRY, inputs: all, workers: null });
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
    expect(a.args).toEqual([ESLINT_ENTRY, "--ext=vue", "--concurrency", "off", "--no-warn-ignored", "/r/src/a.ts", "/r/src/b.vue"]);
    expect(a.workers).toBeNull();
    expect(lintSpec(await lint("npx eslint --concurrency=auto", changed("src/a.ts"))).args).toContain("--concurrency=2");
  });

  it("eslint < 9: extension filter, no --no-warn-ignored; --max-warnings -> Unscoped", async () => {
    const r = lintSpec(await lint("pnpm exec eslint", changed("src/a.ts", "src/b.vue", "README.md"), lintRepo("8.57.0")));
    expect(r.args).toEqual([ESLINT_ENTRY, "/r/src/a.ts"]);
    expect(await lint("eslint", changed("README.md", "src/b.vue"), lintRepo("8.57.0"))).toEqual({ noAffected: true, note: "no changed lintable files" });
    expect(lintSpec(await lint("eslint --ext .vue", changed("src/a.ts", "src/b.vue"), lintRepo("8.57.0"))).inputs).toEqual(["/r/src/b.vue"]);
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

// ---------------------------------------------------------------------------------------------
// QA round 1 (docs/qa/verification-resource-budget/phase-1.3.md, QA-1.3-1..15)
// ---------------------------------------------------------------------------------------------

/**
 * memFs plus a native-like realpath: `aliases` maps an alias prefix (an 8.3 name, a junction, a
 * symlink) to its target. Directories exist when a file lies below them. On win32 the realpath
 * result carries a \\?\ prefix, which the planner must strip.
 */
function aliasFs(files: Record<string, string>, win: boolean, aliases: Record<string, string>): PlannerFs {
  const P = win ? path.win32 : path.posix;
  const k = (p: string) => (win ? p.toLowerCase() : p);
  const known = new Map(Object.entries(files).map(([p, c]) => [k(P.normalize(p)), c]));
  const real = (p: string) => {
    const q = P.normalize(p);
    for (const [from, to] of Object.entries(aliases)) {
      if (k(q) === k(from) || k(q).startsWith(k(from) + P.sep)) return to + q.slice(from.length);
    }
    return q;
  };
  const exists = (p: string) => known.has(k(p)) || [...known.keys()].some((f) => f.startsWith(k(p) + P.sep));
  return {
    fileExists: async (p) => exists(real(p)),
    readFile: async (p) => {
      const v = known.get(k(real(p)));
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    realpath: async (p) => {
      const r = real(p);
      if (!exists(r)) throw new Error(`ENOENT ${p}`);
      return win ? `\\\\?\\${r}` : r;
    },
  };
}

function jsonReport(numTotalTests: number): string {
  return JSON.stringify({ numTotalTests, numRuntimeErrorTestSuites: 0, testResults: [] });
}

describe("QA-1.3-1: canonical paths through the realpath seam", () => {
  const REAL = "/real/r";
  const files = jsRepo({}, { [`${REAL}/src/a.js`]: "", [`${REAL}/test/a.test.js`]: "" }, REAL);

  it("a symlinked or junction cwd plans on the real paths, so jest's realpath'd rootDir matches", async () => {
    const fs = aliasFs(files, false, { "/link": REAL });
    const d = (await detectRunner("jest", "/link", fs, POSIX_HOST)) as DetectedRunner;
    expect(d).toMatchObject({ gitRoot: REAL, runnerCwd: REAL });
    const s = spec(await planScopedRun(input({ command: "jest", cwd: "/link", fs, changedFiles: changed("/link/src/a.js", "test/a.test.js") })));
    expect(s).toMatchObject({ cwd: REAL, gitRoot: REAL, inputs: [`${REAL}/src/a.js`, `${REAL}/test/a.test.js`] });
    expect(s.lexicalPaths).toBeUndefined();
    expect(s.args.slice(-3)).toEqual(["--", `${REAL}/src/a.js`, `${REAL}/test/a.test.js`]);
  });

  it("win32 8.3 short names and \\\\?\\ results canonicalize to the long spelling", async () => {
    const LONG = "C:\\Users\\Marquinho\\p";
    const w = {
      [`${LONG}\\.git`]: "",
      [`${LONG}\\node_modules\\jest\\package.json`]: JEST_PKG,
      [`${LONG}\\node_modules\\jest\\bin\\jest.js`]: "",
      [`${LONG}\\src\\a.js`]: "",
    };
    const fs = aliasFs(w, true, { "C:\\Users\\MARQUI~1": "C:\\Users\\Marquinho" });
    const s = spec(await planScopedRun(input({ win: true, command: "jest", cwd: "C:\\Users\\MARQUI~1\\p", fs, changedFiles: changed("src\\a.js") })));
    expect(s).toMatchObject({ cwd: LONG, gitRoot: LONG, inputs: [`${LONG}\\src\\a.js`] });
  });

  it("a deleted file keeps its lexical tail below the nearest real ancestor", async () => {
    const fs = aliasFs(files, false, { "/link": REAL });
    const search = stubSearch({ gone: [`${REAL}/test/a.test.js`] });
    const s = spec(await planScopedRun(input({ command: "jest", cwd: "/link", fs, search, changedFiles: changed("/link/src/deep/gone.js") })));
    expect(s.inputs).toEqual([`${REAL}/test/a.test.js`]);
  });

  it("a path whose every ancestor is missing stays lexical", async () => {
    const fs = aliasFs({}, false, {});
    expectS6(await detectRunner("jest", "/nowhere", fs, POSIX_HOST), "no-git-root", "no git repository at or above /nowhere");
  });

  it("planRerun canonicalizes cwd and test files", async () => {
    const fs = aliasFs(files, false, { "/link": REAL });
    const det = await detect("jest", files, POSIX_HOST, REAL);
    const r = spec(await planRerun(det, ["/link/test/a.test.js"], "/link", { maxWorkers: 2 }, { fs, host: POSIX_HOST }));
    expect(r).toMatchObject({ cwd: REAL, gitRoot: REAL, inputs: [`${REAL}/test/a.test.js`] });
  });

  it("without realpath the spec is marked lexical", async () => {
    const s = spec(await planScopedRun(input({ command: "jest", files, cwd: REAL, changedFiles: changed("src/a.js") })));
    expect(s.lexicalPaths).toBe(true);
    const r = spec(await planRerun(await detect("jest", files, POSIX_HOST, REAL), [`${REAL}/test/a.test.js`], REAL, { maxWorkers: 2 }, { fs: memFs(files), host: POSIX_HOST }));
    expect(r.lexicalPaths).toBe(true);
  });

  describe("readResult: a total of 0 is never a vacuous pass", () => {
    const at = RPT_JSON;
    const run = (over: Partial<ScopedSpec>, total = 0, code = 0) => read(mkSpec({ runner: "jest", ...over }), { [at]: jsonReport(total) }, code);

    it.each<[string, Partial<ScopedSpec>, string]>([
      ["rerun", { mode: "rerun", inputs: ["/root/vitest-proj/test/a.test.js"], inputsAreTests: true }, "rerun ran no tests although every input is a test file"],
      ["rerun (vitest)", { runner: "vitest", mode: "rerun", inputs: ["/root/vitest-proj/test/a.test.js"] }, "rerun ran no tests although every input is a test file"],
      ["jest related given a test file", { inputs: ["/root/vitest-proj/src/a.js", "/root/vitest-proj/test/a.test.js"] }, "jest ran no tests although a test file was passed"],
      ["jest related given a __tests__ file", { inputs: ["/root/vitest-proj/src/__tests__/a.js"] }, "jest ran no tests although a test file was passed"],
      ["jest planned without realpath", { inputs: ["/root/vitest-proj/src/a.js"], lexicalPaths: true }, "jest ran no tests and the paths were not canonicalized (no realpath seam)"],
    ])("%s -> complete false", async (_name, over, note) => {
      expect(await run(over)).toMatchObject({ total: 0, complete: false, note });
    });

    it("related over sources only with canonical paths: 0 stays a complete result (jest and vitest)", async () => {
      expect(await run({ inputs: ["/root/vitest-proj/src/a.js"] })).toMatchObject({ total: 0, complete: true });
      expect(await run({ runner: "vitest", inputs: ["/root/vitest-proj/src/a.js"] })).toMatchObject({ total: 0, complete: true });
    });

    it("the guard never touches a run with tests, failures or a collection error", async () => {
      expect(await run({ mode: "rerun" }, 2)).toMatchObject({ total: 2, complete: true });
      const withError = JSON.stringify({ numTotalTests: 0, numRuntimeErrorTestSuites: 1, testResults: [] });
      expect(await read(mkSpec({ runner: "jest", mode: "rerun" }), { [at]: withError }, 1)).toMatchObject({ complete: true, collectionError: true });
      const failed = JSON.stringify({ numTotalTests: 0, testResults: [{ name: "/root/vitest-proj/a.test.js", status: "failed", assertionResults: [] }] });
      expect(await read(mkSpec({ runner: "jest", mode: "rerun" }), { [at]: failed }, 1)).toMatchObject({ complete: true, failingIds: ["a.test.js"] });
    });

    it("pytest rerun with exit 5 (nothing collected) is incomplete", async () => {
      const sp = mkSpec({ runner: "pytest", mode: "rerun", reportPath: RPT_XML, inputs: ["/root/vitest-proj/tests/test_a.py"] });
      expect(await read(sp, { [RPT_XML]: report("pytest-none.xml", "/root") }, 5)).toMatchObject({ total: 0, complete: false });
    });
  });

  describe("real filesystem: a junction (win32) or symlink to the repo", () => {
    const base = mkdtempSync(path.join(tmpdir(), "omr-qa131-"));
    afterAll(() => rmSync(base, { recursive: true, force: true }));
    const repo = path.join(base, "repo");
    for (const [rel, body] of Object.entries({
      ".git": "gitdir: elsewhere",
      "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" } }),
      "node_modules/jest/package.json": JEST_PKG,
      "node_modules/jest/bin/jest.js": "",
      "src/str.js": "",
    })) {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), body);
    }
    const link = path.join(base, "link");
    symlinkSync(repo, link, "junction");
    const realFs: PlannerFs = {
      fileExists: async (p) => existsSync(p),
      readFile: async (p) => readFileSync(p, "utf8"),
      realpath: (p) => fsRealpath(p),
    };

    it("plans with the native realpath, whatever spelling tmpdir() and the link use", async () => {
      const canonical = realpathSync.native(repo);
      const host = { ...POSIX_HOST, platform: process.platform, tmpdir: path.parse(base).root + "omr-no-such-tmp" };
      const s = spec(
        await planScopedRun({ command: "npm test", cwd: link, changedFiles: changed(path.join(link, "src", "str.js")), budget: { maxWorkers: 2 }, fs: realFs, search: stubSearch(), host }),
      );
      expect(s.cwd).toBe(canonical);
      expect(s.gitRoot).toBe(canonical);
      expect(s.inputs).toEqual([path.join(canonical, "src", "str.js")]);
      expect(s.lexicalPaths).toBeUndefined();
    });
  });
});

describe("QA-1.3-7: win32 path spellings and fully dropped change sets", () => {
  const W = {
    "C:\\repo\\.git": "",
    "C:\\repo\\node_modules\\vitest\\package.json": VITEST_PKG,
    "C:\\repo\\node_modules\\vitest\\vitest.mjs": "",
    "C:\\repo\\src\\a.ts": "",
  };

  it.each(["\\\\?\\C:\\repo\\vitest.config.mjs", "\\\\.\\C:\\repo\\vitest.config.mjs", "//?/C:/repo/vitest.config.mjs"])("%s is a config trigger", async (p) => {
    expectS6(await planScopedRun(input({ win: true, files: W, cwd: "C:\\repo", changedFiles: changed(p) })), "config-changed", "config file changed: vitest.config.mjs");
  });

  it("\\\\?\\UNC\\ becomes \\\\server\\share", async () => {
    const u = { "\\\\srv\\share\\repo\\.git": "", "\\\\srv\\share\\repo\\conftest.py": "" };
    const r = await planScopedRun(input({ win: true, command: "pytest", files: u, cwd: "\\\\srv\\share\\repo", changedFiles: changed("\\\\?\\UNC\\srv\\share\\repo\\conftest.py") }));
    expectS6(r, "config-changed", "config file changed: conftest.py");
  });

  it("a symlink named like a trigger is a trigger even when its target is not", async () => {
    const fs = aliasFs(jsRepo({}, { "/r/cfg/base.ts": "" }), false, { "/r/vitest.config.ts": "/r/cfg/base.ts" });
    expectS6(await planScopedRun(input({ fs, changedFiles: changed("vitest.config.ts") })), "config-changed", "config file changed: cfg/base.ts");
  });

  it("the prefix is only stripped on win32", async () => {
    const r = await planScopedRun(input({ changedFiles: changed("//?/r/vitest.config.ts") }));
    expectS6(r, "attribution-unavailable");
  });

  it("static scoping and lint: every path outside -> S6 / Unscoped", async () => {
    const { search: _s, ...rest } = input({ changedFiles: changed("/elsewhere/a.ts") });
    expectS6(await planStaticScoping(rest), "attribution-unavailable", "change attribution unavailable: no changed path lies inside the git root");
    expectUnscoped(await lint("eslint", changed("/elsewhere/a.ts")), "change attribution unavailable: no changed path lies inside the git root");
  });
});

describe("QA-1.3-11: the tmpdir must be absolute and outside the repo", () => {
  const files = jsRepo({}, { "/r/src/a.ts": "", "/r/test/a.test.ts": "", "/r/tmp/keep": "" });

  it("a relative tmpdir -> S6 tmpdir-in-repo (scoped, static, rerun)", async () => {
    const host = { ...POSIX_HOST, tmpdir: "tmp" };
    const why = "temp dir is not an absolute path: tmp";
    expectS6(await planScopedRun(input({ files, host, changedFiles: changed("src/a.ts") })), "tmpdir-in-repo", why);
    const { search: _s, ...rest } = input({ files, host, changedFiles: changed("src/a.ts") });
    expectS6(await planStaticScoping(rest), "tmpdir-in-repo", why);
    expectS6(await planRerun(await detect("vitest", files), ["/r/test/a.test.ts"], "/r", { maxWorkers: 2 }, { fs: memFs(files), host }), "tmpdir-in-repo", why);
  });

  it("a tmpdir that is a link into the repo -> S6", async () => {
    const fs = aliasFs(files, false, { "/tmpx": "/r/tmp" });
    const host = { ...POSIX_HOST, tmpdir: "/tmpx" };
    expectS6(await planScopedRun(input({ fs, host, changedFiles: changed("src/a.ts") })), "tmpdir-in-repo", "temp dir is inside the repository: /tmpx");
  });

  it("readResult never touches a report when the tmpdir or the report path is relative", async () => {
    for (const [tmp, rp] of [["tmp", `tmp/omr-verify-${UUID}.json`], ["/tmp", `omr-verify-${UUID}.json`]]) {
      const fs = resultFs({ [rp]: jsonReport(1) });
      const r = await readResult(mkSpec({ reportPath: rp }), exec(0), fs, { ...POSIX_HOST, tmpdir: tmp });
      expect(r).toMatchObject({ source: "text", complete: false, note: `report path rejected: ${rp}` });
      expect(fs.reads).toEqual([]);
      expect(fs.unlinked).toEqual([]);
    }
  });
});

describe("QA-1.3-12: malformed junit never rejects", () => {
  const pspec = () => mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root", inputs: ["/root/p/tests/test_math.py"], inputsAreTests: true });
  const xml = (name: string) =>
    `<?xml version="1.0"?><testsuites><testsuite><testcase classname="tests.test_math" name="${name}"><failure/></testcase></testsuite></testsuites>`;

  it.each([
    ["&#x110000;", "&#x110000;"],
    ["&#1114112;", "&#1114112;"],
    ["&#xD800;", "&#xD800;"],
    ["&#99999999999999999999999;", "&#99999999999999999999999;"],
    ["&#x10FFFF;&#xE000;&#55295;", "\u{10FFFF}\uE000\uD7FF"],
  ])("%s decodes to %j", async (raw, decoded) => {
    const r = await read(pspec(), { [RPT_XML]: xml(`t[${raw}]`) }, 1);
    expect(r.failingIds).toEqual([`tests/test_math.py::t[${decoded}]`]);
    expect(r.source).toBe("report");
  });

  it("a parser exception falls back to text and still deletes the report", async () => {
    const base = mkSpec();
    const hostile: ScopedSpec = {
      ...base,
      get cwd(): string {
        throw new Error("boom");
      },
    };
    const fs = resultFs({ [RPT_JSON]: report("vitest-fail.json", "/root") });
    const r = await readResult(hostile, exec(1), fs, POSIX_HOST);
    expect(r).toMatchObject({ source: "text", complete: false, collectionError: true, note: "report could not be parsed: boom" });
    expect(fs.unlinked).toEqual([RPT_JSON]);
    const odd = { ...base, get cwd(): string { throw "str"; } };
    expect((await readResult(odd, exec(1), resultFs({ [RPT_JSON]: report("vitest-fail.json", "/root") }), POSIX_HOST)).note).toBe("report could not be parsed: str");
  });
});

describe("QA-1.3-14: argv length counts win32 quoting and the program path", () => {
  const W = (extra: Record<string, string>) => ({
    "C:\\repo\\.git": "",
    "C:\\repo\\node_modules\\vitest\\package.json": VITEST_PKG,
    "C:\\repo\\node_modules\\vitest\\vitest.mjs": "",
    ...extra,
  });

  it("paths with spaces that fit unquoted but not quoted -> S6", async () => {
    const names = Array.from({ length: 296 }, (_, i) => `src\\${String(i).padStart(3, "0")} ${"x".repeat(80)}.ts`);
    const files = W(Object.fromEntries(names.map((n) => [`C:\\repo\\${n}`, ""])));
    const plain = names.reduce((n, f) => n + `C:\\repo\\${f}`.length + 1, 0);
    expect(plain).toBeLessThan(30000 - 300);
    expectS6(await planScopedRun(input({ win: true, files, cwd: "C:\\repo", changedFiles: changed(...names) })), "argv-too-long", "too many inputs for one command line: 296 files");
  });

  it("posix counts the program path too", async () => {
    const names = Array.from({ length: 280 }, (_, i) => `src/${String(i).padStart(3, "0")}${"x".repeat(92)}.ts`);
    const files = jsRepo({}, Object.fromEntries(names.map((n) => [`/r/${n}`, ""])));
    const long = { ...POSIX_HOST, pathEnv: "/usr/bin", execPath: `/${"n".repeat(300)}/node` };
    expectS6(await planScopedRun(input({ files, host: long, changedFiles: changed(...names) })), "argv-too-long");
    expect(isScopedSpec(await planScopedRun(input({ files, changedFiles: changed(...names) })))).toBe(true);
  });

  it("quotes, trailing backslashes and empty arguments are counted without failing a normal plan", async () => {
    const files = W({ 'C:\\repo\\src\\q"u o.ts': "" });
    const s = spec(await planScopedRun(input({ win: true, files, cwd: "C:\\repo", command: `vitest -t "" --dir 'C:\\a b\\'`, changedFiles: changed('src\\q"u o.ts') })));
    expect(s.args).toContain('C:\\repo\\src\\q"u o.ts');
    expect(s.args).toContain("C:\\a b\\");
  });
});

describe("QA-1.3-2: early-exit options are dropped for a full failure inventory", () => {
  const EE = "early-exit option dropped for a full failure inventory";
  const mods = { "/r/tests/test_a.py": "" };

  it.each(["-x", "--exitfirst", "--maxfail 3", "--maxfail=3", "-xq", "-qx"])("pytest %s", async (a) => {
    const d = await detect(`pytest ${a} -v`, pyRepo(mods));
    expect(d.keptArgs).toEqual(["-v"]);
    expect(d.notes).toContain(EE);
    const s = spec(await planScopedRun(input({ command: `pytest ${a}`, files: pyRepo(mods), changedFiles: changed("tests/test_a.py") })));
    expect(s.args.filter((x) => x === "-x" || x.startsWith("--maxfail"))).toEqual(["--maxfail=0"]);
  });

  it.each(["--bail 1", "--bail=1"])("vitest %s", async (a) => {
    const d = await detect(`vitest ${a} --silent`);
    expect(d.keptArgs).toEqual(["--silent"]);
    expect(d.notes).toContain(EE);
  });

  it.each(["--bail", "-b", "--bail=2", "-b 1", "-ib"])("jest %s", async (a) => {
    const d = await detect(`jest ${a} --ci`);
    expect(d.keptArgs).toEqual(["--ci"]);
    expect(d.notes).toContain(EE);
  });
});

describe("QA-1.3-10: option spellings are normalized before the D tables", () => {
  it.each([
    ["--update-snapshot", []],
    ["-u", []],
    ["-ou", []],
    ["-uo", []],
    ["--watch-all", []],
    ["--watch-all=false", []],
    ["--list-tests", []],
    ["-f", []],
    ["--only-failures", []],
    ["--onlyFailures", []],
    ["--no-coverage", []],
    ["--detect-open-handles", ["--detect-open-handles"]],
    ["--test-name-pattern x", ["--test-name-pattern", "x"]],
    ["-ie", ["-e"]],
    ["-ic cfg.js", ["-c", "cfg.js"]],
  ])("jest %s -> kept %j", async (a, kept) => {
    expect((await detect(`jest ${a}`)).keptArgs).toEqual(kept);
  });

  it.each([
    ["-iw4", { count: 4 }],
    ["--max-workers=3", { count: 3 }],
    ["--run-in-band", { count: 1 }],
  ])("jest %s -> cap %j", async (a, cap) => {
    expect((await detect(`jest ${a}`)).userWorkers).toEqual(cap);
  });

  it.each(["-tfoo", "-oz", "-z", "--frobnicate", "--frobnicate=1", "--test-failure-exit-code 0"])("jest %s fails closed", async (a) => {
    await detectS6(`jest ${a}`, "unsupported-argument", `unsupported jest argument "${a.split(" ")[0]}" in command`);
  });

  it.each([
    ["--merge-reports=.vitest-reports", []],
    ["--merge-reports", []],
    ["--pass-with-no-tests", []],
    ["-uw", []],
    ["-u=1", []],
    ["--no-file-parallelism", ["--no-file-parallelism"]],
    ["--test-name-pattern x", ["--test-name-pattern", "x"]],
    ["-ut x", ["-t", "x"]],
    ["-t=x", ["-t=x"]],
    ["--typecheck.only", ["--typecheck.only"]],
  ])("vitest %s -> kept %j", async (a, kept) => {
    expect((await detect(`vitest ${a}`)).keptArgs).toEqual(kept);
  });

  it.each(["-cfoo", "-w4", "-tu", "-uz", "--poolOptions.threads.maxThreads=8", "--pool-options.forks.max-forks=8"])("vitest %s fails closed", async (a) => {
    await detectS6(`vitest ${a}`, "unsupported-argument", `unsupported vitest argument "${a}" in command`);
  });

  it("pytest and eslint keep rule g: = form and flags kept, a value-looking next token is ambiguous", async () => {
    expect((await detect("pytest --foo=1 --bar --baz", pyRepo())).keptArgs).toEqual(["--foo=1", "--bar", "--baz"]);
    await detectS6("pytest --reruns 2", "ambiguous-option", 'ambiguous pytest option "--reruns" in command: cannot tell whether "2" is its value', pyRepo());
    expectUnscoped(await lint("eslint --foo bar", changed("src/a.ts")), 'ambiguous eslint option "--foo" in command: cannot tell whether "bar" is its value');
  });

  it("vitest --max-workers is the cap under either spelling", async () => {
    expect((await detect("vitest --max-workers 8")).userWorkers).toEqual({ count: 8 });
    expect((await detect("vitest --max-workers=1 --maxWorkers=6")).userWorkers).toEqual({ count: 6 });
  });
});

describe("QA-1.3-3b: pytest grouped short flags follow argparse", () => {
  it.each([
    ["-qn3", { count: 3 }, true, []],
    ["-vn 2", { count: 2 }, true, ["-v"]],
    ["-qk slow", undefined, false, ["-k", "slow"]],
    ["-vrA", undefined, false, ["-v", "-rA"]],
    ["-qpno:xdist -n 2", { count: 2 }, false, ["-pno:xdist"]],
    ["-vvv", undefined, false, ["-v", "-v", "-v"]],
  ])("%s -> cap %j, xdist %s, kept %j", async (a, cap, xdist, kept) => {
    const d = await detect(`pytest ${a}`, pyRepo());
    expect(d.userWorkers).toEqual(cap);
    expect(d.xdist).toBe(xdist);
    expect(d.keptArgs).toEqual(kept);
  });

  it("an -n inside a group is capped in the argv", async () => {
    const s = spec(await planScopedRun(input({ command: "pytest -qn3", files: pyRepo({ "/r/tests/test_a.py": "" }), changedFiles: changed("tests/test_a.py") })));
    expect(s.args.slice(s.args.indexOf("-n"), s.args.indexOf("-n") + 2)).toEqual(["-n", "2"]);
    expect(s.args.filter((x) => x.startsWith("-qn") || x === "-n3")).toEqual([]);
  });

  it.each(["-qz", "-zq", "--tx=3*popen", "--tx 3*popen"])("%s -> S6", async (a) => {
    await detectS6(`pytest ${a}`, "unsupported-argument", `unsupported pytest argument "${a.split(" ")[0]}" in command`, pyRepo());
  });
});

describe("QA-1.3-6: package-manager location options are S6", () => {
  it.each([
    ["npm test -w packages/app", "npm -w"],
    ["npm test --workspace=packages/app", "npm --workspace=packages/app"],
    ["npm test --workspaces", "npm --workspaces"],
    ["npm test -ws", "npm -ws"],
    ["npm test --prefix x", "npm --prefix"],
    ["npm run test --include-workspace-root", "npm --include-workspace-root"],
    ["npm test foo", "npm foo"],
    ["npm -w a test", "npm -w"],
    ["pnpm test --filter app", "pnpm --filter"],
    ["pnpm test -C dir", "pnpm -C"],
    ["pnpm run test --dir=x", "pnpm --dir=x"],
    ["pnpm --filter app test", "pnpm --filter"],
    ["yarn test --cwd x", "yarn --cwd"],
    ["bun run test --filter=x", "bun --filter=x"],
  ])("%s -> unsupported %j", async (cmd, prefix) => {
    await detectS6(cmd, "unsupported-command", `unsupported command "${prefix}" in command`, jsRepo({ test: "vitest" }));
  });

  it("harmless npm options are ignored with a note; after -- everything reaches the script", async () => {
    const d = await detect("npm test -s --if-present --loglevel=silent --color=always -- -t x", jsRepo({ test: "vitest" }));
    expect(d.keptArgs).toEqual(["-t", "x"]);
    expect(d.notes).toContain("npm options ignored: -s --if-present --loglevel=silent --color=always");
    expect((await detect("pnpm test -- --dir x", jsRepo({ test: "vitest" }))).keptArgs).toEqual(["--dir", "x"]);
  });
});

describe("QA-1.3-3a/c: every xdist source is found, so the cap always lands", () => {
  const T = { "/r/tests/test_a.py": "" };
  const nArgs = (s: ScopedSpec) => s.args.slice(s.args.indexOf("-n"), s.args.indexOf("-n") + 2);
  const plan = async (command: string, files: Record<string, string>, host: Partial<RunnerHost> = { ...POSIX_HOST, pathEnv: "/usr/bin" }) =>
    spec(await planScopedRun(input({ command, files: pyRepo({ ...T, ...files }), host, changedFiles: changed("tests/test_a.py") })));

  it("(a) cross-env PYTEST_ADDOPTS in a script", async () => {
    const files = pyRepo({ ...T, "/r/package.json": JSON.stringify({ scripts: { test: 'cross-env PYTEST_ADDOPTS="-n 3" pytest' } }) });
    const d = await detect("npm test", files);
    expect(d).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    const s = spec(await planScopedRun(input({ command: "npm test", files, changedFiles: changed("tests/test_a.py") })));
    expect(nArgs(s)).toEqual(["-n", "2"]);
    expect(s.env.PYTEST_ADDOPTS).toBe("-n 3");
  });

  it("(a) the cross-env value replaces the host one for the cap; both count as evidence", async () => {
    const host = { ...POSIX_HOST, pytestAddopts: "-n 6 --cov" };
    expect(await detect('cross-env PYTEST_ADDOPTS="-n 1" pytest', pyRepo(), host)).toMatchObject({ xdist: true, covInConfig: true, userWorkers: { count: 1 } });
    expect(await detect("cross-env PYTEST_ADDOPTS= pytest", pyRepo(), { ...POSIX_HOST, pytestAddopts: "-p no:xdist" })).toMatchObject({ xdist: false });
  });

  it.each([
    ["/r/.pytest.ini", "[pytest]\naddopts = -n 3\n"],
    ["/r/pytest.toml", '[pytest]\naddopts = ["-n", "3"]\n'],
    ["/r/.pytest.toml", "[pytest]\naddopts = '-n 3'\n"],
    ["/r/pyproject.toml", '[tool.pytest]\naddopts = ["-n", "3"]\n'],
    ["/r/pyproject.toml", '[ "tool" . pytest . ini_options ] # c\naddopts = """\n-n 3\n"""\n'],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = '''-n 3'''\n"],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = [\n  "-n", # workers\n  \'3\',\n]\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "-n \\u0033 -k \\"a b\\" -m \\t\\\\x"\n'],
    ["/r/tox.ini", "[tox]\nenv = py\n[pytest]\n; comment\naddopts =\n    -n 3\n    --cov\n"],
    ["/r/setup.cfg", "[metadata]\nname = x\n[tool:pytest] # c\naddopts: -n 3\n"],
    ["/pytest.ini", "[pytest]\naddopts = -n 3\n"],
  ])("(c) %s is read the way pytest reads it", async (f, text) => {
    const d = await detect("pytest", pyRepo({ [f]: text }));
    expect(d).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expect(nArgs(await plan("pytest", { [f]: text }))).toEqual(["-n", "2"]);
  });

  it("(c) files pytest skips do not stop the search", async () => {
    const files = pyRepo({
      "/r/sub/pyproject.toml": "[project]\nname = 'x'\n[[tool.pytest.ini_options]]\n",
      "/r/sub/tox.ini": "[tox]\n[testenv]\ncommands = pytest -n 9\n",
      "/r/sub/setup.cfg": "[metadata]\n",
      "/r/pytest.ini": "[pytest]\naddopts = -n 3\n",
    });
    expect(await detect("pytest", files, POSIX_HOST, "/r/sub")).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
  });

  it("(c) the first accepted file in a directory wins, even an empty pytest.ini (every pytest line)", async () => {
    expect(await detect("pytest", pyRepo({ "/r/pytest.ini": "", "/r/tox.ini": "[pytest]\naddopts = -n 3\n" }))).toMatchObject({ xdist: false });
    expect(await detect("pytest", pyRepo({ "/r/pytest.ini": "[pytest]\n", "/r/.pytest.ini": "[pytest]\naddopts = -n 3\n" }))).toMatchObject({ xdist: false });
  });

  it("(c) -c / --config-file: only that file, in its format", async () => {
    const files = { "/r/cfg/unit.ini": "[pytest]\naddopts = -n 3\n", "/r/cfg/unit.toml": "[tool.pytest.ini_options]\naddopts = '-n 4'\n", "/r/pytest.ini": "[pytest]\n" };
    expect(await detect("pytest -c cfg/unit.ini", pyRepo(files))).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expect(await detect("pytest --config-file=cfg/unit.toml", pyRepo(files))).toMatchObject({ xdist: true, userWorkers: { count: 4 } });
    expect(await detect("pytest -c cfg/missing.ini", pyRepo(files))).toMatchObject({ xdist: false });
    expect((await detect("pytest -c cfg/unit.ini", pyRepo({}), POSIX_HOST)).pytestFacts).toMatchObject({ configFile: "/r/cfg/unit.ini" });
  });

  it("(c) -o addopts replaces the config's addopts", async () => {
    const files = pyRepo({ "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" });
    expect(await detect('pytest -o "addopts=-n 4"', files)).toMatchObject({ xdist: true, userWorkers: { count: 4 } });
    expect(await detect("pytest -o addopts=", files)).toMatchObject({ xdist: false });
    expect(await detect("pytest --override-ini=addopts=--cov", files)).toMatchObject({ xdist: false, covInConfig: true });
  });

  it("(c) at spec time the lookup starts from the inputs, like pytest", async () => {
    const files = { "/r/pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-q'\n", "/r/tests/unit/pytest.ini": "[pytest]\naddopts = -n 3\n", "/r/tests/unit/test_u.py": "" };
    expect(await detect("pytest", pyRepo(files))).toMatchObject({ xdist: false });
    const s = spec(await planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed("tests/unit/test_u.py") })));
    expect(nArgs(s)).toEqual(["-n", "2"]);
    expect(s.workers).toBe(2);
    const det = await detect("pytest", pyRepo(files));
    const r = spec(await planRerun(det, ["/r/tests/unit/test_u.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(files)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(nArgs(r)).toEqual(["-n", "2"]);
  });

  it("(c) a DetectedRunner without pytestFacts keeps what it knew", async () => {
    const { pytestFacts: _f, ...det } = await detect("pytest -n 1 --dist load", pyRepo(T));
    const r = spec(await planRerun({ ...det, covInConfig: true }, ["/r/tests/test_a.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(T)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(nArgs(r)).toEqual(["-n", "1"]);
    expect(r.args).toContain("--no-cov");
    const bare = spec(await planRerun({ ...det, xdist: false }, ["/r/tests/test_a.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(T)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(bare.workers).toBeNull();
  });

  it("(c) unreadable config notes are not repeated at spec time", async () => {
    const files = pyRepo({ ...T, "/r/tox.ini": "x" });
    const s = spec(await planScopedRun(input({ command: "pytest", fs: memFs(files, false, {}, ["/r/tox.ini"]), changedFiles: changed("tests/test_a.py") })));
    expect(s.notes.filter((n) => n.startsWith("unreadable pytest config"))).toEqual(["unreadable pytest config ignored: /r/tox.ini"]);
  });

  it.each([
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = -n 3\n"],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "-n 3\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "-n 3'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = """-n \\\n 3"""\n'],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = '''-n 3\n"],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = [ 3 ]\n"],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "\\q"\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "\\u12"\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "\\uD800"\n'],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = 'a\nb'\n"],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = \"-k 'x\"\n"],
    ["/r/pytest.ini", "[pytest]\naddopts = -k \"x\n"],
  ])("(c) addopts the adapter cannot read -> S6 (%s)", async (f, text) => {
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ [f]: text })), POSIX_HOST), "unsupported-argument", `unsupported pytest argument "addopts" in ${f}`);
  });

  it("(c) a table without addopts, and an ini key without a value, are simply empty", async () => {
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": "[tool.pytest.ini_options]\nminversion = '6'\n[tool.other]\naddopts = '-n 9'\n" }))).toMatchObject({ xdist: false });
    expect(await detect("pytest", pyRepo({ "/r/pytest.ini": "[pytest]\nnot a key line\n  -n 9\n[other]\naddopts = -n 9\n" }))).toMatchObject({ xdist: false });
  });
});

describe("QA-1.3-13: a positional in addopts or PYTEST_ADDOPTS is S6", () => {
  it.each([
    [{ "/r/pytest.ini": "[pytest]\naddopts = tests\n" }, "", "tests", "addopts of /r/pytest.ini"],
    [{ "/r/pytest.ini": "[pytest]\naddopts = --foo data.txt\n", "/r/data.txt": "" }, "", "data.txt", "addopts of /r/pytest.ini"],
    [{}, "-q tests/", "tests/", "PYTEST_ADDOPTS"],
  ])("%j with PYTEST_ADDOPTS %j -> S6 naming %s", async (files, env, token, where) => {
    const r = await detectRunner("pytest", "/r", memFs(pyRepo(files)), { ...POSIX_HOST, pytestAddopts: env });
    expectS6(r, "unsupported-argument", `unsupported pytest argument "${token}" in ${where}`);
  });

  it("an unknown option's value that names no file is kept as a value", async () => {
    expect(await detect("pytest", pyRepo({ "/r/pytest.ini": "[pytest]\naddopts = --reruns 2 --doctest-modules -ra\n" }))).toMatchObject({ xdist: false });
  });

  it("cross-env PYTEST_ADDOPTS and -o addopts are checked too; unterminated quotes are S6", async () => {
    await detectS6('cross-env PYTEST_ADDOPTS="tests" pytest', "unsupported-argument", 'unsupported pytest argument "tests" in PYTEST_ADDOPTS', pyRepo());
    await detectS6('pytest -o "addopts=tests"', "unsupported-argument", 'unsupported pytest argument "tests" in -o addopts', pyRepo());
    await detectS6(`pytest -o "addopts=-k 'x"`, "unterminated-quote", "unterminated quote in -o addopts", pyRepo());
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo()), { ...POSIX_HOST, pytestAddopts: '-k "x' }), "unterminated-quote", "unterminated quote in PYTEST_ADDOPTS");
  });

  it("the spec-time lookup applies the same rule (see also QA-1.3-3c)", async () => {
    const files = { "/r/tests/unit/pytest.ini": "[pytest]\naddopts = more_tests\n", "/r/tests/unit/test_u.py": "" };
    expect(await detect("pytest", pyRepo(files))).toMatchObject({ xdist: false });
    expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed("tests/unit/test_u.py") })), "unsupported-argument");
    const det = await detect("pytest", pyRepo(files));
    expectS6(await planRerun(det, ["/r/tests/unit/test_u.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(files)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }), "unsupported-argument");
  });
});

describe("QA-1.3-4/8/15: config triggers", () => {
  it.each([".pytest.ini", "pytest.toml", ".pytest.toml", "sub/pytest.toml", "uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock", "requirements.txt", "requirements-dev.txt"])(
    "pytest: %s -> config-changed",
    async (f) => {
      expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/test_a.py", f) })), "config-changed", `config file changed: ${f}`);
    },
  );

  it.each(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "pnpm-workspace.yaml", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs"])(
    "vitest and jest: lockfile or workspace file %s -> config-changed",
    async (f) => {
      for (const command of ["vitest", "jest"]) {
        expectS6(await planScopedRun(input({ command, changedFiles: changed(f) })), "config-changed", `config file changed: ${f}`);
      }
      expectUnscoped(await lint("eslint", changed("src/a.ts", f)), `eslint config changed: ${f}`);
    },
  );

  it.each(["vitest.setup.ts", "setupTests.ts", "src/setup-tests.js", "global-setup.ts", "globalSetup.mts", "jest.setup.js", "test-setup.tsx", "src/app.setup.ts", "test.setup.cjs"])(
    "vitest and jest: setup file %s -> config-changed",
    async (f) => {
      for (const command of ["vitest", "jest"]) {
        expectS6(await planScopedRun(input({ command, changedFiles: changed(f) })), "config-changed", `config file changed: ${f}`);
      }
    },
  );

  it("a test named like a setup file, and other names, are ordinary inputs", async () => {
    const files = jsRepo({}, { "/r/src/setup.test.ts": "", "/r/src/setupHelper.ts": "", "/r/src/__tests__/setup.ts": "" });
    const s = spec(await planScopedRun(input({ files, changedFiles: changed("src/setup.test.ts", "src/setupHelper.ts", "src/__tests__/setup.ts") })));
    expect(s.inputs).toEqual(["/r/src/__tests__/setup.ts", "/r/src/setup.test.ts", "/r/src/setupHelper.ts"]);
    expect(isNoAffected(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/setup.ts") })))).toBe(true);
  });
});

describe("QA-1.3-5: a --config / -c file is a config trigger", () => {
  const files = jsRepo({}, { "/r/cfg/unit.config.mjs": "", "/r/src/a.ts": "" });

  it.each([
    ["vitest run --config cfg/unit.config.mjs", "cfg/unit.config.mjs"],
    ["vitest -c=cfg/unit.config.mjs", "cfg/unit.config.mjs"],
    ["vitest --config=./cfg/../cfg/unit.config.mjs", "cfg/unit.config.mjs"],
    ["jest --config cfg/j.json", "cfg/j.json"],
    ["jest -c=cfg/j.json", "cfg/j.json"],
  ])("%s: %s changed -> config-changed", async (command, f) => {
    expectS6(await planScopedRun(input({ command, files, changedFiles: changed("src/a.ts", f) })), "config-changed", `config file changed: ${f}`);
  });

  it("pytest -c / --config-file and eslint -c / --config", async () => {
    expectS6(await planScopedRun(input({ command: "pytest -c cfg/unit.ini", files: pyRepo(), changedFiles: changed("cfg/unit.ini") })), "config-changed", "config file changed: cfg/unit.ini");
    expectS6(await planScopedRun(input({ command: "pytest --config-file cfg/u.cfg", files: pyRepo(), changedFiles: changed("cfg/u.cfg") })), "config-changed");
    expectUnscoped(await lint("eslint -c cfg/lint.mjs", changed("src/a.ts", "cfg/lint.mjs")), "eslint config changed: cfg/lint.mjs");
    expectUnscoped(await lint("eslint --config=cfg/lint.mjs", changed("cfg/lint.mjs")), "eslint config changed: cfg/lint.mjs");
  });

  it("the value resolves against the runner's cwd (a package script) and through realpath", async () => {
    const pkg = jsRepo({}, { "/r/pkg/package.json": JSON.stringify({ scripts: { test: "vitest --config conf/v.mjs" } }), "/r/pkg/conf/v.mjs": "" });
    const d = await detect("npm test", pkg, POSIX_HOST, "/r/pkg");
    expect(d.configFiles).toEqual(["/r/pkg/conf/v.mjs"]);
    expectS6(await planScopedRun(input({ command: "npm test", cwd: "/r/pkg", files: pkg, changedFiles: changed("conf/v.mjs") })), "config-changed", "config file changed: pkg/conf/v.mjs");
    const fs = aliasFs({ ...files, "/r/real/cfg.mjs": "" }, false, { "/r/cfg/link.mjs": "/r/real/cfg.mjs" });
    expectS6(await planScopedRun(input({ command: "vitest --config cfg/link.mjs", fs, changedFiles: changed("real/cfg.mjs") })), "config-changed", "config file changed: real/cfg.mjs");
  });

  it("an unrelated change still plans normally", async () => {
    expect(isScopedSpec(await planScopedRun(input({ command: "vitest --config cfg/unit.config.mjs", files, changedFiles: changed("src/a.ts") })))).toBe(true);
  });
});

describe("QA-1.3-9: eslint >= 9 lints what its flat config matches", () => {
  it("a .vue change is passed on (the QA repro: eslint ., src/App.vue)", async () => {
    const r = lintSpec(await lint("eslint .", changed("src/App.vue"), lintRepo("9.1.0", {}, { "/r/src/App.vue": "" })));
    expect(r.inputs).toEqual(["/r/src/App.vue"]);
    expect(r.args.slice(-2)).toEqual(["--no-warn-ignored", "/r/src/App.vue"]);
  });

  it("an unknown version counts as < 9", async () => {
    const files = jsRepo({}, { "/r/node_modules/eslint/package.json": JSON.stringify({ name: "eslint", bin: { eslint: "./bin/eslint.js" } }), [ESLINT_ENTRY]: "", "/r/src/App.vue": "" });
    expect(await lint("eslint", changed("src/App.vue"), files)).toEqual({ noAffected: true, note: "no changed lintable files" });
  });
});

// ---------------------------------------------------------------------------------------------
// QA round 2 (docs/qa/verification-resource-budget/phase-1.3.md, QA-1.3-18..28)
// ---------------------------------------------------------------------------------------------

describe("QA-1.3-18: JS tools run under node, never under Bun or a compiled binary", () => {
  const W = {
    "C:\\repo\\.git": "",
    "C:\\repo\\node_modules\\jest\\package.json": JEST_PKG,
    "C:\\repo\\node_modules\\jest\\bin\\jest.js": "",
    "C:\\repo\\src\\a.js": "",
    "C:\\Program Files\\nodejs\\node.exe": "",
  };
  const winPlan = (host: Partial<RunnerHost>, files: Record<string, string> = W, fs?: PlannerFs) =>
    planScopedRun(input({ win: true, command: "jest", files, cwd: "C:\\repo", changedFiles: changed("src\\a.js"), host, ...(fs ? { fs } : {}) }));
  const bunHost = (execPath: string, pathEnv: string, pathExt = ".COM;.EXE;.BAT;.CMD") => ({ ...WIN_HOST, execPath, pathEnv, pathExt });

  it.each(["C:\\Users\\M\\.bun\\bin\\bun.exe", "C:\\tools\\opencode.exe"])("execPath %s -> node.exe from PATH", async (execPath) => {
    const s = spec(await winPlan(bunHost(execPath, "rel\\bin;C:\\nope;C:\\Program Files\\nodejs")));
    expect(s.file).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(s.args[0]).toBe("C:\\repo\\node_modules\\jest\\bin\\jest.js");
  });

  it("PATHEXT order decides, as in the shell: a node.cmd shim first -> S6; .exe first -> the exe", async () => {
    const files = { ...W, "C:\\shim\\node.cmd": "", "C:\\shim\\node.exe": "" };
    expectS6(await winPlan(bunHost("C:\\b\\bun.exe", "C:\\shim;C:\\Program Files\\nodejs", ".CMD;.EXE"), files), "node-not-found", "node on PATH is not an executable file: C:\\shim\\node.cmd");
    expect(spec(await winPlan(bunHost("C:\\b\\bun.exe", "C:\\shim", ".EXE;.CMD"), files)).file).toBe("C:\\shim\\node.exe");
    expectS6(await winPlan(bunHost("C:\\b\\bun.exe", "C:\\Program Files\\nodejs", ".CMD; ;bat")), "node-not-found", "node not found: no absolute PATH entry has a node executable");
  });

  it("no node anywhere -> S6 for tests, Unscoped for lint; pytest needs no node", async () => {
    expectS6(await winPlan(bunHost("C:\\b\\bun.exe", "C:\\nope")), "node-not-found", "node not found: no absolute PATH entry has a node executable");
    const noNode = { ...POSIX_HOST, execPath: "/home/u/.bun/bin/bun", pathEnv: "/usr/bin" };
    expectUnscoped(await lint("eslint", changed("src/a.ts"), lintRepo(), noNode), "node not found: no absolute PATH entry has a node executable");
    const py = spec(await planScopedRun(input({ command: "pytest", files: pyRepo({ "/r/tests/test_a.py": "" }), host: noNode, changedFiles: changed("tests/test_a.py") })));
    expect(py.file).toBe("/usr/bin/pytest");
  });

  it("host.nodePath wins over execPath and PATH; a relative one -> S6", async () => {
    expect(spec(await winPlan({ ...WIN_HOST, nodePath: "D:\\n\\node.exe" })).file).toBe("D:\\n\\node.exe");
    expectS6(await winPlan({ ...WIN_HOST, nodePath: "node.exe" }), "node-not-found", "node path is not absolute: node.exe");
  });

  it("the default execPath is used only when the runtime is not Bun", async () => {
    // The host platform must be the real one: the default execPath is process.execPath.
    const win = process.platform === "win32";
    const { execPath: _e, ...noExec } = win ? WIN_HOST : POSIX_HOST;
    const pathNode = win ? "C:\\opt\\node\\node.exe" : "/opt/node/bin/node";
    const files = win ? { ...W, [pathNode]: "" } : jsRepo({}, { "/r/src/a.js": "", [pathNode]: "" });
    const host = { ...noExec, platform: process.platform, pathEnv: win ? "C:\\opt\\node" : "/opt/node/bin" };
    const run = async () =>
      spec(await planScopedRun(input({ win, command: "jest", files, host, cwd: win ? "C:\\repo" : "/r", changedFiles: changed(win ? "src\\a.js" : "src/a.js") }))).file;
    expect(await run()).toBe(process.execPath);
    Object.defineProperty(process.versions, "bun", { value: "1.3.14", configurable: true });
    try {
      expect(await run()).toBe(pathNode);
    } finally {
      Reflect.deleteProperty(process.versions, "bun");
    }
  });

  it("a PATH node that realpaths to bun (bun run's temporary link) is skipped", async () => {
    const files = jsRepo({}, { "/r/src/a.js": "", "/home/u/.bun/bin/bun": "", "/usr/local/bin/node": "" });
    const fs = aliasFs(files, false, { "/tmp/bun-node-1/node": "/home/u/.bun/bin/bun" });
    const host = { ...POSIX_HOST, execPath: "/home/u/.bun/bin/bun", pathEnv: "/tmp/bun-node-1:/usr/local/bin" };
    expect(spec(await planScopedRun(input({ command: "jest", fs, host, changedFiles: changed("src/a.js") }))).file).toBe("/usr/local/bin/node");
    const wfs = aliasFs({ ...W, "C:\\Users\\u\\.bun\\bin\\bun.exe": "" }, true, { "C:\\Temp\\bun-node-1\\node.exe": "C:\\Users\\u\\.bun\\bin\\bun.exe" });
    const wspec = spec(await winPlan(bunHost("C:\\Users\\u\\.bun\\bin\\bun.exe", "C:\\Temp\\bun-node-1;C:\\Program Files\\nodejs"), W, wfs));
    expect(wspec.file).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("a realpath failure keeps the PATH node", async () => {
    const base = memFs(jsRepo({}, { "/r/src/a.js": "", "/usr/local/bin/node": "" }));
    const fs: PlannerFs = { ...base, realpath: async (p) => (p === "/usr/local/bin/node" ? Promise.reject(new Error("EACCES")) : p) };
    const host = { ...POSIX_HOST, execPath: "/b/bun", pathEnv: "/usr/local/bin" };
    expect(spec(await planScopedRun(input({ command: "jest", fs, host, changedFiles: changed("src/a.js") }))).file).toBe("/usr/local/bin/node");
  });
});

describe("QA-1.3-19: the zero-test guard covers every runner; lexical mode stays fail-closed", () => {
  const zero = (over: Partial<ScopedSpec>) => read(mkSpec(over), { [RPT_JSON]: jsonReport(0) }, 0);

  it.each<[string, Partial<ScopedSpec>, string]>([
    ["vitest lexical related over sources", { runner: "vitest", inputs: ["/root/vitest-proj/src/str.js"], lexicalPaths: true }, "vitest ran no tests and the paths were not canonicalized (no realpath seam)"],
    ["vitest related given a test file", { runner: "vitest", inputs: ["/root/vitest-proj/src/str.js", "/root/vitest-proj/test/str.test.js"] }, "vitest ran no tests although a test file was passed"],
    ["jest lexical", { runner: "jest", inputs: ["/root/vitest-proj/src/str.js"], lexicalPaths: true }, "jest ran no tests and the paths were not canonicalized (no realpath seam)"],
  ])("%s -> complete false", async (_n, over, note) => {
    expect(await zero(over)).toMatchObject({ total: 0, complete: false, note });
  });

  it("pytest scoped (inputs are tests) with 0 tests is incomplete; a spec without inputs is left alone", async () => {
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, inputs: ["/root/vitest-proj/tests/test_a.py"], inputsAreTests: true });
    expect(await read(sp, { [RPT_XML]: report("pytest-none.xml", "/root") }, 5)).toMatchObject({ complete: false, note: "pytest ran no tests although a test file was passed" });
    expect(await zero({ runner: "vitest", inputs: [], lexicalPaths: true })).toMatchObject({ total: 0, complete: true });
  });

  it("win32 lexical mode: ::$DATA spellings of a trigger or a rerun file are the file itself", async () => {
    const W = { "C:\\repo\\.git": "", "C:\\py\\pytest.exe": "", "C:\\repo\\tests\\test_a.py": "" };
    const host = { ...WIN_HOST, pathEnv: "C:\\py" };
    for (const f of ["conftest.py::$DATA", "pytest.ini::$data", "tests\\conftest.py::$DATA"]) {
      const r = await planScopedRun(input({ win: true, command: "pytest", files: W, cwd: "C:\\repo", host, changedFiles: changed(f) }));
      expectS6(r, "config-changed", `config file changed: ${f.replace(/::\$data$/i, "").replace(/\\/g, "/")}`);
    }
    const det = await detect("pytest", W, host, "C:\\repo");
    const r = spec(await planRerun(det, ["C:\\repo\\tests\\test_a.py::$DATA"], "C:\\repo", { maxWorkers: 2 }, { fs: memFs(W, true), host }));
    expect(r.inputs).toEqual(["C:\\repo\\tests\\test_a.py"]);
    const posix = await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("conftest.py::$DATA") }));
    expect(isNoAffected(posix)).toBe(true);
  });

  describe("real filesystem: vitest through a junction (win32) or symlink", () => {
    const base = mkdtempSync(path.join(tmpdir(), "omr-qa1319-"));
    afterAll(() => rmSync(base, { recursive: true, force: true }));
    const repo = path.join(base, "repo");
    for (const [rel, body] of Object.entries({
      ".git": "gitdir: elsewhere",
      "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest run" } }),
      "node_modules/vitest/package.json": VITEST_PKG,
      "node_modules/vitest/vitest.mjs": "",
      "src/str.js": "",
      "test/str.test.js": "",
    })) {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), body);
    }
    const link = path.join(base, "vlink");
    symlinkSync(repo, link, "junction");
    const lexicalFs: RunnerFs = {
      fileExists: async (p) => existsSync(p),
      readFile: async (p) => readFileSync(p, "utf8"),
      unlink: async (p) => rmSync(p, { force: true }),
    };
    const host = { ...POSIX_HOST, platform: process.platform, tmpdir: base };

    it.each(["src/str.js", "test/str.test.js"])("changed %s: a 0-test report from the lexical plan is incomplete", async (f) => {
      const plan = { command: "npm test", cwd: link, changedFiles: changed(path.join(link, f)), budget: { maxWorkers: 2 }, search: stubSearch(), host };
      const s = spec(await planScopedRun({ ...plan, fs: lexicalFs }));
      expect(s).toMatchObject({ runner: "vitest", cwd: link, lexicalPaths: true });
      writeFileSync(s.reportPath, JSON.stringify({ numTotalTests: 0, testResults: [] }));
      const r = await readResult(s, exec(0), lexicalFs, host);
      expect(r).toMatchObject({ total: 0, complete: false });
      expect(existsSync(s.reportPath)).toBe(false);
      const real = spec(await planScopedRun({ ...plan, fs: { ...lexicalFs, realpath: (p) => fsRealpath(p) } }));
      expect(real.cwd).toBe(realpathSync.native(repo));
      expect(real.lexicalPaths).toBeUndefined();
    });
  });
});

describe("QA-1.3-20: TOML spellings of addopts the parser does not read fail closed", () => {
  it.each([
    ["/r/pyproject.toml", 'tool.pytest.ini_options.addopts = "-n 3"\n'],
    ["/r/pyproject.toml", '[tool]\npytest.ini_options.addopts = "-n 3"\n'],
    ["/r/pyproject.toml", '[tool.pytest]\nini_options = { addopts = "-n 3" }\n'],
    ["/r/pyproject.toml", '[tool]\npytest = { ini_options = { addopts = "-n 3" } }\n'],
    ["/r/pyproject.toml", 'tool = { pytest = { addopts = ["-n", "3"] } }\n'],
    ["/r/pyproject.toml", '[project]\nname = "x"\n[tool . "pytest"]\n"ini_options" . addopts = "-n 3"\n'],
    ["/r/pyproject.toml", '[[tool.pytest.ini_options]]\naddopts = "-n 3"\n'],
    ["/r/pytest.toml", 'pytest.addopts = ["-n", "3"]\n'],
  ])("%s %j -> S6", async (f, text) => {
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ [f]: text })), POSIX_HOST), "unsupported-argument", `unsupported pytest argument "addopts" in ${f}`);
  });

  it("other keys, other tables and the bare form still plan", async () => {
    const text = [
      'tool.black.line-length = 100',
      '[tool.pytest.ini_options]',
      '"testpaths" = ["tests"]',
      'markers = { slow = "x" }',
      'addopts = "-n 3"',
      '[tool.other]',
      'pytest.addopts = "-n 9"',
      '"addopts" = "-n 9"',
      'ini_options = { addopts = "-n 9" }',
    ].join("\n");
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": text }))).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
  });
});

describe("QA-1.3-21: the config every pytest release line would read counts", () => {
  const det = (files: Record<string, string>, command = "pytest") => detect(command, pyRepo(files));

  it("pytest 8 skips pytest.toml, pytest 7.0 skips .pytest.ini: their pick is read too", async () => {
    expect(await det({ "/r/pytest.toml": "[pytest]\n", "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" })).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expect(await det({ "/r/.pytest.ini": "[pytest]\n", "/r/tox.ini": "[pytest]\naddopts = -n 3 --cov\n" })).toMatchObject({ xdist: true, covInConfig: true, userWorkers: { count: 3 } });
    const s = spec(await planScopedRun(input({ command: "pytest", files: pyRepo({ "/r/pytest.toml": "[pytest]\n", "/r/pytest.ini": "[pytest]\naddopts = -n 3\n", "/r/tests/test_a.py": "" }), changedFiles: changed("tests/test_a.py") })));
    expect(s.args.slice(s.args.indexOf("-n"), s.args.indexOf("-n") + 2)).toEqual(["-n", "2"]);
  });

  it("pytest 7/8 ignore the native [tool.pytest] table and keep walking; the lowest cap wins", async () => {
    expect(await det({ "/r/pyproject.toml": '[tool.pytest]\naddopts = ["-n", "1"]\n', "/r/tox.ini": "[pytest]\naddopts = -n 3\n" })).toMatchObject({ xdist: true, userWorkers: { count: 1 } });
    expect(await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-n", "auto"]\n', "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" })).toMatchObject({ userWorkers: { count: 3 } });
    const d = await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-n", "abc"]\n', "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" });
    expect(d).toMatchObject({ userWorkers: { count: 3 } });
    expect(d.notes).toContain('invalid worker cap "abc" ignored');
    expect(await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-n", "2"]\n', "/r/pytest.ini": "[pytest]\naddopts = -n abc\n" })).toMatchObject({ userWorkers: { count: 2 } });
  });

  it("-p no:xdist in one line's config does not disable the -n another line reads", async () => {
    expect(await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-p", "no:xdist"]\n', "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" })).toMatchObject({ xdist: true });
    expect(await det({ "/r/pytest.ini": "[pytest]\naddopts = -n 3 -p no:xdist\n" })).toMatchObject({ xdist: false });
    expect(await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-p", "no:xdist", "-n", "3"]\n' })).toMatchObject({ xdist: true });
    expect(await det({ "/r/pytest.ini": "[pytest]\naddopts = -p no:xdist\n" }, "pytest -n 3")).toMatchObject({ xdist: false });
  });

  it("a file only an older line reads can still be S6; -c toml is read both ways", async () => {
    const bad = '[tool.pytest]\naddopts = ["-q"]\n[tool.pytest.ini_options]\naddopts = -n 3\n';
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ "/r/pyproject.toml": bad })), POSIX_HOST), "unsupported-argument", 'unsupported pytest argument "addopts" in /r/pyproject.toml');
    expect(await det({ "/r/cfg/x.toml": '[tool.pytest.ini_options]\naddopts = "-n 3"\n' }, "pytest -c cfg/x.toml")).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expectS6(await detectRunner("pytest -c cfg/x.toml", "/r", memFs(pyRepo({ "/r/cfg/x.toml": '[tool.pytest]\nini_options.addopts = "-n 3"\n' })), POSIX_HOST), "unsupported-argument");
  });
});

describe("QA-1.3-22: classname=\"\" alone is a real test, not a collection error", () => {
  const pspec = () => mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root", inputs: ["/root/p/tests/test_w.py"], inputsAreTests: true });
  const xml = (cases: string) => `<?xml version="1.0"?><testsuites><testsuite>${cases}</testsuite></testsuites>`;

  it("pytest -c elsewhere: a green run outside the rootdir stays green", async () => {
    const r = await read(pspec(), { [RPT_XML]: xml('<testcase classname="" name="test_workers" time="0.01"/>') }, 0);
    expect(r).toMatchObject({ failingIds: [], total: 1, collectionError: false, complete: true });
  });

  it("a failing test with classname=\"\" is unmapped, so never a pass", async () => {
    const r = await read(pspec(), { [RPT_XML]: xml('<testcase classname="" name="test_workers"><failure message="x"/></testcase>') }, 1);
    expect(r).toMatchObject({ failingIds: ["::test_workers"], collectionError: false, complete: false, note: 'pytest classname not mapped to a test file: "" (test_workers)' });
  });

  it("the collection-failure <error> is still a collection error, with or without a classname", async () => {
    const r = await read(pspec(), { [RPT_XML]: xml('<testcase classname="" name="p.tests.test_w"><error message="collection failure">E</error></testcase>') }, 2);
    expect(r).toMatchObject({ failingIds: ["tests/test_w.py"], collectionError: true, total: 0 });
  });
});

describe("QA-1.3-25: junit parsing is linear", () => {
  it("700 inputs x 20000 failing testcases parse in well under a second", async () => {
    const inputs = Array.from({ length: 700 }, (_, i) => `/root/p/tests/pkg${i}/sub${i % 7}/test_m${i}.py`);
    const cases: string[] = [];
    for (let j = 0; j < 20000; j++) {
      const k = j % 700;
      cases.push(`<testcase classname="p.tests.pkg${k}.sub${k % 7}.test_m${k}.TestC" name="test_${j}" time="0.001"><failure message="boom">x</failure></testcase>`);
    }
    const text = `<?xml version="1.0"?><testsuites><testsuite>${cases.join("")}</testsuite></testsuites>`;
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root", inputs, inputsAreTests: true });
    const t0 = performance.now();
    const r = await read(sp, { [RPT_XML]: text }, 1);
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ total: 20000, complete: true, source: "report" });
    expect(r.failingIds).toHaveLength(20000);
    expect(r.failingIds).toContain("tests/pkg399/sub0/test_m399.py::TestC::test_19999");
    expect(r.failingIds).toContain("tests/pkg699/sub6/test_m699.py::TestC::test_19599");
    expect(ms).toBeLessThan(1000);
  });

  it("the first input wins a shared suffix; the longest suffix wins", async () => {
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root", gitRoot: "/root", inputs: ["/root/a/test_x.py", "/root/b/test_x.py", "/root/c/a/test_x.py"], inputsAreTests: true });
    const xml = '<testsuites><testcase classname="test_x" name="t"><failure/></testcase><testcase classname="c.a.test_x.K" name="u"><failure/></testcase></testsuites>';
    expect((await read(sp, { [RPT_XML]: xml }, 1)).failingIds).toEqual(["a/test_x.py::t", "c/a/test_x.py::K::u"]);
  });

  it.each([
    ["8000 unclosed testcases", `<testsuites>${'<testcase classname="a" name="b">'.repeat(8000)}</testsuites>`],
    ["an unclosed testcase before a closed one", '<testsuites><testcase classname="a" name="b"><testcase classname="a" name="c"><failure/></testcase></testsuites>'],
    ["a start tag cut short", "<testsuites></testsuites><testcase classname="],
  ])("malformed: %s -> text fallback, fast", async (_n, xml) => {
    const t0 = performance.now();
    const r = await read(mkSpec({ runner: "pytest", reportPath: RPT_XML, inputs: ["/root/vitest-proj/tests/test_a.py"] }), { [RPT_XML]: xml }, 1);
    expect(r).toMatchObject({ source: "text", complete: false });
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("<testcases> and a bare <testcase> at the end are not cases", async () => {
    const xml = '<testsuites><testcases/><testcase classname="tests.test_math" name="ok"/></testsuites><testcase';
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root/p", inputs: ["/root/p/tests/test_math.py"], inputsAreTests: true });
    expect(await read(sp, { [RPT_XML]: xml }, 0)).toMatchObject({ total: 1, complete: true, source: "report" });
  });
});

describe("QA-1.3-23: Python dependency files are pytest triggers", () => {
  it.each(["requirements/base.txt", "requirements/dev.in", "deps/requirements/ci.txt", "requirements-dev.in", "constraints.txt", "constraints-py312.txt", "Pipfile", "setup.py", "src/setup.py"])(
    "%s -> config-changed",
    async (f) => {
      expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/test_a.py", f) })), "config-changed", `config file changed: ${f}`);
    },
  );

  it("win32 matches the directory and the extension case-insensitively; other files are not triggers", async () => {
    const W = { "C:\\repo\\.git": "", "C:\\py\\pytest.exe": "" };
    const r = await planScopedRun(input({ win: true, command: "pytest", files: W, cwd: "C:\\repo", host: { ...WIN_HOST, pathEnv: "C:\\py" }, changedFiles: changed("Requirements\\Base.TXT") }));
    expectS6(r, "config-changed", "config file changed: Requirements/Base.TXT");
    for (const f of ["requirements/README.md", "docs/notes.txt", "requirements.md"]) {
      expect(isNoAffected(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed(f) })))).toBe(true);
    }
    expect(isNoAffected(await planScopedRun(input({ changedFiles: changed("requirements/base.txt") })))).toBe(true);
  });
});

describe("QA-1.3-24: npm workspace configuration outside the command line is S6", () => {
  const files = (extra: Record<string, string>) => jsRepo({ test: "vitest" }, { "/r/src/a.ts": "", "/r/pkg/package.json": JSON.stringify({ scripts: { test: "vitest" } }), ...extra });
  const plan = (extra: Record<string, string>, over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command: "npm test", files: files(extra), changedFiles: changed("src/a.ts"), ...over }));

  it.each([
    ["workspace=packages/app", "npm workspace"],
    ["workspaces = true", "npm workspaces"],
    ["; c\nworkspace[] = a", "npm workspace"],
    ["  Workspace=x", "npm workspace"],
  ])(".npmrc %j -> S6 %s", async (npmrc, prefix) => {
    expectS6(await plan({ "/r/.npmrc": npmrc }), "unsupported-command", `unsupported command "${prefix}" in /r/.npmrc`);
  });

  it("the .npmrc of any directory from cwd up to the git root counts; unreadable -> S6", async () => {
    expectS6(await plan({ "/r/pkg/.npmrc": "workspace=x" }, { cwd: "/r/pkg" }), "unsupported-command", 'unsupported command "npm workspace" in /r/pkg/.npmrc');
    const fs = memFs(files({ "/r/.npmrc": "x" }), false, {}, ["/r/.npmrc"]);
    expectS6(await plan({}, { fs }), "unsupported-command", 'unsupported command "npm" in /r/.npmrc (unreadable)');
  });

  it("npm_config_workspace(s) in the host env (any case) or cross-env -> S6", async () => {
    const host = (env: Record<string, string>) => ({ ...POSIX_HOST, pathEnv: "/usr/bin", env });
    expectS6(await plan({}, { host: host({ NPM_CONFIG_WORKSPACE: "packages/app" }) }), "unsupported-command", 'unsupported command "npm NPM_CONFIG_WORKSPACE" in the environment');
    expectS6(await plan({}, { host: host({ npm_config_workspaces: "true" }) }), "unsupported-command", 'unsupported command "npm npm_config_workspaces" in the environment');
    expectS6(await plan({}, { command: "cross-env npm_config_workspace=a npm test" }), "unsupported-command", 'unsupported command "npm npm_config_workspace" in cross-env');
    expect(isScopedSpec(await plan({}, { host: host({ npm_config_workspace: "", npm_config_prefix: "/opt/npm" }) }))).toBe(true);
  });

  it("prefix, comments, include-workspace-root alone and other managers still plan", async () => {
    for (const npmrc of ["prefix=packages/app", "# workspace=x", "include-workspace-root=true", "workspaces-update=false"]) {
      expect(isScopedSpec(await plan({ "/r/.npmrc": npmrc })), npmrc).toBe(true);
    }
    expect(isScopedSpec(await plan({ "/r/.npmrc": "workspace=x" }, { command: "pnpm test" }))).toBe(true);
    expect(isScopedSpec(await plan({ "/r/.npmrc": "workspace=x" }, { command: "vitest" }))).toBe(true);
  });
});

describe("QA-1.3-28: the setup-file trigger follows 1.6's rule", () => {
  it("setup.ts and SetupWizard.tsx outside a test directory are application inputs", async () => {
    const files = jsRepo({}, { "/r/src/setup.ts": "", "/r/src/SetupWizard.tsx": "", "/r/src/setupEnvironment.ts": "" });
    for (const command of ["vitest", "jest"]) {
      const s = spec(await planScopedRun(input({ command, files, changedFiles: changed("src/setup.ts", "src/SetupWizard.tsx", "src/setupEnvironment.ts") })));
      expect(s.inputs).toEqual(["/r/src/SetupWizard.tsx", "/r/src/setup.ts", "/r/src/setupEnvironment.ts"]);
    }
  });

  it("win32 matches case-insensitively", async () => {
    const W = { "C:\\repo\\.git": "" };
    expectS6(await planScopedRun(input({ win: true, files: W, cwd: "C:\\repo", changedFiles: changed("SetupTests.TS") })), "config-changed", "config file changed: SetupTests.TS");
  });
});

describe("QA-1.3-26: process-backed searches are bounded", () => {
  const st = (over: Parameters<typeof input>[0]) => {
    const { search: _s, ...rest } = input(over);
    return planStaticScoping(rest);
  };
  const why = (n: number) => `too many changed modules to map: ${n} test searches (limit ${SEARCH_LIMIT})`;

  it("more than SEARCH_LIMIT deleted sources -> S6 before any search, in both planners", async () => {
    const gone = Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => `src/gone${i}.ts`);
    const search = stubSearch();
    expectS6(await planScopedRun(input({ changedFiles: changed(...gone), search })), "too-many-searches", why(SEARCH_LIMIT + 1));
    expect(search.findByContent).not.toHaveBeenCalled();
    expectS6(await st({ changedFiles: changed(...gone) }), "too-many-searches", why(SEARCH_LIMIT + 1));
  });

  it("pytest modules count too; exactly SEARCH_LIMIT still plans", async () => {
    const mods = Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => `src/m${i}.py`);
    const files = pyRepo(Object.fromEntries(mods.map((m) => [`/r/${m}`, ""])));
    const search = stubSearch();
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed(...mods), search })), "too-many-searches", why(SEARCH_LIMIT + 1));
    expect(search.findByName).not.toHaveBeenCalled();
    const ok = await planScopedRun(input({ command: "pytest", files, changedFiles: changed(...mods.slice(1)), search }));
    expect(ok).toEqual({ noAffected: true, note: "no affected tests: no test files map to the changed modules" });
    expect(search.findByName).toHaveBeenCalledTimes(SEARCH_LIMIT);
    expect(await st({ command: "pytest", files, changedFiles: changed(...mods.slice(1)) })).toMatchObject({ scopable: true, pendingSearches: SEARCH_LIMIT });
  });
});

describe("QA-1.3-27: planStaticScoping runs the spec-time pytest config lookup", () => {
  const st = (over: Parameters<typeof input>[0]) => {
    const { search: _s, ...rest } = input(over);
    return planStaticScoping(rest);
  };

  it("tests/unit/pytest.ini with a positional addopts: S6 from both planners", async () => {
    const files = pyRepo({ "/r/tests/unit/pytest.ini": "[pytest]\naddopts = tests\n", "/r/tests/unit/test_x.py": "" });
    const reason = 'unsupported pytest argument "tests" in addopts of /r/tests/unit/pytest.ini';
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("tests/unit/test_x.py") })), "unsupported-argument", reason);
    expectS6(await st({ command: "pytest", files, changedFiles: changed("tests/unit/test_x.py") }), "unsupported-argument", reason);
  });

  it("static notes carry the lookup's notes; with only pending searches there is nothing to look up", async () => {
    const files = pyRepo({ "/r/tests/test_x.py": "", "/r/src/m.py": "", "/r/tests/tox.ini": "x" });
    const fs = memFs(files, false, {}, ["/r/tests/tox.ini"]);
    expect(await st({ command: "pytest", fs, changedFiles: changed("tests/test_x.py") })).toMatchObject({
      scopable: true,
      pendingSearches: 0,
      notes: ["unreadable pytest config ignored: /r/tests/tox.ini"],
    });
    expect(await st({ command: "pytest", fs, changedFiles: changed("src/m.py") })).toEqual({ scopable: true, runner: "pytest", pendingSearches: 1, notes: [] });
    expect(await st({ files: jsRepo({}, { "/r/src/a.ts": "" }), changedFiles: changed("src/a.ts") })).toEqual({ scopable: true, runner: "vitest", pendingSearches: 0, notes: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// QA round 3 (docs/qa/verification-resource-budget/phase-1.3.md, QA-1.3-29..37)
// ---------------------------------------------------------------------------------------------

/** The "-n <N>" the adapter appended, or [] when it appended none. */
function xdistArgs(s: ScopedSpec): string[] {
  const i = s.args.indexOf("-n");
  return i < 0 ? [] : s.args.slice(i, i + 2);
}

describe("QA-1.3-31: iniconfig's key:value and decoded TOML keys reach the worker cap", () => {
  const planPy = (files: Record<string, string>, command = "pytest") =>
    planScopedRun(input({ command, files: pyRepo({ "/r/tests/test_a.py": "", ...files }), changedFiles: changed("tests/test_a.py") }));

  it.each([
    ["/r/pytest.ini", "[pytest]\naddopts:-n 3\n"],
    ["/r/tox.ini", "[pytest]\naddopts:-n 3\n"],
    ["/r/setup.cfg", "[tool:pytest]\naddopts:-n 3\n"],
    ["/r/pytest.ini", "[pytest]\naddopts: -o x=y -n 3\n"],
    ["/r/pytest.ini", "[pytest]\naddopts =-n 3\n"],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\n"add\\u006fpts" = "-n 3"\n'],
    ["/r/pyproject.toml", '[tool."py\\u0074est".ini_options]\naddopts = "-n 3"\n'],
    ["/r/pytest.toml", '[pytest]\n"add\\u006fpts" = ["-n", "3"]\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\n"addopts" = "-n 3"\n'],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\n'addopts' = '-n 3'\n"],
    ["/r/pyproject.toml", '[ tool . "pytest" . ini_options ]\naddopts = "-n 3"\n'],
  ])("%s %j: the cap lands", async (f, text) => {
    expect(await detect("pytest", pyRepo({ [f]: text }))).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expect(xdistArgs(spec(await planPy({ [f]: text })))).toEqual(["-n", "2"]);
  });

  it.each([
    ['[tool.pytest.ini_options]\n"add\\qopts" = "-n 3"\n', 'unsupported pytest argument ""add\\qopts"" in /r/pyproject.toml'],
    ['[tool."py\\qtest".ini_options]\naddopts = "-n 3"\n', 'unsupported pytest argument "tool."py\\qtest".ini_options" in /r/pyproject.toml'],
    ['tool.pytest.ini_options."add\\u006fpts" = "-n 3"\n', 'unsupported pytest argument "addopts" in /r/pyproject.toml'],
    ['[tool.pytest.ini_options]\naddopts = "-n 1"\naddopts = "-n 3"\n', 'unsupported pytest argument "addopts" in /r/pyproject.toml'],
    ['[tool.pytest.ini_options]\naddopts = "-n 1"\n[tool.pytest]\naddopts = ["-n", "3"]\n', 'unsupported pytest argument "addopts" in /r/pyproject.toml'],
  ])("undecodable, dotted or repeated: %j -> S6", async (text, reason) => {
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ "/r/pyproject.toml": text })), POSIX_HOST), "unsupported-argument", reason);
  });

  it("values are skipped whole: a header or key inside a string, array or inline table is not one", async () => {
    const text = [
      "[tool.pytest.ini_options]",
      'description = """',
      '[[ -n "$X" ]]',
      "[tool.other]",
      'addopts = "-n 9"',
      '"""',
      "markers = [",
      '  "a: [x] # not a comment",',
      "  # ] a comment",
      '  ["nested"],',
      "]",
      'x = { a = "}", b = [1, 2] }',
      "y = '''",
      "addopts = 'lit'",
      "'''",
      'z = """q""""',
      'w = "a\\"b"',
      'addopts = "-n 3"',
    ].join("\n");
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": text }))).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
  });

  it("broken values and headers: the rest of the line or file is skipped, never read as pytest's", async () => {
    // A header that is not a key path belongs to no table: its keys are ignored.
    const odd = '[x y]\naddopts = "-n 9"\n[tool.pytest.ini_options]\naddopts = "-n 3"\n';
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": odd }))).toMatchObject({ userWorkers: { count: 3 } });
    const unterminated = '[tool.pytest.ini_options]\nx = "abc\naddopts = "-n 3"\ny = """never\n';
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": unterminated }))).toMatchObject({ userWorkers: { count: 3 } });
    const openArray = '[tool.pytest.ini_options]\naddopts = "-n 3"\nx = [ "a", { b = \'c\' }\n[tool.pytest.ini_options.more]\n';
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": openArray }))).toMatchObject({ userWorkers: { count: 3 } });
    const openInArray = '[tool.pytest.ini_options]\nx = [ "a\naddopts = "-n 3"\n';
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": openInArray }))).toMatchObject({ userWorkers: { count: 3 } });
  });

  it("a dotted key defines the pytest table, so the file stops the search; an array table does not", async () => {
    const files = { "/r/sub/pyproject.toml": "tool.pytest.ini_options.markers = []\n", "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" };
    const d = await detect("pytest", pyRepo(files), POSIX_HOST, "/r/sub");
    expect(d.xdist).toBe(false);
    const arr = { "/r/sub/pyproject.toml": "[[tool.pytest.ini_options]]\nmarkers = []\n", "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" };
    expect(await detect("pytest", pyRepo(arr), POSIX_HOST, "/r/sub")).toMatchObject({ xdist: true });
  });
});

describe("QA-1.3-33: pytest's python_files decides which changed files are tests", () => {
  const DJANGO = "[pytest]\npython_files = tests.py test_*.py *_tests.py\n";
  const planPy = (files: Record<string, string>, paths: string[], over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed(...paths), ...over }));

  it("pytest-django: tests.py and *_tests.py are test files, not modules", async () => {
    const files = { "/r/pytest.ini": DJANGO, "/r/pkg/tests.py": "", "/r/pkg/str_tests.py": "" };
    const s = spec(await planPy(files, ["pkg/tests.py", "pkg/str_tests.py"]));
    expect(s.inputs).toEqual(["/r/pkg/str_tests.py", "/r/pkg/tests.py"]);
    // Without the setting they are modules, and no test is named after them.
    const plain = await planPy({ "/r/pkg/tests.py": "" }, ["pkg/tests.py"]);
    expect(plain).toEqual({ noAffected: true, note: "no affected tests: no test files map to the changed modules" });
  });

  it("modules are looked up by the names python_files gives them; a literal name gives none", async () => {
    const search = stubSearch({}, { "test_models.py": ["/r/pkg/test_models.py"] });
    const files = { "/r/pytest.ini": DJANGO, "/r/pkg/models.py": "", "/r/pkg/test_models.py": "" };
    expect(spec(await planPy(files, ["pkg/models.py"], { search })).inputs).toEqual(["/r/pkg/test_models.py"]);
    expect(search.findByName).toHaveBeenCalledWith("/r", ["test_models.py", "models_tests.py"]);
    const only = { "/r/pytest.ini": "[pytest]\npython_files = tests.py\n", "/r/pkg/models.py": "" };
    const none = stubSearch();
    expect(isNoAffected(await planPy(only, ["pkg/models.py"], { search: none }))).toBe(true);
    expect(none.findByName).not.toHaveBeenCalled();
  });

  it("TOML arrays and strings, the -o override on the command line, in addopts and in PYTEST_ADDOPTS", async () => {
    const cases: [Record<string, string>, string, Partial<PlanScopedRunInput>][] = [
      [{ "/r/pyproject.toml": '[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n' }, "pytest", {}],
      [{ "/r/pyproject.toml": '[tool.pytest.ini_options]\npython_files = "check_*.py other.py"\n' }, "pytest", {}],
      [{ "/r/pytest.toml": '[pytest]\npython_files = ["check_*.py"]\n' }, "pytest", {}],
      [{}, "pytest -o python_files=check_*.py", {}],
      [{}, 'pytest -o "python_files=a.py check_*.py"', {}],
      [{ "/r/pytest.ini": "[pytest]\naddopts = -o python_files=check_*.py\n" }, "pytest", {}],
      [{}, "pytest", { host: { ...POSIX_HOST, pathEnv: "/usr/bin", pytestAddopts: "--override-ini=python_files=check_*.py" } }],
    ];
    for (const [files, command, over] of cases) {
      const s = spec(await planPy({ ...files, "/r/src/check_x.py": "" }, ["src/check_x.py"], { command, ...over }));
      expect(s.inputs, command).toEqual(["/r/src/check_x.py"]);
    }
  });

  it("an unreadable python_files is S6 unless the command line overrides it", async () => {
    const bad: [string, string][] = [
      ["/r/pyproject.toml", "[tool.pytest.ini_options]\npython_files = 3\n"],
      ["/r/pytest.ini", "[pytest]\npython_files = 'open\n"],
      ["/r/pyproject.toml", 'tool.pytest.ini_options.python_files = ["x.py"]\n'],
    ];
    for (const [f, text] of bad) {
      expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ [f]: text })), POSIX_HOST), "unsupported-argument", `unsupported pytest argument "python_files" in ${f}`);
      expect(await detect("pytest -o python_files=t.py", pyRepo({ [f]: text }))).toMatchObject({ pythonFiles: expect.arrayContaining(["t.py"]) });
    }
    expectS6(await detectRunner("pytest -o \"python_files='x\"", "/r", memFs(pyRepo()), POSIX_HOST), "unsupported-argument", 'unsupported pytest argument "python_files" in command');
    const inAddopts = pyRepo({ "/r/pytest.ini": "[pytest]\naddopts = -o \"python_files='x\"\n" });
    expectS6(await detectRunner("pytest", "/r", memFs(inAddopts), POSIX_HOST), "unsupported-argument", 'unsupported pytest argument "python_files" in addopts of /r/pytest.ini');
  });

  it("a -o addopts override still reads python_files from the config, and ignores its odd addopts", async () => {
    const text = '[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n"addopts" = 3\n';
    const d = await detect('pytest -o "addopts=-q"', pyRepo({ "/r/pyproject.toml": text }));
    expect(d.pythonFiles).toEqual(["check_*.py"]);
  });

  it("the union: a release line without a config, or a config without the key, keeps the defaults", async () => {
    expect((await detect("pytest", pyRepo())).pythonFiles).toEqual([...DEFAULT_PYTHON_FILES]);
    const toml = await detect("pytest", pyRepo({ "/r/pytest.toml": '[pytest]\npython_files = ["tests.py"]\n' }));
    expect(toml.pythonFiles).toEqual([...DEFAULT_PYTHON_FILES, "tests.py"]);
    const both = await detect("pytest", pyRepo({ "/r/pytest.toml": '[pytest]\npython_files = ["tests.py"]\n', "/r/pytest.ini": "[pytest]\npython_files = tests.py\n" }));
    expect(both.pythonFiles).toEqual(["tests.py"]);
  });

  it("with a path argument the config above it counts as well", async () => {
    const files = { "/r/tests/pytest.ini": "[pytest]\npython_files = check_*.py\n", "/r/tests/check_a.py": "" };
    expect(spec(await planPy(files, ["tests/check_a.py"], { command: "pytest tests" })).inputs).toEqual(["/r/tests/check_a.py"]);
    expect(isNoAffected(await planPy(files, ["tests/check_a.py"]))).toBe(true);
  });

  it("path patterns match the whole path; content hits are re-checked; globs follow the patterns", async () => {
    const files = { "/r/pytest.ini": "[pytest]\npython_files = tests/*.py check_*.py\n", "/r/tests/sub/helper.py": "", "/r/lib/gone_dep.py": "" };
    expect(spec(await planPy(files, ["tests/sub/helper.py"])).inputs).toEqual(["/r/tests/sub/helper.py"]);
    const search = stubSearch({ gone: ["/r/tests/sub/helper.py", "/r/lib/gone_dep.py"] });
    const s = spec(await planPy(files, ["src/gone.py"], { search }));
    expect(s.inputs).toEqual(["/r/tests/sub/helper.py"]);
    expect(search.findByContent).toHaveBeenCalledWith("/r", "gone", [":(glob)**/*.py", ":(glob)**/check_*.py"]);
    expect(search.findByName).toHaveBeenCalledWith("/r", ["check_gone.py"]);
  });

  it("fnmatch: ?, sets, negated sets, ranges, unclosed brackets and repeated stars", async () => {
    const patterns = "t?st_[a-c]*.py [!x]x_*.py foo[.py **_spec.py []a]*.py r[a-].py";
    const files: Record<string, string> = { "/r/pytest.ini": `[pytest]\npython_files = ${patterns}\n` };
    const tests = ["tast_b1.py", "yx_1.py", "foo[.py", "a_b_spec.py", "]z.py", "r-.py"];
    const modules = ["tast_d1.py", "xx_1.py", "foo.py", "spec.py", "bz.py", "rb.py"];
    for (const f of [...tests, ...modules]) files[`/r/p/${f}`] = "";
    const s = spec(await planPy(files, [...tests, ...modules].map((f) => `p/${f}`)));
    expect(s.inputs.map((p) => path.posix.basename(p)).sort()).toEqual([...tests].sort());
  });

  it("win32 matches python_files case-insensitively, with either separator", async () => {
    const W = { "C:\\repo\\.git": "", "C:\\py\\pytest.exe": "", "C:\\repo\\pytest.ini": "[pytest]\npython_files = TESTS.py Unit/*.py\n", "C:\\repo\\pkg\\tests.py": "", "C:\\repo\\unit\\a.py": "" };
    const r = spec(await planScopedRun(input({ win: true, command: "pytest", files: W, cwd: "C:\\repo", host: { ...WIN_HOST, pathEnv: "C:\\py" }, changedFiles: changed("pkg\\tests.py", "unit\\a.py") })));
    expect(r.inputs).toEqual(["C:\\repo\\pkg\\tests.py", "C:\\repo\\unit\\a.py"]);
  });
});

describe("QA-1.3-34: config files are size-capped and read once per plan", () => {
  const big = "#".repeat(CONFIG_SIZE_LIMIT + 1);

  it("a pytest config over the limit is S6 config-too-large, even one pytest would skip", async () => {
    for (const f of ["/r/pyproject.toml", "/pyproject.toml", "/r/tox.ini"]) {
      expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ [f]: big })), POSIX_HOST), "config-too-large", `config file too large to read: ${f} (limit ${CONFIG_SIZE_LIMIT} bytes)`);
    }
    expectS6(await detectRunner("pytest -c cfg/x.ini", "/r", memFs(pyRepo({ "/r/cfg/x.ini": big })), POSIX_HOST), "config-too-large");
  });

  it("with fs.stat the size is checked before the read, and a directory is unreadable", async () => {
    const base = memFs(pyRepo({ "/r/pyproject.toml": "small", "/r/tox.ini": "[pytest]\n" }));
    const reads: string[] = [];
    const fs: PlannerFs = {
      ...base,
      readFile: async (p) => {
        reads.push(p);
        return base.readFile(p);
      },
      stat: async (p) => ({ isFile: !p.endsWith("tox.ini"), size: p.endsWith(".toml") ? BigInt(CONFIG_SIZE_LIMIT + 1) : 10, dev: 1, ino: 1 }),
    };
    expectS6(await detectRunner("pytest", "/r", fs, POSIX_HOST), "config-too-large");
    expect(reads).not.toContain("/r/pyproject.toml");
    const dirFs: PlannerFs = { ...fs, stat: async (p) => ({ isFile: !p.endsWith("tox.ini"), size: 10, dev: 1, ino: 1 }) };
    const d = await detectRunner("pytest", "/r", { ...dirFs, fileExists: async (p) => p !== "/r/pyproject.toml" && (await base.fileExists(p)) }, POSIX_HOST);
    expect((d as DetectedRunner).notes).toContain("unreadable pytest config ignored: /r/tox.ini");
  });

  it("each config file is read once per plan, across detection, the spec-time lookup and the release lines", async () => {
    const files = pyRepo({ "/r/pyproject.toml": '[tool.pytest.ini_options]\naddopts = "-n 3"\n', "/r/tests/test_a.py": "" });
    const base = memFs(files);
    const reads: string[] = [];
    const fs: FsSeam = { ...base, readFile: async (p) => (reads.push(p), base.readFile(p)) };
    spec(await planScopedRun(input({ command: "pytest tests", fs, changedFiles: changed("tests/test_a.py") })));
    expect(reads.filter((p) => p === "/r/pyproject.toml")).toHaveLength(1);
  });

  it("a config just under the limit, in the worst line shape, parses quickly", async () => {
    const text = `[tool.pytest.ini_options]\n${"a=1\n".repeat(Math.floor((CONFIG_SIZE_LIMIT - 40) / 4))}`;
    const t0 = performance.now();
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": text }))).toMatchObject({ xdist: false });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
describe("QA-1.3-29: setup files are triggers under a superset of 1.6's rule", () => {
  const planJs = (command: string, extra: Record<string, string>, paths: string[]) =>
    planScopedRun(input({ command, files: jsRepo({}, extra), changedFiles: changed(...paths) }));
  // risk.ts (vrb/p16) SETUP_FILE, every alternative: the runner rule must contain it.
  const RISK = ["a.setup.tsx", "setupTests.ts", "setup-tests.js", "test-setup.ts", "global-setup.ts", "globalSetup.mts", "vitest.setup.ts", "jest.setup.cjs", "setup-jest.js", "jest-setup.js", "vitest-setup.ts", "global-teardown.js"];
  const MORE = ["test/setup.js", "tests/setup.ts", "src/test/setup.tsx", "spec/teardown.mjs", "jest/setup.cjs", "__setup__/../testing/setup.js", "jest.setupAfterEnv.js", "jestSetup.ts", "testSetup.ts", "tests.setup.ts", "setupVitest.ts", "setupJest.js", "setupEnv.js", "setupAfterEnv.ts", "setupFilesAfterEnv.ts", "globalTeardown.ts", "global.setup.e2e.ts"];

  it.each([...RISK, ...MORE])("%s -> config-changed under vitest and jest", async (f) => {
    for (const command of ["vitest", "jest"]) {
      const r = await planJs(command, {}, [f]);
      expect(isUnverifiable(r) && r.code === "config-changed", `${command} ${f}: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it("test files stay inputs even with a setup-like name; pytest is unaffected", async () => {
    const extra = { "/r/test/jest-setup.test.js": "", "/r/__tests__/setup.js": "" };
    expect(spec(await planJs("jest", extra, ["test/jest-setup.test.js", "__tests__/setup.js"])).inputs).toEqual(["/r/__tests__/setup.js", "/r/test/jest-setup.test.js"]);
    expect(isNoAffected(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("test/setup.js") })))).toBe(true);
  });

  it("files a jest config names statically are triggers, whatever their name", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ "/r/jest.config.js": "module.exports = { setupFilesAfterEnv: ['<rootDir>/src/testing/bootstrap.ts'] };" }, "src/testing/bootstrap.ts"],
      [{ "/r/package.json": JSON.stringify({ name: "app", jest: { setupFiles: ["./tools/env.js"] } }) }, "tools/env.js"],
      [{ "/r/jest.config.json": JSON.stringify({ rootDir: "src", globalSetup: "<rootDir>/boot.js" }) }, "src/boot.js"],
      [{ "/r/jest.config.ts": "export default { globalTeardown: '<rootDir>/tools/polyfills' }" }, "tools/polyfills.ts"],
      [{ "/r/jest.config.ts": "export default { setupFiles: ['./tools/shim'] }" }, "tools/shim/index.js"],
      [{ "/r/jest.config.js": "module.exports = { setupFiles: [/* c */ ...base, require.resolve(\"./a/b.js\"), // it's\n 'c/d.js', `e/f.js`] }" }, "c/d.js"],
      [{ "/r/jest.config.js": "module.exports = { setupFiles: [/* c */ ...base, require.resolve(\"./a/b.js\")] }" }, "a/b.js"],
      [{ "/r/jest.config.js": "module.exports = { \"setupFiles\": [path.join(__dirname, 'x/y.js')] }" }, "x/y.js"],
    ];
    for (const [extra, f] of cases) {
      const r = await planJs("jest", { ...extra, [`/r/${f}`]: "" }, [f]);
      expect(r, `${f}: ${JSON.stringify(extra)}`).toEqual({ unverifiable: true, code: "config-changed", reason: `config file changed: ${f}` });
    }
  });

  it("vitest configs and the --config file count; parent configs add triggers too", async () => {
    const vcfg = "export default defineConfig({ test: { setupFiles: ['./src/vitest-boot.ts'], globalSetup: \"./scripts/gs.ts\" } })";
    for (const f of ["src/vitest-boot.ts", "scripts/gs.ts"]) {
      expectS6(await planJs("vitest", { "/r/vitest.config.ts": vcfg }, [f]), "config-changed", `config file changed: ${f}`);
    }
    expectS6(await planJs("vitest run --config cfg/unit.mjs", { "/r/cfg/unit.mjs": "export default { test: { setupFiles: 'boot.js' } }" }, ["cfg/boot.js"]), "config-changed");
    const mono = { "/r/pkg/package.json": JSON.stringify({ name: "p", scripts: { test: "jest" } }), "/r/jest.config.js": "module.exports = { setupFiles: ['<rootDir>/shared/boot.js'] }" };
    expectS6(await planScopedRun(input({ command: "npm test", cwd: "/r/pkg", files: jsRepo({}, mono), changedFiles: changed("/r/shared/boot.js") })), "config-changed");
  });

  it("globs, templates with ${}, empty values and non-literal values name nothing", async () => {
    const cfg = "module.exports = { setupFiles: ['src/*.js', `${root}/a.js`, '', \"unterminated\n], globalSetup: makePath(), rootDir: dirs }";
    const s = spec(await planJs("jest", { "/r/jest.config.js": cfg, "/r/src/a.js": "" }, ["src/a.js"]));
    expect(s.inputs).toEqual(["/r/src/a.js"]);
  });

  it("an oversized runner config is S6; an unreadable one is skipped", async () => {
    const big = "x".repeat(CONFIG_SIZE_LIMIT + 1);
    expectS6(await planJs("jest", { "/r/jest.config.js": big, "/r/src/a.js": "" }, ["src/a.js"]), "config-too-large", `config file too large to read: /r/jest.config.js (limit ${CONFIG_SIZE_LIMIT} bytes)`);
    const fs = memFs(jsRepo({}, { "/r/jest.config.js": "x", "/r/src/a.js": "" }), false, {}, ["/r/jest.config.js"]);
    expect(spec(await planScopedRun(input({ command: "jest", fs, changedFiles: changed("src/a.js") }))).inputs).toEqual(["/r/src/a.js"]);
  });

  it("win32: names match case-insensitively, references by key", async () => {
    const W = { ...Object.fromEntries(Object.entries(jsRepo()).map(([k, v]) => [k.replace(/^\/r/, "C:\\repo").replace(/\//g, "\\"), v])), "C:\\repo\\jest.config.js": "module.exports = { setupFiles: ['<rootDir>/Tools/Env.js'] }" };
    const host = WIN_HOST;
    for (const f of ["JEST-SETUP.JS", "Test\\Setup.js", "tools\\env.js"]) {
      expectS6(await planScopedRun(input({ win: true, command: "jest", files: W, cwd: "C:\\repo", host, changedFiles: changed(f) })), "config-changed");
    }
  });
});

describe("QA-1.3-37: a Playwright spec the runner's config excludes is not an input", () => {
  const PW = { "/r/playwright.config.ts": "export default defineConfig({ testDir: './e2e' })" };
  const VCFG = "export default mergeConfig(viteConfig, defineConfig({ test: { environment: 'jsdom', exclude: [...configDefaults.exclude, 'e2e/**'] } }))";
  const plan = (command: string, extra: Record<string, string>, paths: string[]) =>
    planScopedRun(input({ command, files: jsRepo({}, { "/r/e2e/login.spec.ts": "", "/r/src/a.ts": "", ...extra }), changedFiles: changed(...paths) }));
  const NOTE = (kind: string) => `playwright test file excluded by the ${kind} config, not run: e2e/login.spec.ts`;

  it("create-vue shape: an e2e-only change is NoAffected with a note; with a source it runs the source only", async () => {
    const extra = { ...PW, "/r/vitest.config.ts": VCFG };
    expect(await plan("vitest", extra, ["e2e/login.spec.ts"])).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
    const s = spec(await plan("vitest", extra, ["e2e/login.spec.ts", "src/a.ts"]));
    expect(s.inputs).toEqual(["/r/src/a.ts"]);
    expect(s.notes).toContain(NOTE("vitest"));
  });

  it.each([
    ["**/e2e/**", "vitest"],
    ["./e2e/**/*", "vitest"],
    ["e2e/**", "vitest run --exclude e2e/**"],
    ["e2e/**", "vitest run --exclude=**/e2e/**"],
  ])("vitest exclude %s (%s)", async (glob, command) => {
    const cfg: Record<string, string> = command === "vitest" ? { "/r/vitest.config.ts": `export default { test: { exclude: ['${glob}'] } }` } : {};
    expect(isNoAffected(await plan(command, { ...PW, ...cfg }, ["e2e/login.spec.ts"]))).toBe(true);
  });

  it("jest: a plain testPathIgnorePatterns entry, with or without <rootDir>", async () => {
    for (const pat of ["/e2e/", "<rootDir>/e2e/"]) {
      const cfg = { "/r/jest.config.js": `module.exports = { testPathIgnorePatterns: ['/node_modules/', '${pat}'] }` };
      const s = spec(await plan("jest", { ...PW, ...cfg }, ["e2e/login.spec.ts", "src/a.ts"]));
      expect(s.inputs).toEqual(["/r/src/a.ts"]);
      expect(s.notes).toContain(NOTE("jest"));
    }
  });

  it("Playwright's own testDir rules: absent means the config's directory, a non-literal means e2e", async () => {
    const extra = { "/r/vitest.config.ts": VCFG };
    expect(isNoAffected(await plan("vitest", { ...extra, "/r/playwright.config.js": "module.exports = { use: {} }" }, ["e2e/login.spec.ts"]))).toBe(true);
    expect(isNoAffected(await plan("vitest", { ...extra, "/r/playwright.config.js": "module.exports = { testDir: path.join(__dirname, x) }" }, ["e2e/login.spec.ts"]))).toBe(true);
    const other = { ...extra, "/r/playwright.config.js": "module.exports = { testDir: './tests-e2e' }" };
    expect(spec(await plan("vitest", other, ["e2e/login.spec.ts"])).inputs).toEqual(["/r/e2e/login.spec.ts"]);
  });

  it.each<[string, string, Record<string, string>]>([
    ["no Playwright config", "vitest", { "/r/vitest.config.ts": VCFG }],
    ["no exclusion", "vitest", { ...PW, "/r/vitest.config.ts": "export default {}" }],
    ["a glob it does not model", "vitest", { ...PW, "/r/vitest.config.ts": "export default { test: { exclude: ['e2e/*.spec.ts'] } }" }],
    ["two vitest configs", "vitest", { ...PW, "/r/vitest.config.ts": VCFG, "/r/vitest.config.mjs": VCFG }],
    ["vite.config when vitest.config exists", "vitest", { ...PW, "/r/vitest.config.ts": "export default {}", "/r/vite.config.ts": VCFG }],
    ["a projects key", "vitest", { ...PW, "/r/vitest.config.ts": VCFG.replace("environment", "projects: [a], environment") }],
    ["a workspace file", "vitest", { ...PW, "/r/vitest.config.ts": VCFG, "/r/vitest.workspace.ts": "" }],
    ["--root on the command line", "vitest --root .", { ...PW, "/r/vitest.config.ts": VCFG }],
    ["a parent config", "npm test", { ...PW, "/r/vitest.config.ts": VCFG }],
    ["jest regex pattern", "jest", { ...PW, "/r/jest.config.js": "module.exports = { testPathIgnorePatterns: ['e2e/.*\\\\.spec'] }" }],
    ["jest <rootDir> with a non-literal rootDir", "jest", { ...PW, "/r/jest.config.js": "module.exports = { rootDir: base, testPathIgnorePatterns: ['<rootDir>/e2e/'] }" }],
    ["jest --rootDir", "jest --rootDir .", { ...PW, "/r/jest.config.js": "module.exports = { testPathIgnorePatterns: ['/e2e/'] }" }],
  ])("stays an input (fail-closed): %s", async (_n, command, extra) => {
    const files = { ...extra, "/r/sub/package.json": JSON.stringify({ name: "s", scripts: { test: "vitest" } }), "/r/sub/e2e/login.spec.ts": "" };
    const sub = command === "npm test";
    const r = sub
      ? await planScopedRun(input({ command, cwd: "/r/sub", files: jsRepo({}, files), changedFiles: changed("/r/sub/e2e/login.spec.ts") }))
      : await plan(command, extra, ["e2e/login.spec.ts"]);
    expect(isScopedSpec(r), JSON.stringify(r)).toBe(true);
  });

  it("the --config file is the one loaded; an oversized Playwright config is S6, an unreadable one is skipped", async () => {
    const cfg = { "/r/cfg/unit.mts": "export default { test: { exclude: ['e2e/**'] } }" };
    expect(isNoAffected(await plan("vitest run --config cfg/unit.mts", { ...PW, ...cfg }, ["e2e/login.spec.ts"]))).toBe(true);
    const big = { "/r/vitest.config.ts": VCFG, "/r/playwright.config.ts": "x".repeat(CONFIG_SIZE_LIMIT + 1) };
    expectS6(await plan("vitest", big, ["e2e/login.spec.ts"]), "config-too-large");
    const fs = memFs(jsRepo({}, { ...PW, "/r/vitest.config.ts": VCFG, "/r/e2e/login.spec.ts": "" }), false, {}, ["/r/playwright.config.ts"]);
    expect(spec(await planScopedRun(input({ fs, changedFiles: changed("e2e/login.spec.ts") }))).inputs).toEqual(["/r/e2e/login.spec.ts"]);
  });
});
describe("QA-1.3-32: .npmrc keys as npm's ini parser reads them, and npx", () => {
  const files = (extra: Record<string, string>) => jsRepo({ test: "vitest", ptest: "npx vitest run" }, { "/r/src/a.ts": "", ...extra });
  const plan = (extra: Record<string, string>, command = "npm test", over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command, files: files(extra), changedFiles: changed("src/a.ts"), ...over }));

  it.each([
    ['"workspace" = packages/app', "npm workspace"],
    ["'workspaces' = true", "npm workspaces"],
    ["\uFEFFworkspace=packages/app", "npm workspace"],
    ['"work\\u0073pace"=x', "npm workspace"],
    ["'\"workspace\"'=x", "npm workspace"],
    ["workspaces", "npm workspaces"],
    ["workspace;note=x", "npm workspace"],
    ["  WORKSPACE[] = a", "npm workspace"],
    ["[section]\nworkspace=a", "npm workspace"],
  ])(".npmrc %j -> S6 %s", async (npmrc, prefix) => {
    expectS6(await plan({ "/r/.npmrc": npmrc }), "unsupported-command", `unsupported command "${prefix}" in /r/.npmrc`);
  });

  it.each(['"workspaces-update" = false', "=workspace", "work\\;space=1", "wo\\rkspace=1", "a\\", "'\"'=1", "[workspace]", "# workspace=x"])(".npmrc %j still plans", async (npmrc) => {
    expect(isScopedSpec(await plan({ "/r/.npmrc": npmrc })), npmrc).toBe(true);
  });

  it("npx reads the same config, as a command or inside any package script", async () => {
    const why = 'unsupported command "npm workspace" in /r/.npmrc';
    expectS6(await plan({ "/r/.npmrc": "workspace=packages/app" }, "npx vitest run"), "unsupported-command", why);
    expectS6(await plan({ "/r/.npmrc": "workspace=packages/app" }, "pnpm run ptest"), "unsupported-command", why);
    const host = { ...POSIX_HOST, pathEnv: "/usr/bin", env: { npm_config_workspace: "packages/app" } };
    expectS6(await plan({}, "npx jest", { host }), "unsupported-command", 'unsupported command "npm npm_config_workspace" in the environment');
    expectS6(await plan({}, "cross-env NPM_CONFIG_WORKSPACES=true npx vitest"), "unsupported-command", 'unsupported command "npm NPM_CONFIG_WORKSPACES" in cross-env');
    for (const command of ["vitest run", "pnpm exec vitest", "yarn test"]) {
      expect(isScopedSpec(await plan({ "/r/.npmrc": "workspace=packages/app" }, command)), command).toBe(true);
    }
  });

  it("an oversized .npmrc is S6 config-too-large", async () => {
    expectS6(await plan({ "/r/.npmrc": "x".repeat(CONFIG_SIZE_LIMIT + 1) }), "config-too-large");
  });
});