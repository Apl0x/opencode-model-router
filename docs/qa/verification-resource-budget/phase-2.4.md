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
