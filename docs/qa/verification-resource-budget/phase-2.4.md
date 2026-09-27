# Phase 2.4 — Deferred verification, `router_verify`, pending list (QA notes)

Branch `vrb/p24`, worktree `D:\git\omr-p24`. Task 2.4.1 (design) and 2.4.1b (`src/verify/pending.ts`
plus `test/unit/pending.test.ts`) are done. 2.1 and 2.2 (through 2.2.3) are merged into this branch
(`24008e5`, `origin/vrb/wave-2` `fdb319c`), so 2.4.2–2.4.6 can proceed.

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

Line numbers are for `c3ba342`, except for items 5, 6 and 9 and the reference-promise details,
which were re-read on `24008e5` (`vrb/p24` + `origin/vrb/wave-2` `fdb319c`, which adds 2.2). SDK:
`@opencode-ai/plugin` 1.18.18 in `node_modules`.

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
   - **The per-dispatch reference promise** lives on the store's `DispatchRecord`
     (`src/verify/dispatch.ts:127-154`).
     - `beginDispatch(id, cwd, deps)` (`:214-260`) sets `reference` synchronously. It is
       `deps.uncaptured` (default `none(notRequested)`) when there is no capture. Otherwise it is
       an async wrapper that settles once and **never rejects**: `captured`, `none(contaminated)`
       when an overlapping edit was observed while it ran, or `none(failed)` on a timeout or
       error. The capture is bounded by `deps.timeoutMs` = `baselineTimeoutMs` (`:247`).
     - A second `beginDispatch` for a tracked id keeps the original record (`:216-217`).
     - `reference(id, signal?)` (`:266-280`): with no signal, or once the capture has settled,
       it returns **the same promise object**. With a signal it races the pending capture against
       the abort (→ `none(gateBudget)`). For an unknown or swept id it returns
       `none(untracked)`.
   - **Its TTL.** The record is keyed by the dispatch id in `lastTouch`. `sweep(now, ttlMs =
     DEFAULT_IDLE_TTL_MS)` evicts every id idle for at least 1 h (`dispatch.ts:397-402`,
     `idle-sweep.ts:1`); `reference`, `beginDispatch` and `record` refresh the stamp. `clear(id)`
     and the sweep both go through `evict`, which **aborts the capture controller** (`:203`), so
     an in-flight capture ends as `none(failed)`.
   - Consequences for 2.4.2:
     - a deferred finish registers `store.reference(dispatchID)` **with no signal** (the live
       promise, never awaited);
     - it must not `clear(dispatchID)` before that promise settles, because the clear would kill
       the capture and stop the contamination tracking (`observeEdit`) that makes a late capture
       valid (§1.5-14). It clears in the promise's `then`, which runs within `baselineTimeoutMs`;
     - from then on the registry holds the promise for `pendingTtlMs`.
   - **Lineage precondition: holds on the normal path.**
     - `fromJudgement` copies `TestsPassJudgement.failures` onto the CheckResult
       (`deterministic.ts:1451-1460`).
     - `runDeterministic` concatenates them into `Verdict.failures` (`deterministic.ts:1680-1697`;
       the field is at `types.ts:24-28`).
     - `gateResult` spreads the verdict (`src/verify/gate.ts:79`), and `accept` returns it
       (`gate.ts:211`). So index.ts sees `res.verdict.failures` / `gateRes.verdict.failures`.
     - **Timeout path (corrected).** On a gate timeout or error, the caller builds the result with
       `unverifiableGateResult(reason, dodSource, strict, completedFailures)` (`gate.ts:84-93`).
       `completedFailures` are the free-text reasons that `deterministic.onFailure` collected
       before the budget ran out. When there are any, they are put in front of `reasons` and the
       outcome is **`fail`**, so an observed failure survives the timeout. Otherwise the outcome
       is `unverifiable`. The fresh verdict has **no `failures` field** in either case, and
       checker verdicts never carry one.
     - **What lineage does on a timeout:** nothing.
       - `recordRejection` needs proven-introduced **test ids**. A reason string is not one, and
         2.4 never parses ids out of reason text. So a timed-out rejection records nothing.
       - `findLineage` is consulted only for an accepted verdict whose `failures.preexisting` is
         non-empty. A timed-out result is never such a pass.
       - Residual (R13): ids proven introduced by a check that finished before the budget ran out
         are lost to the ledger. A later native re-dispatch can then pass with 2.1's "no worse
         than before" note.
     - Keep the lineage API.
