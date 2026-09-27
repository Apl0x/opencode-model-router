# Phase 2.4 — Deferred verification, `router_verify`, pending list (QA notes)

Branch `vrb/p24`, worktree `D:\git\omr-p24`. Task 2.4.1 (design) is done. Task 2.4.1b (implementing
`src/verify/pending.ts` plus `test/unit/pending.test.ts`) can start now. Tasks 2.4.2–2.4.6 start
only after 2.1 and 2.2 (through 2.2.3) are merged and their QA is clean (plan dependency graph).

## Pre-flight

### Done for 2.4.1

- The 2.1.1 contract types are cherry-picked from `origin/vrb/p21` (`5be8c85`, applied cleanly as
  `415ab63`). The types block in `src/verify/types.ts` is not edited.
- Read for the design:
  - plan §1.4, §1.5-13..20, §1.6, Phase 2.1, Phase 2.2 and Phase 2.4;
  - the 2.1.1 design header in `origin/vrb/p21:src/verify/deterministic.ts` (T2 pipeline, T3
    deadline, T9 handoffs, T10 tasks, T11 residuals);
  - `src/router/sessions.ts` (`createSessionStore`, `markChildSession`, `parseCapDirective`);
  - `src/verify/directives.ts`, `src/verify/risk.ts`;
  - `src/router/idle-sweep.ts` and the `createIdleTtlSweeper` list in `src/index.ts`;
  - `DispatchReference` in `src/verify/reference.ts`;
  - the "Handoff to 2.4" lists in `phase-1.6.md` (rounds 3–5).
- File ownership: plan §2 assigns `pending.ts` to 2.4. `test/unit/pending.test.ts` is not listed
  in §2. It is the unit-test file that plan task 2.4.1 calls for ("pending.ts and its unit tests"),
  so 2.4 owns it as well.

### Still needed before 2.4.2+ (gather `[tier:fast]`, after the 2.1 and 2.2 merges)

Gather against the **merged** `vrb/wave-2` tree, not the Wave-1 tree. 2.1 and 2.2.3 rewrite
exactly the code that 2.4.2+ edits.

1. `src/index.ts`: the `tool: { … }` block that registers `delegate`. Record:
   - the `tool({ description, args, execute })` pattern;
   - the `tool.schema` (zod) arg builder;
   - whether the host accepts a union arg schema. If it does not, `router_verify` uses
     `{ handles?: string[]; pending?: boolean }` and validates "exactly one" at runtime.
2. `experimental.chat.system.transform`:
   - how `output.system` is appended;
   - whether `input.sessionID` is available there;
   - where the `isSubagent` suppression of the protocol happens. The pending list is keyed by
     the calling session and is emitted whenever that session has entries.
3. `tool.execute.before` / `tool.execute.after` for `task`:
   - confirm that `input.sessionID` is the **orchestrator** (the calling session);
   - where `args.prompt` and `args.description` are read;
   - how the child session id is extracted (`parseTaskResult`);
   - where the merged 2.1 calls `beginVerification` / `prepareVerification` and the bounded capture
     wait (2.1.5b), which 2.4.2 replaces with `VERIFY_WAIT`.
4. `buildForcingNote` (`src/verify/dispatch.ts`): its signature and the next-tier rule. It supplies
   `nextTier` on a `router_verify` rejection.
5. The merged 2.1 API:
   - `prepareVerification`'s signature and return (`changedFiles`, `reference`, `snapshot`);
   - `TreeSnapshot.root` (2.1.3a);
   - `createDeadline`;
   - how the required gate is invoked, so `router_verify` reuses the same path;
   - the per-dispatch `Promise<ReferenceState>` in the changed-file store and its TTL;
   - **whether `TestsPassJudgement.failures` reaches the gate result that 2.4 code sees**. That is
     the precondition for the T11 lineage caveat (pending.ts R11). If it does not, delete the
     lineage API and keep T11 as a residual. 2.1 internals are not edited.
6. The merged 2.2 API: the coordinator in `wiring.ts`, and how several requests are submitted
   under one `Deadline` (a `router_verify` call with several handles → one batch).
7. Session lifecycle: does the plugin receive a session-deletion event? If yes, it calls
   `forgetSession` (and drops late notices, §1.5-19). If no, record that TTL is the only eviction
   path.
