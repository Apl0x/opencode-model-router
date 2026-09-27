# Handover — execute the Verification Resource Budget plan

You are the orchestrator that implements
`D:\git\omr-plan\docs\plans\verification-resource-budget-plan.md` **from start to finish** in this
session. You are a top-tier model, extremely intelligent and capable. Read the whole plan first; it
is authoritative. This handover adds the context, decisions and troubleshooting from the session that
wrote it, so you do not have to rediscover them.

---

## 1. Where things are

| What | Path / value |
|---|---|
| **Base repository directory (main checkout)** | `D:\git\opencode-model-router`, branch `master`, currently at the **stale** commit `c47b122`, with an uncommitted local edit to `D:\git\opencode-model-router\tiers.json` |
| **Plan worktree (outside the base directory)** | `D:\git\omr-plan`, branch `docs/verification-budget-plan` (pushed). It contains the plan and this handover. |
| Plan | `D:\git\omr-plan\docs\plans\verification-resource-budget-plan.md` |
| This handover | `D:\git\omr-plan\docs\plans\verification-resource-budget-handover.md` |
| Remote | `https://github.com/marco-jardim/opencode-model-router` (`gh` is authenticated) |
| Published | npm `opencode-model-router@1.14.0` = tag `v1.14.0` = `origin/master` `60c2de3` |
| Target | `1.15.0` |
| Other worktrees | `D:\git\opencode-model-router-agent-options-gate` and `D:\git\opencode-model-router-release` belong to the human. **Do not touch them.** Phase 3.3's cleanup removes only `D:\git\omr-*` worktrees and `vrb/*` branches. |
| Phase worktrees you will create | `D:\git\omr-p<NN>` on branches `vrb/p<NN>`, integration branches `vrb/wave-<n>` (plan §0.6) |

**Why the main checkout matters:** the human's live opencode sessions load this plugin from
`D:\git\opencode-model-router` (a local path in `C:\Users\Marquinho\.config\opencode\opencode.json`),
**not** from npm. Never edit, switch branches, or `npm ci` there, except in Phase 0.P (sync to
`1.14.0`) and Phase 3.3 (sync to `1.15.0`).

About the local `tiers.json` edit: it moves the anthropic preset to Opus 5.5 low/xhigh, and the
same change is already released in `1.14.0`, with one difference. The released version corrected the
medium `description` to "Opus 5.5 low …", which the local copy still has as "high". Phase 0.P.1
verifies that this is the **only** difference before discarding the local edit. If anything else
differs, it is the human's data: stop and ask.

---

## 2. Operating rules (summary; the plan's §0 is binding)

- **Iterate continuously.** Stop only for a blocking or critical problem (§0.1). Everything else is work.
- **Take over when delegation blocks you** (§0.10.2). If the model-router repeatedly blocks progress
  — a less capable subagent returning verbose, circular or off-target output, cap banners
  exhausting it, repeated `NEED MORE:`/`ESCALATE:` loops — momentarily do the blocked read or
  implementation yourself. Log it, then go back to delegating.
- **Pre-flight before each phase:** fix everything it finds. If the plan schedules a finding for a
  later phase, only document it (under "deferred by plan" in the phase QA report).
- **QA is always a heavy-tier task. Always apply this rule.** After every phase, delegate to
  `@heavy` an adversarial senior-engineer review of the work done. Fix every finding, then re-review
  until there are zero open findings. There is a global QA at the end (Phase 3.2).
- **Delegate always through the model-router**, preferring atomic tasks. Coding goes to `@medium`;
  complex coding may go to `@heavy`. Split heavy work: `@heavy` does the heavy lift (design or hard
  code), then lighter delegations run the tests and collect the results (`@fast`) and apply the
  mechanical fixes (`@medium`). Gather context with `@fast` **before** dispatching `@heavy`, and
  paste it into the dispatch.
- **`CAP:none` needs a `reason:` line** in the same dispatch, or the router silently ignores it.
- **Tests:** never run the full suite unless it is needed (the per-phase pre-flight, post-merge,
  release). Test only what the change touches, and accelerate those runs (§0.10.6: high parallelism
  is fine for scoped runs). Full-suite runs of this repo are always
  `npx vitest run --maxWorkers=2` and serialized, one at a time across all worktrees (§0.6.7).
- **Commit often:** after every green subtask; push immediately; conventional commits.
- **Full paths** in dispatches, commits, reports.
- **Linear:** this repo does not use it; no references were found. GitHub PRs are the tracking record.
- **Talk to the human in Portuguese** (short, direct, no flattery). Code, docs, commits and PRs are in
  English, matching the repo.

---