6. **2.2 coordinator** (merged in `fdb319c`).
   - There is **one coordinator per plugin instance**. It is created in `createVerificationWiring`
     (`src/verify/wiring.ts:273`), swept by `sweepVerification` and disposed by
     `disposeVerification` (`:670-671`).
   - `buildGateDeps` chooses the testsPass hook (`wiring.ts:523-547`):
     - when `effectiveBatchWindowMs(budget) = min(batchWindowMs, floor(gateBudgetMs / 10))` is
       greater than 0, it is `coordinator.hook(runtime)`;
     - otherwise it is the direct 2.1 hook.
     - Each gate hands in its own runtime, so a config reload applies to the next window.
   - Pooling is all-or-nothing under deadline pressure (batch.ts B5.2a).
   - **How deferred verification (`router_verify`, 2.4.3) submits gates.** It uses the same
     wiring path as a required gate, with no second coordinator and no batch-specific call:
     1. Create **one** `createDeadline(gateBudgetMs)` per `router_verify` call, before any
        preparation (§1.5-13, QA-2.1-4).
     2. For each claimed handle, build a `PreparedVerification` from the pending entry:
        - the stored `changedFiles` (`"unavailable"` → change baseline unavailable);
        - the stored reference promise, awaited under that deadline's signal;
        - a fresh snapshot as `currentTree`.
     3. Call `buildGateDeps(sessionID, inFlight, prepared_i, deadline)` and `accept(…)` for every
        handle **concurrently**.
     4. Each `accept` has its own gate deps, but **every** handle's testsPass request carries the
        **same `Deadline` object**. Because they are submitted together, they meet in one window
        of the coordinator, which gives one batch.
     5. Wrap the whole call in `withTimeout(…, deadline.remaining())` and abort the deadline on
        rejection, exactly like the required gate.
   - Batch.ts supports the shared deadline explicitly:
     - B9 (`batch.ts:394`): "one per gate or router_verify call";
     - `settle` (`:1057-1058`): "Two members may share one Deadline (one router_verify call
       naming several handles): it is released with the last of them";
     - B5 step 2 (`:341`): several handles of one dispatch share one recheck reference.
   - Nothing extends the deadline. Handles not judged when it expires settle as
     `unverifiable` (retryable), and the batch's tree is killed through its signal.
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
   (`src/verify/runner.ts:4465`).
   - **No-spawn guarantee** (`runner.ts:11`): "This module plans verification commands. It never
     spawns anything and must not import child_process." It reaches the outside only through
     injected seams.
   - `planStaticScoping` is `plan(input, undefined)`: `planScopedRun` without the process-backed
     `TestSearchSeam` (O.4, `runner.ts:937-940`). So the §1.5-5 git grep and the pytest name
     mapping never run. Gone sources that would need them are counted in `pendingSearches`.
   - Input: `StaticScopingInput = Omit<PlanScopedRunInput, "search">` = `{ command, cwd,
     changedFiles, budget: { maxWorkers }, cores?, fs, host? }` (`:1402-1417`).
     - `command` is `resolveRepoCommand(check, "testsPass", undefined)`, as the gate resolves it.
     - `cwd` is `resolveBaseDir(delegation cwd, plugin directory)`, as `accept` does.
     - `fs` is the wiring's `fsSeam` (fs reads, realpath, stat, readdir).
   - Output: `StaticScopable | NoAffected | Unverifiable` (`:1390-1400`).
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

## Implementation notes (2.4.2a–c)