8. Config: the `resolveVerifyBudget` field names for `defaultVerify`, `captureWaitMs`, `background`,
   `pendingTtlMs`, `gateBudgetMs` and `baselineTimeoutMs` (Phase 1.1), and the QA-1.6-8 clamp
   status.
9. `planStaticScoping` (runner.ts): its inputs and its no-spawn guarantee. It supplies risk's
   `scopingPlan`.
10. Producer tier: `sessionStore.getTier(childID)` for the native `task` path, and the tier
    argument of `delegate`. Both must be canonical lowercase ids.
11. Deferred-path result latency. The changed files for a deferred delegation need a tree
    snapshot (git status, an allowed git-only command). Measure it on this repo. Decide a bound
    for the deferred finish (proposal: 2 s). On expiry, register `changedFiles: "unavailable"`
    with `unattributedRisk()`; never `[]`.

### Spike F `[tier:fast]` (before 2.4.3)

Use a scratch plugin or the smoke harness:

- (a) A second plugin tool registered next to `delegate` is visible to and callable by the
  orchestrator.
- (b) Its `execute` can run for `gateBudgetMs` (90 s) without the host timing it out. Test with a
  100 s sleep and record the observed limit.
- (c) Text appended to a native `task` output in `tool.execute.after` reaches the orchestrator
  verbatim: re-check with a footer that contains `vrf_<24 hex>` and U+00B7 `·`. Repeat the check
  for the `delegate` tool return.
- (d) Whether a subagent session can call `router_verify` (tool visibility per agent). R6 scoping
  makes it harmless; record the answer anyway.
- (e) The union-schema question from gather item 1.
- (f) The `sessionID` availability in `experimental.chat.system.transform` (gather item 2).

### Gather answers (merged tree `c3ba342` = `vrb/p24` + `origin/vrb/wave-2` `fbcf456`)

Line numbers are for `c3ba342`. SDK: `@opencode-ai/plugin` 1.18.18 in `node_modules`. `vrb/wave-2`
holds 2.1 only; 2.2 is **not merged yet**, so item 6 stays open.

1. **Tool registration.** `tool: { ...(enableDelegateTool ? { delegate: tool({ description, args,
   execute }) } : {}) }` at `src/index.ts:444-778`. Args are built with `tool.schema.string()
   .optional().describe(…)` (`src/index.ts:448-468`). `execute(args, toolCtx)` returns
   `Promise<string>` (`src/index.ts:469-477`). SDK: `tool<Args extends z.ZodRawShape>`, whose `args`
   is a raw object **shape**, wrapped as `z.ZodObject<Args>` (`plugin/dist/tool.d.ts:47-55`);
   `tool.schema` is `typeof z` (`tool.d.ts:56-58`). **A top-level union is not expressible**: the
   root is always an object. A field may be a zod union, but whether every provider's JSON-schema
   conversion accepts `anyOf` is untested. Decision: use `{ handles?: string[]; pending?: boolean }`
   and check "exactly one" at runtime.
2. **System transform.** `output.system.push(assembleSystemPrompt(…))` (`src/index.ts:1544`). SDK
   input is `{ sessionID?: string; model }` (`plugin/dist/index.d.ts:265-270`), so the sessionID is
   **optional**. The plugin reads `_input?.sessionID` and returns fail-closed when it is missing
   (`src/index.ts:1502-1506`). Child suppression runs before any push: `graderSessions.has ||
   sessionStore.isSubagent || !resolveIsRootSession` → `stripDelegateInstructions` and return
   (`src/index.ts:1512-1533`). The pending block goes next to `:1544`, orchestrator path only.
3. **`task` hooks.**
   - The SDK types `input.sessionID` for `tool.execute.before/after` (`index.d.ts:235-258`). The
     plugin treats it as the **calling (orchestrator) session**: the dispatch id is
     `task:${input.sessionID}:${input.callID}` (`src/index.ts:925`, `:1114`), and the child comes
     separately from `parseTaskResult(output).childSessionID` (`:1105`).
   - `args.prompt`/`args.description` are read from `output.args` in before (`:928-929`) and from
     `input.args` in after (`:1111-1112`).
   - The capture wait happens in before: `beginVerificationBounded(changedFileStore,
     task:<sid>:<callID>, cwd, dod)` (`:921-931`); delegate calls it at `:547-551`. 2.4.2 replaces
     both with `VERIFY_WAIT`. `prepareVerification` runs at `:1124` (task) and `:607` (delegate).