## 3. Background you need (do not re-derive)

### 3.1 The incident

Two opencode sessions with many subagents pinned a 16-core Windows machine at 80–100% CPU. A process
monitor traced the load to `cmd.exe /d /s /c "npm test"` → `vitest run` → 8–16 workers, started by
this plugin's dispatch-time test baseline one second after each `task` dispatch (even read-only
ones). On timeout, only `cmd.exe` died; the vitest workers kept running as orphans.

### 3.2 Already shipped in 1.14.0 (PR #53, merged; tag `v1.14.0`)

- `D:\git\opencode-model-router\src\verify\exec.ts` (`runShell`) kills the whole tree on timeout or
  abort: `taskkill /T /F` on Windows, the process group on POSIX. Tests with real processes are in
  `D:\git\opencode-model-router\test\unit\exec.test.ts`.
- There is no baseline for read-only dispatches.
- At most one capture runs per directory + command per process.
- The anthropic preset: heavy = Opus 5.5 xhigh, medium = Opus 5.5 low.

**What 1.14.0 still does (why the plan exists):** it runs the **full** suite up to twice for every
delegation whose DoD has `testsPass`. The native `task` gate has no budget.

### 3.3 The owner's decisions (already encoded in the plan; do not reopen)

- **No test suite per delegation. Speed beats absolute safety.** The fast tier is a mid-tier model
  (Sonnet 5 class).
- **Verification is deferred by default and costs zero CPU.** The result returns immediately with an
  "unverified" footer, a deterministic risk level and a `vrf_` handle. Nothing runs unless the
  dispatch says `VERIFY:required`, the orchestrator calls `router_verify`, or `background: true` is
  set. Background verification is **off** by default (the owner's option B: many parallel sessions
  on one machine).
- **The orchestrator decides the risk.** `VERIFY:required|deferred` and `VERIFY_WAIT:<n>s` in the
  dispatch (default 5 s; `0s` = do not wait for the reference).
- **Verification slots** = `max(1, floor(cores/8))`, **2 workers** each, low priority.
- The release is `1.15.0` (minor), with one-key opt-outs (`defaultVerify: "required"`,
  `testScope: "full"`). A major version was considered and left as the owner's call. If the owner
  says major, change §1.5-9 and Phase 3.3.

### 3.4 Review history of the plan

A senior review already fixed these (plan commit `4174515`), so do not undo them:

- the capped, serialized self-test runs;
- one deadline per synchronous verification, including the native `task` gate;
- the bounded capture wait, with edit contamination kept;
- a heartbeat-based slot staleness instead of PID + hostname;
- no `child_process` in the new modules (spawning goes through an injected `ArgvSeam`);
- 2.1.1 publishes shared types before 2.2 and 2.4 start;
- G1 is scoped to router-built commands (explicit `run` checks run as written);
- merged Windows + Linux coverage;
- new CI actions pinned by SHA;
- no decisions deferred to "design notes".

---

## 4. Troubleshooting notes from the previous session

### Shell and harness

- **Windows 11, pwsh 7** is the primary shell. There is also a Git Bash tool. **The Bash tool resets
  cwd after every call**: use absolute paths or `cd <dir> && …` in the same command.
- A foreground `sleep N` of a minute or more is **blocked** by the harness. Poll with an until-loop
  (`for i in $(seq 1 30); do …; sleep 10; done`), or use `gh run watch <id> --exit-status` and
  `gh pr checks <n> --watch`.
- `rg` with a glob embedded in a Windows path (`rg … node_modules/x/*.d.ts`) fails with
  `os error 123`. Use `rg … <dir> --glob "*.d.ts"`.
- Reading files: some `Get-ChildItem -Recurse` scans over big repos hit the 2-minute tool timeout.
  Prefer `git ls-files | grep` or `rg --files`.

### Processes (the core of this plan)

- **An `exec` timeout only kills the shell.** The previous session reproduced it (a grandchild alive
  3 s after `exec` reported `killed=true signal=SIGTERM`). Any new spawn path must go through
  `runShell`/`runArgv`.
- **Node ≥ 20 refuses to spawn `.cmd`/`.bat` without a shell** (EINVAL, the CVE-2024-27980 fix). That
  is why the plan spawns `process.execPath <runner bin JS>` for vitest and jest (§1.5-1). Do not
  "fix" it by adding `shell: true`.