Commits on `vrb/p24`: merge `24008e5`, docs `aa571a9`, 2.4.2a `7eeb91a`, 2.4.2b `80598f5` and
2.4.2c `d414687`. The tests are in `test/integration/deferred-verification.test.ts`. Every routing
case runs on both paths through `describe.each(["task", "delegate"])`.

### Wiring API (`src/verify/wiring.ts`)

- `resolveDirectives(text)` calls `parseVerifyDirectives` with the config's `defaultVerify`,
  `captureWaitMs` and `baselineTimeoutMs`, and sends unknown values to `logger.warn`. When the
  config cannot be read, it returns `required` with a wait of 0, which is today's gate.
- `dispatchDirectiveText(prompt, description)` returns the orchestrator's `prompt`, or its
  `description` when the prompt is blank (the case the prompt-repair hook copies). It is never
  given tool output or subagent text.
- `startDispatch(store, id, cwd, dod, text, remember)` resolves the directives, then calls
  `beginVerificationBounded(…, waitMs)`. `beginVerificationBounded` now takes an optional
  `waitMs`, whose default is still `captureWaitMs`, so 2.1 callers and tests are unchanged.
  - `remember: true` (native path) keeps `{ directives, dispatchedAt }` for the after hook. The
    store holds at most 1 024 of them (FIFO), `sweepVerification` sweeps them at the idle TTL,
    and `disposeVerification` clears them.
- `takeDispatch(id, text)` returns the remembered start once. With nothing remembered, it
  re-parses the same prompt and uses `dispatchedAt = now`. A later `dispatchedAt` can only widen
  lineage (fewer passes).
- `isDeferred(dod, directives)` holds when all three hold: mode is `deferred`, the DoD has a
  `testsPass` check, and `require` is not `"never"`.
- `finishDeferred(store, input)` implements R3/R10 and never rejects. In order:
  1. It reads the reference promise with no signal and never awaits it.
  2. It reads "captured at return" from a `WeakMap` of settled states filled in
     `beginVerification`, so the check costs 0 ms.
  3. Under a `DEFERRED_FINISH_MS` (2 s) deadline, it runs `observeChange`: the snapshot, the
     commit diff (git only) and `delta`.
  4. It runs static scoping (see the decisions below) and computes the risk with `assessRisk`,
     passing the canonical tier and `root = snapshot.root`.
  5. It starts the drift digests (`digestFiles`: fs reads, not awaited), then calls `register`
     and builds the footer.
  6. If the change set is unavailable (the snapshot is missing or late, or the commit diff
     failed), it registers `"unavailable"` with `unattributedRisk()`, never `[]`.
  7. If anything throws, it still returns an `unverified · no handle (not registered)` footer.
- `observeChange` is `prepareVerification` without the reference await, and
  `prepareVerification` is now `observeChange` + `await store.reference(id, signal)`.
  - The only reorder: `delta` now runs before the reference await. `delta` reads only the
    store's record and the producers' tool-observed files, and neither changes once the producer
    has returned.
- `applyLineage(res, ctx)` applies R11 to a required gate's result:
  - outcome `fail` with `failures.introduced` → `recordRejection` with label
    `dispatch <id>` and `landedAt = returnedAt`;
  - otherwise, `failures.preexisting` matched by `findLineage` → the outcome becomes
    `unverifiable` and `buildLineageCaveat` is appended to the caveats. The result stays accepted
    unless `strictUnverifiable`.
  - No `failures` (checker verdicts, a timed-out gate) or no `root` → no change, nothing recorded.
- `pending`: one registry per plugin instance. Its TTL is `pendingTtlMs` and its abandonment
  bound is `gateBudgetMs + VERIFYING_GRACE_MS`, both read at plugin start (a reload applies
  after a restart). If the config is unreadable, the §1.4 defaults apply.

### Plugin (`src/index.ts`)

- **Native `task`.**
  - `tool.execute.before` calls `startDispatch(…, remember: true)` on the **raw** orchestrator
    prompt, before the dispatch header and the prompt repair.
  - `tool.execute.after` calls `takeDispatch`. When the dispatch is deferred it calls
    `finishDeferred`, appends the footer last with `appendRouterFooter`, clears the child's
    store entry, and returns: no gate deadline, no `buildGateDeps`, no `accept`.
  - Otherwise the 2.1 gate runs unchanged, followed by `applyLineage`, and then the existing
    forcing note or accepted suffix.