4. **`buildForcingNote(reasons: string[], escalation?: { producerTier?: string; nextTier?: string |
   null }): string`** (`src/verify/dispatch.ts:493-496`). The next-tier rule sits in the caller:
   `ladder = cfg.enforcement?.escalate?.ladder ?? ["fast","medium","heavy"]`, `nextTier = outcome
   !== "unverifiable" && li >= 0 && li < len-1 ? ladder[li+1] : null` (`src/index.ts:1210-1213`).
5. **Merged 2.1 API.**
   - `prepareVerification(store, id, childID, cwd?, deadline?): Promise<PreparedVerification>`
     (`src/verify/wiring.ts:163-169`). It returns `{ changedFiles: ChangedFile[]; changeBaseline:
     "available" | "unavailable"; reference: ReferenceState (settled); snapshot: TreeSnapshot |
     undefined }` (`wiring.ts:84-97`).
   - `TreeSnapshot.root?: string` is the real path of `--show-toplevel` (`src/verify/dispatch.ts:21-24`).
   - `createDeadline(budgetMs, opts?)` returns an `OwnedDeadline` (`src/verify/deterministic.ts:733`).
   - Gate path: `createDeadline(gateBudgetMs)` → `prepareVerification` → `buildGateDeps(parent,
     inFlight, verification, deadline)` → `withTimeout(accept(…), deadline.remaining())` →
     `unverifiableGateResult` on reject (`src/index.ts:1120-1208`; delegate `:597-686`).
     `router_verify` should reuse this sequence.
   - The per-dispatch reference promise and its TTL live in `createChangedFileStore`
     (`src/verify/dispatch.ts`). Not re-read for this gather; 2.4.2a must confirm them.
   - **Lineage precondition: holds on the normal path.**
     - `fromJudgement` copies `TestsPassJudgement.failures` onto the CheckResult
       (`deterministic.ts:1451-1460`).
     - `runDeterministic` concatenates them into `Verdict.failures` (`deterministic.ts:1680-1697`;
       the field is at `types.ts:24-28`).
     - `gateResult` spreads the verdict (`src/verify/gate.ts:79`), and `accept` returns it
       (`gate.ts:211`). So index.ts sees `res.verdict.failures` / `gateRes.verdict.failures`.
     - **Caveat:** on a gate timeout, `unverifiableGateResult` builds a fresh verdict without
       `failures` (`gate.ts:84-93`), so that path loses it. Checker verdicts never carry it.
     - Keep the lineage API.
6. **2.2 coordinator.** It is not in the merged tree (wave-2 holds 2.1 only), so this item is open
   until 2.2.3 merges.
7. **Session deletion: yes.** The SDK defines `EventSessionDeleted { type: "session.deleted";
   properties: { info: Session } }` (`sdk/dist/gen/types.gen.d.ts:505-510`). The plugin already
   handles it at `src/index.ts:1262-1274` (`info.id` → unregister). 2.4 adds
   `pending.forgetSession(id)` there. TTL stays as the backstop.
8. **Config.** `RouterConfig.enforcement.verify` has `baselineTimeoutMs` (`src/router/config.ts:135`),
   `gateBudgetMs` (`:139`), `defaultVerify` (`:149`), `captureWaitMs` (`:151`), `background` (`:153`)
   and `pendingTtlMs` (`:155`). `resolveVerifyBudget` (`:1329`) defaults them to `"deferred"`, 5000,
   `false` and 3 600 000 (`:1356-1360`), with `baselineTimeoutMs` 15 000 (`:1350`). **The QA-1.6-8
   clamp is in place:** `captureWaitMs = min(own ?? 5000, baselineTimeoutMs)` (`:1351`).
9. **`planStaticScoping(input: StaticScopingInput): Promise<StaticScoping>`**
   (`src/verify/runner.ts:4447`). The no-spawn guarantee was not re-read here; 2.4.2a confirms it
   against the runner header.
10. **Producer tier.**
    - `sessionStore.getTier(sessionID): string | null` (`src/router/sessions.ts:373`).
    - The native `task` path takes the tier from `input.args.subagent_type` (`src/index.ts:1106-1109`).
    - `delegate` uses `args.tier.trim()` or `activeCfg.defaultTier || "medium"`
      (`src/index.ts:491-494`). It trims but does **not lowercase**, so 2.4 must canonicalise it.