- **Orphan check** before each phase:
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -like '*omr-*'`.
  Kill a tree with `taskkill /pid <pid> /T /F`.
- **This repo's `vitest.config.ts` has no worker cap.** A bare `npm test` uses every core, so always
  pass `--maxWorkers`.

### Git and data safety

- **Spike D is critical.** Some removal methods follow Windows junctions and delete the **target's**
  contents. Prove which methods are safe **before** writing any `reference.ts` cleanup code. Use a
  sentinel file in a real `node_modules`.
- `git stash create` does not touch the working tree, index or stash list, and excludes untracked
  files. Spike E re-confirms this.
- **`master` is not protected.** The repo convention is PRs merged with **merge commits**, and a
  direct `chore(release): X.Y.Z` commit on `master` for releases.

### CI and release

- **Checks on PRs:**
  - `test` (ubuntu/windows × Node 20/22/24, runs `npm test` + `npm run typecheck`);
  - `smoke-keyless`;
  - CodeQL;
  - GitGuardian.
- **Publish** = push tag `v*` → `.github/workflows/publish.yml` runs `npm ci`, `npm test`,
  `npm publish` with OIDC trusted publishing and provenance. **`npm view` lags for minutes after a
  publish**; poll `https://registry.npmjs.org/opencode-model-router` (`dist-tags.latest`) instead.
  The publish log shows `+ opencode-model-router@X.Y.Z` when it worked.
- **Preset changes ripple into tests.** Any change to `tiers.json` requires updating the golden
  snapshots (`D:\git\opencode-model-router\test\golden\__snapshots__\*.snap`, review the diff line by
  line) and `D:\git\opencode-model-router\test\smoke\subagent-tiers.smoke.test.ts`, which pins the
  preset on purpose. Smokes are **not** in `npm test`, so run `npm run smoke:keyless`.
- **Known local-only smoke failure:** `test\smoke\registration.smoke.test.ts` fails locally
  (it expects `openai` and gets `anthropic`), probably because of the local opencode config. It
  passes in CI. Do not chase it unless it fails in CI.
- **Open dependabot PRs:** #41 (the vitest group bump) and #47 (`@types/node`). Do not merge them
  during execution. If #41 lands anyway, re-run Spike C, because the vitest CLI behaviour is pinned
  there.
- **No AI attribution:** never add a `Co-Authored-By` trailer naming Anthropic, Claude or any
  model, and never add a "Generated with Claude Code" line to commits or PR bodies. This is a
  standing rule of the repository owner.

### Your own session's plugin

- After Phase 0.P, the session that executes this plan still runs `1.14.0`, which runs a full-suite
  baseline for any dispatch whose acceptance block has `testsPass`. **Never put `check: testsPass`
  in your dispatches**; use scoped `check: run command="npx vitest run --maxWorkers=2 <files>"`
  (plan §0.5).
- The live sessions pick up a new plugin version only after a restart. Tell the human once (in
  Portuguese) after 0.P and after 3.3. It is not a blocker.

---

## 5. Kickoff sequence

1. Read the whole plan, then this handover again for §4.
2. **Phase 0.P** (`@fast`):
   - verify the `tiers.json` diff is the description line only, discard it, and fast-forward the main
     checkout to `origin/master`;
   - create `vrb/wave-1` from `origin/docs/verification-budget-plan` and push it;
   - record the machine facts (OS, cores, Node, `uv`/`pytest` availability).
3. **Wave 1:**
   - create the six phase worktrees `D:\git\omr-p11` … `D:\git\omr-p16` from `vrb/wave-1`, running
     `npm ci` **one at a time**;
   - run each phase's pre-flight and spikes (`@fast`);
   - dispatch the phases in parallel, following the file-ownership map (§2) and the dependency graph
     (§3);
   - task 1.2.2 (the seam types) goes first; paste its committed types verbatim into the 1.3 and 1.5
     dispatches.
4. After each phase: heavy QA, fix, re-review, then merge into the wave branch **in the order the
   plan gives**. Run the capped full suite once after each merge.
5. Continue through Wave 2 (2.1.1 design first; then 2.2/2.4 cores in parallel with 2.1.2–2.1.6;
   then 2.2.3, 2.4.2–2.4.6, 2.3), then Wave 3 (3.1, then 3.2 global heavy QA, then 3.3 release).
6. **Progress updates to the human** in Portuguese: one short line per phase boundary (phase done,
   QA findings fixed, anything deferred by plan). The final report follows the plan's §4.2.

## 6. When to stop and ask (only these)

- The `tiers.json` diff in 0.P.1 is not just the description line.
- Any path that could delete real data (Spike D fails and no safe removal method exists).
- A security regression you cannot close: command injection, or an allowlist bypass.
- A published artifact is broken.
- The §0.8 recovery (3 attempts, then `@heavy`, then your own takeover) still fails on the same issue.
- A genuine ambiguity the plan does not settle, where the options differ materially.