- **`delegate`.**
  - The directives come from `args.task` (`startDispatch`, `remember: false`) on the first
    attempt.
  - A deferred attempt whose producer returned: `finishDeferred`, the per-attempt cleanup, and
    `producerText + footer`. It gets no `nextAction`, no scorecard and no retry.
  - A required attempt keeps the gate and the ladder, with `applyLineage` after each gate.
  - `finally` does not clear `baselineID` when `finishDeferred` owns it.
- **Lifecycle.**
  - `pending.sweep()` is in the `createIdleTtlSweeper` list.
  - `session.deleted` calls `pending.forgetSession(id)`.
  - Plugin `dispose` calls `pending.dispose()` before `disposeVerification()`.

### Decisions (QA may challenge)

1. **What defers.** Only a DoD that has a `testsPass` check (R3: "else nothing is deferred"),
   with verification enabled. Checker-only and other deterministic DoDs are gated exactly as
   before, whatever the mode. When a DoD has `testsPass` and other checks, the **whole** gate is
   deferred, and `router_verify` later runs the whole gate (§1.5-18: "the same path as a required
   gate").
2. **`VERIFY_WAIT` applies to every verified dispatch's capture wait**, not only `testsPass` ones.
   It defaults to `captureWaitMs`, so a dispatch without the directive behaves as in 2.1.
3. **Static scoping for risk.**
   - `planStaticScoping` runs once per `testsPass` check, with the gate's command
     (`resolveRepoCommand`) and cwd (`resolveBaseDir`). The first S6 result wins.
   - A command outside the allowlist counts as S6 `unsupported-command` (the gate reports it
     unverifiable).
   - A plan that does not finish inside the 2 s bound counts as S6 `search-failed` with
     `STATIC_SCOPING_UNFINISHED_REASON`. That raises the risk and never lowers it.
4. **Dispatch record lifetime.**
   - `finishDeferred` clears the dispatch record in its `finally`, chained on the reference
     promise. So the record is gone only after the finish has read it **and** the capture has
     settled.
   - Clearing it earlier aborts the capture (`dispatch.ts:203`) and stops the §1.5-14
     contamination tracking. A test with a capture that honours its abort signal catches that
     regression on the delegate path.
5. **A delegate producer that failed outright** (transport error or timeout) keeps today's
   failed-attempt path, even in deferred mode. It produced nothing that could be verified later,
   and that path runs no verification process. Only a returned result is deferred, and a deferred
   result is never retried or escalated.
6. **Tier canonicalisation** (lowercase + trim) happens at the registry boundary
   (`finishDeferred` → `canonicalTier`) on both paths. The delegate ladder's own tier string
   (`tierModel`, `agent`, ladder index) is left as it was.
7. **Lineage on both paths.** R11 names the native path. `applyLineage` also runs after each
   delegate gate, because a native re-dispatch of rejected delegate work is the same T11 case.
   It can only remove passes. Within one delegate call it never matches its own attempts: every
   `landedAt` is after that call's `dispatchedAt`.
8. **Timeout lineage:** nothing is recorded (see gather item 5). Residual: ids proven introduced
   before the gate budget ran out are lost to the ledger.

### Test coverage (2.4.2)

- **Wiring:**
  - directive defaults and overrides;
  - `VERIFY_WAIT` latency under fake timers: 20 s capture with a 5 s wait → 5 s; wait 0 → 0;
    2 s capture with a 5 s wait → 2 s;
  - `isDeferred`;
  - `finishDeferred`: zero spawns, no scope opener, no testsPass hook; canonical tier;
    captured versus in-flight reference; the record outlives the capture; unavailable →
    unattributed; a slow snapshot is cut at 2 s; registration refused → footer without a
    handle;
  - `applyLineage`: record then downgrade; strict rejection; other session, other root and
    `dispatchedAt` all fail to match; timed-out gate and unknown root are no-ops.
- **Both paths:**
  - default deferred: footer last, zero non-git spawns, no slot, one pending entry;
  - a deferred result with a failing check is neither rejected nor retried;
  - `VERIFY:required` → gate and escalation, no footer;
  - `defaultVerify: "required"` → the same, and `VERIFY:deferred` still defers;
  - a non-`testsPass` DoD is gated;
  - a producer's `VERIFY:required` changes nothing;
  - the lineage context is correct;
  - `VERIFY_WAIT:5s` with a 20 s capture → the producer starts at 5 s, and the reference is still
    captured later;
  - `VERIFY_WAIT:0s` with a capture that never settles → immediate, and counted as no reference;
  - canonical tier;
  - `session.deleted` → forgotten;
  - sweep and dispose are wired.

### Follow-ups found in 2.4.2

- The `delegate` tool description (`src/index.ts`) still says every result is "INDEPENDENTLY
  VERIFIED … before it is returned". With deferred as the default, that is false for `testsPass`
  DoDs. It is protocol text owned by 2.3 (plan 2.3.1: everything the orchestrator reads must
  describe the final behaviour), so 2.3 must reword it.
- Risk row 1 short-circuits: a delegation with no attributed change is `low` even when there is
  no reference (risk.ts table). This is by design in 1.6; noted because the footer then shows no
  "no reference" reason.

## Implementation notes (2.4.3a, 2.4.3b, 2.4.4)

Commits on `vrb/p24`: 2.4.3a `e1f8cee`, 2.4.3b `da6eb9b`, 2.4.4 `be8dcf5`. Tests:
`test/integration/router-verify-tool.test.ts` (2.4.3) and
`test/integration/pending-list-transform.test.ts` (2.4.4). The plan names
`test/unit/router-verify-tool.test.ts`. The file is under `test/integration` because it drives the
plugin and the real 2.1/2.2 pipeline (planner, scope opener, batch coordinator, judge) over a
vitest-shaped project on disk, like `batch-wiring.test.ts`.

### Wiring API (`src/verify/wiring.ts`, 2.4.3a)

- `parseRouterVerifyArgs(args)`: exactly one of `handles` (a non-empty array) or `pending: true`.
  Both, neither, `pending: false` (also next to `handles`), and a non-array or empty `handles`
  return `ROUTER_VERIFY_ARGS_TEXT`. It is pure and never throws.
- `verifyHandles(sessionID, target, { signal })` never rejects. In order:
  1. **Targets.** `pending` is `listOpen(sessionID)` (unverified plus verifying, newest first). An
     empty list returns `ROUTER_VERIFY_NO_PENDING_TEXT` and runs nothing. For `handles`, each
     entry goes through `normalizeHandle`, and the normalized handles are deduped. A malformed or
     non-string entry is "unknown handle". The first `MAX_HANDLES_PER_CALL` (32) run, and the rest
     are counted in one "not run" line.
  2. **One deadline.** `createDeadline(gateBudgetMs)` is created once per call, before any
     preparation (§1.5-13). The tool's abort signal aborts it.
  3. **Claims.** `markVerifying` is called synchronously for every handle (R8).
     - `unknown` and `expired` get their R9 texts. An empty `sessionID` makes every handle
       unknown.
     - `settled` replays the cached verdict ("cached verdict; nothing was run"). Nothing is
       spawned and no snapshot is taken.
     - `joined` awaits the other call's run, bounded by this call's deadline, and answers
       `VERIFYING_ELSEWHERE_TEXT` if the deadline passes first.
     - If `markVerifying` throws mid-loop, the claims made so far are settled as retryable
       before the error propagates.
  4. **Preparation (P0 from the entry).** For every claimed handle:
     - the stored changed files (`"unavailable"` stays unavailable, never `[]`);
     - the stored reference, awaited under the deadline (`none(gateBudget)` on expiry, like
       `store.reference(id, signal)`);
     - a fresh tree snapshot once per cwd (git only, `digestPaths: []`, bounded by
       `GRADE_SNAPSHOT_TIMEOUT_MS`). It feeds `currentTree`, which materialize uses for its
       same-repository guard;
     - the drift check (see decision 1).
  5. **Gates.** Once every preparation has settled, all gates start at once. Each uses the
     required gate's sequence: `buildGateDeps(orchestrator, inFlight, prepared, deadline)`, then
     `accept({ dod, trivial: false, mode: "modeA", cwd })` under
     `withTimeout(deadline.remaining())`, then `unverifiableGateResult(…, completedFailures)` on a
     reject. Every testsPass request carries the **same** `Deadline`, so the requests meet in one
     S5 window (batch.ts B9, W7).
  6. **Verdict.** R11 `lineageDowngrade` runs first, then the drift rule, then `nextTier` for a
     fail, using the ladder rule from `index.ts` with the canonical producer tier.
  7. **Settle.** `claim.settle` runs in a `finally`, with a retryable fallback result when judging
     threw.
- `lineageDowngrade` is the R11 downgrade half, taken out of `applyLineage` without changing
  `applyLineage`'s behaviour. `verifyHandles` uses only this half. The record half is
  `claim.settle`'s automatic `recordRejection` (label = handle, `landedAt` = `createdAt`), so a
  rejection is never recorded twice.
- `isRetryableVerdict(verdict, cut)` supplies R4's `retryable` (see decision 2).
- `formatVerifyReport(items, excess, strictUnverifiable)` writes one block per handle, in call
  order: `- <handle> · <description> · pass|fail|unverifiable`.
  - An accepted verdict gets the required gate's `buildAcceptedSuffix`.
  - A rejected one gets `buildForcingNote(reasons, { producerTier, nextTier })` followed by
    `ROUTER_VERIFY_NO_RETRY_TEXT`.
  - The drift notice has its own line.
  - A retryable result reads "not judged: <reasons>", followed by "still unverified; call
    `router_verify` again".
  - The output is scrubbed like the gate's forcing notes.

### Plugin (`src/index.ts`, 2.4.3b and 2.4.4)

- **`router_verify`** is registered next to `delegate` with args
  `{ handles?: string[]; pending?: boolean }`. `execute` never throws: argument errors and
  failures come back as text. The session is `toolCtx.sessionID`, or none (then every handle is
  unknown). `toolCtx.abort` is passed on as the call signal.
- **Registration.** `routerVerifyEnabled` is fixed at plugin start and holds when both hold:
  - `verify.require` is not `"never"`;
  - the enforcement mode is not `"off"`, or the delegate tool is enabled (the delegate tool
    verifies in every mode).

  It does not depend on `enableDelegateTool` otherwise.
- **Deferral requires the tool.** The wiring's `isDeferred` is wrapped as `routerVerifyEnabled &&
  isDeferred(…)` on both paths. So a footer never names a tool this instance did not register.
- **2.4.4 system transform.** After the protocol push, on the orchestrator path only, it calls
  `buildPendingListBlock(pending.listUnverified(sessionID))` and pushes the block as its own
  system entry when it is defined.
  - A missing `sessionID`, graders and subagents return earlier, through the existing
    suppression. So do bypass mode and child sessions.
  - Entries in `verifying` are not listed (R5 `listUnverified`).
  - A registry error is logged, and the transform goes on.

### Decisions (QA may challenge)

1. **Drift never lets a pass stand.** §1.5-18 asks only for a notice. The owner's rule (deferred
   verification is never weaker than a required gate on the same work) goes further:
   - a required gate judges the tree right after the producer returns;
   - `router_verify` judges the current tree.

   So:
   - **Drifted** (stored digests ≠ current digests, `driftedPaths`): a pass becomes
     `unverifiable` with `DRIFT_NOTICE` and the drifted paths. A fail stays a fail, with the
     notice. The drifted files are the producer's own stored changed files, because the digests
     are keyed by that set. So they are always inside the verification scope, and the run sees
     their current content.
   - **Unprovable**: no stored digests, a digest that cannot be taken, the deadline, or an
     unattributed change set. The same downgrade applies, with `DRIFT_UNCHECKED_NOTICE`. It is
     never a claim of "no drift" without proof. Under `testScope: "full"`, an unattributed
     change set can therefore never pass through `router_verify`.
2. **Retryable (R4).** `isRetryableVerdict` never makes a pass or a fail retryable, and neither
   is a false pass:
   - only `unverifiable` and skipped (`require: "never"` at call time) verdicts can be
     retryable;
   - they are retryable when the call was cut (a gate timeout, the deadline, the tool's abort),
     or when a reason matches 2.1/2.2's stable transient phrases: budget exhausted, slot busy,
     `timed out after <n>ms`, `check errored`, coordinator or batch failures, and this module's
     `verification unavailable:`;
   - `REFERENCE_NONE.failed` ("failed or timed out" at dispatch) is deliberately **terminal**:
     that reference cannot be recaptured, and a retryable entry would stay in the pending list
     and invite futile reruns;
   - a misclassification only reruns the entry, or replays an `unverifiable`.
3. **Preparation before gates.** W7 closes a window when no request is planning. So one gate
   starting early could batch alone. Every preparation finishes first, then every gate starts
   together. Cost: a reference still being captured for one handle delays the others' gates.
   That wait is bounded by the shared deadline, and references are git-only and usually settled
   long before a `router_verify` call.
4. **A shared deadline and errors.** A gate timeout aborts the shared deadline and that gate's
   graders, as the required gate does; every member expires at the same instant anyway. Any
   other exception in one gate becomes that handle's retryable `verification unavailable: …` and
   does **not** abort the other handles' batch.
5. **Stricter inputs than the required path.** `trivial: false` always: a deferred testsPass
   delegation is judged in full, even where the native path would have skipped a trivial
   inferred DoD. `finalReturnText` is `""`: it is not stored (R3), and a testsPass DoD is
   deterministic, so no check reads it.
6. **Lineage root.** It is the registered `root`, or the fresh snapshot's root when the deferred
   finish had none. This can only remove passes.
7. **Nothing is retried.** A fail gets the forcing note with the next tier, plus the no-retry
   line. The tests assert that no session is created.
8. **Arguments are strict.** `{ handles, pending: false }` is an error, not "handles". The error
   text says exactly what to pass.

### Residuals

- `maxVerifyingMs` is `gateBudgetMs` at plugin start plus 30 s. A runtime config change that
  raises `gateBudgetMs` beyond that lets the reaper take back a live claim. Its later `settle`
  then returns `false`, and the run has already resolved `ABANDONED` (retryable), so the entry
  is re-verified later. Nothing is lost except that run.
- The tool map is fixed at plugin start (the SDK's `tool` object). Turning verification on at
  runtime in an instance that started without it keeps delegations synchronous (decision in
  2.4.3b), until a restart registers the tool.
- Spike F (a), (b), (d) stay live checks for 3.1: whether the tool is visible to the
  orchestrator, how long the host lets `execute` run, and per-agent visibility. The optional
  hardening of adding `router_verify` to `experimental.primary_tools` is not done. R6 already
  answers a subagent's call with "unknown handle".

### Test coverage (2.4.3, 2.4.4)

- `router-verify-tool.test.ts`, `verifyHandles (2.4.3a)`:
  - the argument matrix and the retryable matrix;
  - pass: verified, then a cached replay with no new run, git call, slot hold or snapshot;
  - fail: the forcing note with `medium` after `fast`, the no-retry line, no session, the
    lineage record;
  - unverifiable without a reference (terminal);
  - an unattributed change set: no run;
  - drift → notice, and the pass is gone;
  - unchecked drift → the same;
  - three handles → one `createDeadline`, one union run, one slot hold;
  - two concurrent calls → one run, and the second joins it;
  - slot busy → back to unverified, then judged on the next call;
  - R11 lineage turns a later pre-existing pass into `unverifiable` naming the earlier handle;
  - R6: other session, producer session, `""` and malformed input are all unknown;
  - expired (injected clock);
  - dedupe and the 32 cap;
  - `pending: true` verifies `listOpen` and joins a run in flight;
  - a cancelled call judges nothing.
- `router-verify-tool.test.ts`, `the router_verify tool (2.4.3b)`:
  - registration with and without `delegate`, and absent under `require: "never"`;
  - without the tool, a later testsPass task is not deferred;
  - the exactly-one texts; `execute` never throws;
  - session scoping through `toolCtx.sessionID`;
  - end to end: a deferred native task's footer handle, then `pending: true`; a cancelled call.
- `pending-list-transform.test.ts`:
  - absent when empty;
  - one block after the protocol: 5 of 7 entries, newest first, and "… and 2 more";
  - verified and verifying entries leave the list;
  - sessions never see each other's entries;
  - never for a subagent or without a session id.

### Left in 2.4

- **2.4.5 background mode** (`background: true` only):
  - the queue factory, coalescing, the same coordinator, slot and caps;
  - late notices once per handle, injected at the marked place in the system transform
    (`buildLateNoticeBlock`);
  - a test that asserts the queue is never constructed when `background` is false.
- **2.4.6 remaining tests:**
  - `router_verify` with a deadline that expires mid-run: `unverifiable` for the handles not yet
    judged, and the tree killed;
  - a capture that resolves after the wait but was invalidated by an edit, followed by
    `router_verify` → "no reference";
  - 50 deferred delegations with `background: false` spawn nothing.

  Latency and "subagent cannot self-select" are already covered by 2.4.2.
- **2.3** must describe `router_verify` in the protocol text and in `COMMAND_REFERENCE_INDEX.md`.

## Task breakdown

Each task is ≤ ~20 tool calls. Commit and push each one when green. Run only scoped
`npx vitest run --maxWorkers=2 <files>`, never the full suite.

| Task | When | Scope |
|---|---|---|
| 2.4.1b | now | Implement pending.ts R2–R11 + `test/unit/pending.test.ts`. Cover the R6 scoping matrix, every R4 transition, join (N calls → one claim), single-use settle, reaping, TTL at read without a sweep, caps, eviction order and weight, `registry-full`, release on terminal settle, a rejected reference promise normalized, `forgetSession`, dispose resolving joiners, every R9 text verbatim, and the lineage matrix. |
| 2.4.2a | **done** `7eeb91a` | wiring.ts: parse directives from the orchestrator prompt only; `VERIFY_WAIT` bounds the capture wait; deferred-finish helper (snapshot → changed files or `"unavailable"`, static scoping, risk, digests, register, footer). |
| 2.4.2b | **done** `80598f5` | index.ts native `task`: mode routing; required path unchanged; deferred footer; `recordRejection` on required rejections; `pending.sweep` in `createIdleTtlSweeper`. |
| 2.4.2c | **done** `d414687` | index.ts `delegate`: same routing; footer on the tool return; no ladder for deferred. |
| 2.4.3a | **done** `e1f8cee` | wiring.ts `verifyHandles`: normalize, claim/join, one `Deadline`, one batch via the 2.2 coordinator, drift, per-handle verdict with forcing note and next tier, lineage caveat, settle in `finally`, no retry ever. Spike F's live items remain for 3.1. |
| 2.4.3b | **done** `da6eb9b` | index.ts: register `router_verify` whenever verification is enabled (independent of `enableDelegateTool`); `test/integration/router-verify-tool.test.ts`. |
| 2.4.4 | **done** `be8dcf5` | System transform: `buildPendingListBlock(listUnverified(sid))`, appended only when defined; `test/integration/pending-list-transform.test.ts`. |
| 2.4.5 | after 2.4.3 | Background mode (only `background: true`): queue factory in pending.ts, coalescing, same coordinator, slot and caps, late notices once per handle; never constructed when false. |
| 2.4.6 | last | Remaining plan tests in `test/unit/deferred-verification.test.ts`: latency under fake timers, capture after the wait, subagent cannot self-select, 50 deferred delegations spawn nothing. |