11. **Deferred-finish latency.** `git status --porcelain=v2 -z --untracked-files=all` on this
    worktree took 60.6 / 49.9 / 53.5 ms (pwsh `Measure-Command`, warm cache). A full
    `snapshotTree` also runs `rev-parse --show-toplevel` and digests dirty files (`src/verify/tree.ts:82-118`),
    so it costs more. The 2 s bound is kept: it is about 30× the measured git time. On expiry,
    register `"unavailable"` with `unattributedRisk()`.

### Spike F answers (static; live items for 3.1)

- **(a) Second tool: yes, by type.** `Hooks.tool` is `{ [key: string]: ToolDefinition }`
  (`plugin/dist/index.d.ts:179-181`), so `router_verify` sits next to `delegate` in the same object
  (`src/index.ts:444-778`). Visibility and callability by the orchestrator still **need a live
  check in 3.1**: set `enforcement.verify` on, then `opencode run "call router_verify with
  pending: true"`, and confirm the tool call is in the transcript.
- **(b) Long execute: no timeout in the SDK types.**
  - `ToolContext` carries only `abort: AbortSignal` (`plugin/dist/tool.d.ts:16`), and
    `plugin/dist/index.d.ts` has no timeout field.
  - The plugin sets its own bounds (`withTimeout`, `src/index.ts:575-589`, `:638-652`).
  - The host limit **needs a live check in 3.1**: a scratch tool that awaits 100 s, invoked with
    `opencode run`. Record whether `ctx.abort` fires and when.
- **(c) Verbatim `vrf_…` and `·`: no plugin-side sanitiser alters them.**
  - `scrubText` redacts only key/value secrets and token shapes (`src/guard/scrub.ts:1-26`): no
    `vrf_` pattern, and no non-ASCII stripping.
  - The task path appends to `output.output` (`src/index.ts:1214-1220`), and delegate returns a
    plain string (`:743`, `:753-758`).
  - Host and model-side delivery **needs a live check in 3.1**: append `unverified · vrf_<24 hex>`
    in `tool.execute.after` for `task` and on the delegate return, then ask the orchestrator to
    echo it byte for byte.
