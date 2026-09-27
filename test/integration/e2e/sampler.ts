/**
 * A machine-wide process sampler for the Phase 3.1 e2e suite.
 *
 * One long-lived helper process takes a snapshot of every process on the machine each interval
 * and writes it to stdout as one line; the test process parses them. A single long-lived sampler
 * (rather than one `ps`/CIM query per tick) keeps the sampler's own cost, and its own pid, stable.
 *
 * - win32: `powershell.exe` looping over `Get-CimInstance Win32_Process`, one compact JSON line
 *   per snapshot. `Priority` is the base priority: 6 is below normal, 8 normal.
 * - POSIX: `sh -c` looping over `ps -eo pid=,ppid=,ni=,args=`, framed by a timestamp line and a
 *   separator. `nice >= 10` counts as low priority.
 *
 * The pure helpers below (descendantsOf, peak, seen, priorityViolations) work on the snapshots.
 */
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { join } from "node:path";

export interface ProcSample {
  pid: number;
  ppid: number;
  lowPriority: boolean | undefined;
  priority: number | undefined /* win32 base priority or POSIX nice */;
  args: string;
  createdMs?: number;
}

export interface Snapshot {
  t: number /* Date.now() */;
  procs: ProcSample[];
}

export interface Sampler {
  stop(): Promise<Snapshot[]>;
  pid: number /* sampler process pid */;
}

/** Windows base priority at or below this is "below normal" (6); normal is 8. */
const WIN_LOW_PRIORITY_MAX = 6;
/** POSIX nice at or above this is low priority. */
const POSIX_LOW_NICE_MIN = 10;
const STOP_WAIT_MS = 3000;

/**
 * The real profile and temp dirs, captured when this module loads (before any plugin instance
 * points HOME/USERPROFILE at a fake home or a test redirects TEMP). With USERPROFILE at a fake home,
 * powershell.exe's Get-CimInstance loop emits no snapshot at all (measured: 0 snapshots in 6 s).
 */
const REAL_PROFILE_ENV: Record<string, string> = (() => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? os.userInfo().homedir;
  const tmp = process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  return {
    USERPROFILE: process.env.USERPROFILE ?? home,
    HOME: process.env.HOME ?? home,
    APPDATA: process.env.APPDATA ?? join(home, "AppData", "Roaming"),
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
    TEMP: tmp,
    TMP: process.env.TMP ?? tmp,
  };
})();

/** process.env with the profile/temp keys restored to their values at module load. */
function samplerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...REAL_PROFILE_ENV };
}

function windowsScript(intervalMs: number): string {
  // The stdin read is started once and polled: a raw-stream ReadAsync never blocks the loop
  // (Console.In.ReadLineAsync would: .NET Framework's synchronized reader runs it synchronously),
  // and a closed stdin (the test process died) completes it too, so the sampler cannot outlive
  // its parent.
  return [
    "$ErrorActionPreference = 'Continue'",
    `$iv = ${intervalMs}`,
    "$sin = [Console]::OpenStandardInput()",
    "$buf = New-Object byte[] 1",
    "$rd = $sin.ReadAsync($buf, 0, 1)",
    "while ($true) {",
    "  if ($rd.IsCompleted) { break }",
    "  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Priority,CommandLine,CreationDate | ForEach-Object {",
    "    $c = $null",
    "    if ($_.CreationDate -ne $null) { $c = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }",
    "    [pscustomobject]@{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId; r = $_.Priority; c = $c; a = [string]$_.CommandLine }",
    "  })",
    "  $json = ConvertTo-Json -Compress -Depth 2 -InputObject $rows",
    "  [Console]::Out.WriteLine('{\"t\":' + $t + ',\"procs\":' + $json + '}')",
    "  [Console]::Out.Flush()",
    "  $el = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t",
    "  if ($el -lt $iv) { Start-Sleep -Milliseconds ($iv - $el) }",
    "}",
  ].join("\n");
}

function posixScript(intervalMs: number): string {
  const secs = (intervalMs / 1000).toFixed(3);
  return `while :; do echo "@@T"; ps -eo pid=,ppid=,ni=,args=; echo "@@END"; sleep ${secs}; done`;
}

interface WinRow {
  p: number;
  q: number;
  r: number | null;
  c: number | null;
  a: string | null;
}

