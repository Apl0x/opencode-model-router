// src/verify/types.ts
// Pure types for the deterministic verifier. No runtime code.

export type VerifyMethod = "deterministic" | "checker" | "none";

export interface Verdict {
  pass: boolean;
  /** Absent on legacy verdicts: derive from pass. Unverifiable is not failure. */
  outcome?: "pass" | "fail" | "unverifiable";
  /** Checks that could not be performed; never evidence of producer failure. */
  caveats?: string[];
  /** Successful comparisons that must not be mistaken for a green suite. */
  notes?: string[];
  method: VerifyMethod;
  reasons: string[];
  evidence?: string;
  /** true when nothing was actually verified (SKIPPED != PASS) */
  skipped?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Options shared by every verification process seam (shell string or argv). */
export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Aborting kills the whole process tree; an already-aborted signal never spawns. */
  signal?: AbortSignal;
  /** Run the process (and its descendants) at below-normal OS priority. */
  lowPriority?: boolean;
  /** Merged over process.env; never replaces it. */
  env?: Record<string, string>;
}

export interface ExecSeam {
  (command: string, opts?: ExecOptions): Promise<ExecResult>;
}

/** Spawn `file` with `args` and no shell: arguments reach the child byte-for-byte. */
export interface ArgvSeam {
  (file: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
}

export interface FsSeam {
  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

export interface MutexRegistry {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface DeterministicDeps {
  /** Bound to the original dispatch, not looked up using the after-state diff. */
  testBaseline?: (command: string) => Promise<import("./baseline").TestBaseline | undefined>;
  /** Preserve completed failures if an outer gate budget expires later. */
  onFailure?: (reason: string) => void;
  exec: ExecSeam;
  fs: FsSeam;
  cwd: string;
  mutex?: MutexRegistry;
  /** per-check timeout in ms; default 120000 */
  timeoutMs?: number;
  /** permitted command first-token basenames; default DEFAULT_ALLOWLIST */
  allowlist?: string[];
  defaults?: {
    testCommand?: string;
    buildCommand?: string;
    lintCommand?: string;
  };
}