- **(d) Subagents can see plugin tools: yes by default.**
  - Tier agents are registered with no `tools` map (`src/index.ts:1367-1375`).
  - opencode filters tools per agent through `agent.<name>.tools: { [id]: boolean }`
    (`sdk/dist/gen/types.gen.d.ts:840-842`) and `experimental.primary_tools` ("Tools that should
    only be available to primary agents", `types.gen.d.ts:1210-1212`).
  - So a subagent can call `router_verify` unless the config restricts it. R6 scoping makes such
    a call harmless ("unknown handle"). Optional hardening: add `router_verify` to
    `primary_tools` in the `config` hook.
- **(e) Union args:** see gather item 1. The root must be an object shape; use optional fields
  plus a runtime "exactly one" check.
- **(f) `sessionID` in the system transform:** see gather item 2. It is typed optional, and the
  plugin fails closed when it is missing.

## Design notes (2.4.1)

The full design is the header of `src/verify/pending.ts`, sections R1–R13. The exported API
compiles, and every body throws "not implemented" until 2.4.1b. Key decisions:

- **Handles** are `vrf_` plus 24 hex characters (96 bits from `crypto.randomBytes`, injectable).
  Collisions are redrawn. `register` never throws: a failure yields a footer without a handle,
  and the delegation is never blocked.
- **Scoping is structural.** Storage is `Map<orchestratorSessionID, Map<handle, record>>`. Four
  cases all return the same "unknown handle":
  - another session's handle;
  - a producer's call;
  - a malformed handle;
  - a never-issued handle.

  "expired" only comes from this session's own tombstones.
- **States**: `unverified → verifying → verified`.
  - `markVerifying` is the join point: one caller gets "claimed", every concurrent caller gets
    "joined" and shares the same never-rejecting run promise.
  - `settle` is a single-use closure on the claim, which makes it unforgeable.
  - Retryable results (slot busy, deadline, abort, error) return the entry to `unverified`.
  - A verified entry returns its cached verdict and starts no new run (no CPU).
- **No timers.** TTL expiry and reaping of abandoned `verifying` claims are lazy (checked on every
  access) and also run through the existing throttled `createIdleTtlSweeper`. So an expired entry
  never shows up between sweeps.
- **Memory bounds**:
  - 32 entries per session, 128 global;
  - a global weight of 100 000 path strings: stored changed files, plus the untracked and tracked
    maps of a captured reference, added when it resolves;
  - more than 500 changed files are stored as `"unavailable"`, which is unverifiable later and is
    never truncated;
  - 512 tombstones;
  - 16 lineage records per session.

  Eviction order: expired entries, then verified (oldest first), then unverified (oldest first).
  Verifying entries are never evicted. A terminal settle releases the reference, the changed
  files, the digests and the DoD.
- **Nothing to dispose on eviction.** A stored `DispatchReference` is data only. Worktrees exist
  only inside a 2.1 `VerificationScope` and are disposed by its `close()`.
- **Text builders are pure and verbatim-tested**:
  - the deferred footer (§1.5-16);
  - the pending-list block (§1.5-20: at most 5 entries, newest first, `undefined` when empty);
  - the late-notice block (§1.5-19);
  - `appendRouterFooter`.

  Rules for all of them:
  - no builder emits a literal `VERIFY:`/`VERIFY_WAIT:`/`CAP:` directive, so a quoted footer
    cannot change a later dispatch's mode (QA-1.6-4/5);
  - the first token of the footer label is always `unverified`.
- **Risk handoffs (R10)**:
  - failed attribution → `unattributedRisk()` (high) and `changedFiles: "unavailable"`, never
    `[]` (QA-1.6-14);
  - `reference` is true only if the capture had **already** resolved `captured` at return. A
    capture still in flight counts as absent (conservative, 0 ms wait);
  - the tier is the canonical lowercase id;
  - `root` is `TreeSnapshot.root`;
  - `scopingPlan` comes from `planStaticScoping`.
- **T11 (native `task` re-dispatch after a rejection).** The re-dispatch is **not** linked to the
  original reference, because the router cannot tell a retry from a new delegation:
  - with the old reference, a third party's break in between would be blamed on the retry
    (§1.2);
  - a test fixed and then broken again in between would be excused, which is a false pass.

  Instead, a per-session ledger of proven-introduced test ids downgrades a pass to
  `unverifiable` when an id is pre-existing at the new reference **and** was introduced earlier
  in the same session and root. This can only remove a pass; it never creates a pass or a fail.
  It depends on gather item 5; if that precondition fails, the lineage API is deleted.

## Task breakdown

Each task is ≤ ~20 tool calls. Commit and push each one when green. Run only scoped
`npx vitest run --maxWorkers=2 <files>`, never the full suite.

| Task | When | Scope |
|---|---|---|
| 2.4.1b | now | Implement pending.ts R2–R11 + `test/unit/pending.test.ts`. Cover the R6 scoping matrix, every R4 transition, join (N calls → one claim), single-use settle, reaping, TTL at read without a sweep, caps, eviction order and weight, `registry-full`, release on terminal settle, a rejected reference promise normalized, `forgetSession`, dispose resolving joiners, every R9 text verbatim, and the lineage matrix. |
| 2.4.2a | after 2.1 + 2.2.3 merge | wiring.ts: parse directives from the orchestrator prompt only; `VERIFY_WAIT` bounds the capture wait; deferred-finish helper (snapshot → changed files or `"unavailable"`, static scoping, risk, digests, register, footer). |
| 2.4.2b | after 2.4.2a | index.ts native `task`: mode routing; required path unchanged; deferred footer; `recordRejection` on required rejections; `pending.sweep` in `createIdleTtlSweeper`. |
| 2.4.2c | after 2.4.2b | index.ts `delegate`: same routing; footer on the tool return; no ladder for deferred. |
| 2.4.3a | after Spike F | wiring.ts `verifyHandles`: normalize, claim/join, one `Deadline`, one batch via the 2.2 coordinator, drift, per-handle verdict with forcing note and next tier, lineage caveat, settle in `finally`, no retry ever. |
| 2.4.3b | after 2.4.3a | index.ts: register `router_verify` whenever verification is enabled (independent of `enableDelegateTool`); `test/unit/router-verify-tool.test.ts`. |
| 2.4.4 | after 2.4.2 | System transform: `buildPendingListBlock(listUnverified(sid))`, appended only when defined. |
| 2.4.5 | after 2.4.3 | Background mode (only `background: true`): queue factory in pending.ts, coalescing, same coordinator, slot and caps, late notices once per handle; never constructed when false. |
| 2.4.6 | last | Remaining plan tests in `test/unit/deferred-verification.test.ts`: latency under fake timers, capture after the wait, subagent cannot self-select, 50 deferred delegations spawn nothing. |