function parseWinLine(line: string): Snapshot | undefined {
  const raw = JSON.parse(line) as { t: number; procs: WinRow[] | WinRow | null };
  const rows = raw.procs === null ? [] : Array.isArray(raw.procs) ? raw.procs : [raw.procs];
  return {
    t: raw.t,
    procs: rows.map(r => {
      const priority = typeof r.r === "number" ? r.r : undefined;
      const sample: ProcSample = {
        pid: r.p,
        ppid: r.q,
        priority,
        lowPriority: priority === undefined ? undefined : priority <= WIN_LOW_PRIORITY_MAX,
        args: r.a ?? "",
      };
      if (typeof r.c === "number") sample.createdMs = r.c;
      return sample;
    }),
  };
}

function parsePsLine(line: string): ProcSample | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
  if (m === null) return undefined;
  const nice = /^-?\d+$/.test(m[3]) ? Number(m[3]) : undefined;
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    priority: nice,
    lowPriority: nice === undefined ? undefined : nice >= POSIX_LOW_NICE_MIN,
    args: m[4] ?? "",
  };
}

export function startSampler(opts?: {
  intervalMs?: number /* default 100 */;
  /** The sampler child's environment; default: process.env with the real profile/temp dirs (see REAL_PROFILE_ENV). */
  env?: NodeJS.ProcessEnv;
}): Sampler {
  const intervalMs = Math.max(1, Math.floor(opts?.intervalMs ?? 100));
  const env = opts?.env ?? samplerEnv();
  const isWin = process.platform === "win32";
  const snapshots: Snapshot[] = [];
  let parseErrors = 0;
  let buffer = "";
  let posixCurrent: Snapshot | undefined;

  let child: ChildProcess;
  if (isWin) {
    const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // -EncodedCommand rather than -Command: the script carries double quotes, which Windows argv
    // quoting would otherwise mangle on the way into powershell.exe.
    const encoded = Buffer.from(windowsScript(intervalMs), "utf16le").toString("base64");
    child = spawn(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
  } else {
    child = spawn("sh", ["-c", posixScript(intervalMs)], { stdio: ["pipe", "pipe", "pipe"], env });
  }

  const onLine = (line: string): void => {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "") return;
    if (isWin) {
      try {
        const snap = parseWinLine(trimmed);
        if (snap !== undefined) snapshots.push(snap);
      } catch (error) {
        parseErrors++;
        if (parseErrors === 1) process.stderr.write(`[sampler] unparsable line: ${String(error)}\n`);
      }
      return;
    }
    if (trimmed === "@@T") {
      posixCurrent = { t: Date.now(), procs: [] };
    } else if (trimmed === "@@END") {
      if (posixCurrent !== undefined) snapshots.push(posixCurrent);
      posixCurrent = undefined;
    } else if (posixCurrent !== undefined) {
      const s = parsePsLine(trimmed);
      if (s !== undefined) posixCurrent.procs.push(s);
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  });
  // Drain stderr so the pipe never fills; the sampler's diagnostics are not the test's concern.
  child.stderr?.resume();
  // A dead sampler (or a stdin write after it exited) must not crash the test process.
  child.on("error", (error: Error) => process.stderr.write(`[sampler] process error: ${error.message}\n`));
  child.stdin?.on("error", (error: Error) => process.stderr.write(`[sampler] stdin error: ${error.message}\n`));

  let exited = child.exitCode !== null || child.signalCode !== null;
  const exitPromise = new Promise<void>(resolve => {
    if (exited) resolve();
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      exited = true;
      resolve();
    });
  });

  let stopping: Promise<Snapshot[]> | undefined;
  const stop = (): Promise<Snapshot[]> => {
    stopping ??= (async () => {
      try {
        if (!exited) {
          if (isWin && child.stdin?.writable === true) child.stdin.end("stop\n");
          else child.kill();
          const timer = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), STOP_WAIT_MS).unref());
          if ((await Promise.race([exitPromise.then(() => "exit" as const), timer])) === "timeout") {
            child.kill();
            await Promise.race([exitPromise, new Promise<void>(resolve => setTimeout(resolve, STOP_WAIT_MS).unref())]);
          }
        }
        if (buffer !== "") {
          onLine(buffer);
          buffer = "";
        }
      } catch (error) {
        process.stderr.write(`[sampler] stop failed; returning what was collected: ${String(error)}\n`);
      }
      return snapshots.slice();
    })();
    return stopping;
  };

  return { stop, pid: child.pid ?? -1 };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Whether `child`, whose ppid names `parent`'s pid, is really `parent`'s child. Windows never
 * reparents: a process whose parent exited keeps the dead parent's pid as its ppid, and once that
 * pid is reused by a newer process the stale ppid points at an unrelated one. A process cannot be
 * created before its parent, so a child older than the process holding its ppid is not its child
 * (CI round 1: the CI job's own `npx` -> `cmd` -> `vitest` chain showed up as descendants of the
 * test process once a short-lived plugin child reused the pid of npx's exited parent). Without
 * creation times (POSIX samples, where orphans are reparented) the ppid is taken as is.
 */
export function isChildOf(child: ProcSample, parent: ProcSample | undefined): boolean {
  if (parent === undefined || child.createdMs === undefined || parent.createdMs === undefined) return true;
  return child.createdMs >= parent.createdMs;
}

/** Every transitive descendant of rootPid within one snapshot (via ppid), minus excludePids and their subtrees. */
export function descendantsOf(snapshot: Snapshot, rootPid: number, excludePids: number[]): ProcSample[] {
  const exclude = new Set(excludePids);
  const byPid = new Map<number, ProcSample>();
  const byParent = new Map<number, ProcSample[]>();
  for (const p of snapshot.procs) {
    byPid.set(p.pid, p);
    const list = byParent.get(p.ppid);
    if (list === undefined) byParent.set(p.ppid, [p]);
    else list.push(p);
  }
  const out: ProcSample[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of byParent.get(parent) ?? []) {
      // pid reuse can make a ppid chain cyclic; visit each pid once.
      if (visited.has(child.pid) || exclude.has(child.pid)) continue;
      // ... and on Windows a stale ppid can name a newer, unrelated process.
      if (!isChildOf(child, byPid.get(parent))) continue;
      visited.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** rootPid's own ancestors in one snapshot (parent first), following ppid while isChildOf holds. */
export function ancestorsOf(snapshot: Snapshot, rootPid: number): ProcSample[] {
  const byPid = new Map(snapshot.procs.map(p => [p.pid, p] as const));
  const out: ProcSample[] = [];
  const visited = new Set<number>([rootPid]);
  let current = byPid.get(rootPid);
  while (current !== undefined) {
    const parent = byPid.get(current.ppid);
    if (parent === undefined || visited.has(parent.pid) || !isChildOf(current, parent)) break;
    visited.add(parent.pid);
    out.push(parent);
    current = parent;
  }
  return out;
}

/** The largest number of matching descendants seen in any single snapshot. */
export function peak(snapshots: Snapshot[], rootPid: number, exclude: number[], predicate: (p: ProcSample) => boolean): number {
  let max = 0;
  for (const s of snapshots) max = Math.max(max, descendantsOf(s, rootPid, exclude).filter(predicate).length);
  return max;
}

/** Matching descendants, distinct by pid, as first sighted. */
export function seen(snapshots: Snapshot[], rootPid: number, exclude: number[], predicate: (p: ProcSample) => boolean): ProcSample[] {
  const first = new Map<number, ProcSample>();
  for (const s of snapshots) {
    for (const p of descendantsOf(s, rootPid, exclude)) {
      if (!first.has(p.pid) && predicate(p)) first.set(p.pid, p);
    }
  }
  return [...first.values()];
}

/**
 * Matching descendants observed at normal-or-higher priority (lowPriority === false) in a snapshot
 * taken more than graceMs after their first sighting. Windows applies setPriority just after spawn,
 * so a process may legitimately be sampled at normal priority in that window (a documented race).
 */
export function priorityViolations(
  snapshots: Snapshot[],
  rootPid: number,
  exclude: number[],
  predicate: (p: ProcSample) => boolean,
  graceMs = 250,
): ProcSample[] {
  const firstAt = new Map<number, number>();
  const violations = new Map<number, ProcSample>();
  for (const s of snapshots) {
    for (const p of descendantsOf(s, rootPid, exclude)) {
      if (!predicate(p)) continue;
      const first = firstAt.get(p.pid);
      if (first === undefined) {
        firstAt.set(p.pid, s.t);
        continue;
      }
      if (p.lowPriority === false && s.t - first > graceMs && !violations.has(p.pid)) violations.set(p.pid, p);
    }
  }
  return [...violations.values()];
}
