#!/usr/bin/env node
// Merge istanbul coverage-final.json files produced on different machines
// (Windows + Linux CI runners) and enforce the per-file gate declared in
// vitest.config.ts (MERGED_PER_FILE_GATED / MERGED_PER_FILE_MIN).
//
// Usage: node scripts/coverage-merge.mjs [--warn-only <src/...>]... <out-dir> <coverage-final.json>...
//
// --warn-only <rel>: that gated file is still measured and printed, but a miss prints a GitHub
// `::warning::` instead of failing the gate. CI passes `--warn-only src/verify/exec.ts` when the
// Windows unit input is missing: Linux-only data leaves exec.ts's win32 branches uncovered. Every
// other gated file stays blocking. The path must be one of MERGED_PER_FILE_GATED.
//
// Why not `vitest --merge-reports`: blob reports store absolute source paths
// (e.g. D:\a\...\src\verify\exec.ts vs /home/runner/work/.../src/verify/exec.ts),
// so the same source file from two OSes stays two different files. Here every
// key is rewritten to its repo-relative `src/...` path before merging, then
// resolved against the current checkout. See docs/qa/verification-resource-budget/phase-3.1.md.
//
// Exit code: 0 when every gated file meets the minimum, 1 otherwise, 2 on bad input.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import libCoverage from "istanbul-lib-coverage";

process.env.OMR_COVERAGE_MERGED = "1";
const { MERGED_PER_FILE_GATED, MERGED_PER_FILE_MIN } = await import("../vitest.config.ts");

const USAGE = "usage: node scripts/coverage-merge.mjs [--warn-only <src/...>]... <out-dir> <coverage-final.json>...";
const warnOnly = new Set();
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--warn-only") {
    const rel = argv[++i];
    if (!rel || !MERGED_PER_FILE_GATED.includes(rel)) {
      console.error(`--warn-only needs one of: ${MERGED_PER_FILE_GATED.join(", ")} (got ${rel ?? "nothing"})`);
      process.exit(2);
    }
    warnOnly.add(rel);
  } else if (argv[i].startsWith("--")) {
    console.error(`unknown option ${argv[i]}\n${USAGE}`);
    process.exit(2);
  } else {
    positional.push(argv[i]);
  }
}
const [outDir, ...inputs] = positional;
if (!outDir || inputs.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

/** Repo-relative "src/..." for an absolute path from any OS; null when outside src/. */
function repoRelative(p) {
  const slashed = p.replace(/\\/g, "/");
  const at = slashed.indexOf("/src/");
  return at < 0 ? null : slashed.slice(at + 1);
}

const merged = libCoverage.createCoverageMap({});
const branchCounts = new Map(); // rel -> max branch-path count seen in a single input
for (const input of inputs) {
  const raw = JSON.parse(readFileSync(input, "utf8"));
  let files = 0;
  for (const [key, data] of Object.entries(raw)) {
    const rel = repoRelative(data.path ?? key);
    if (!rel) continue;
    const abs = resolve(rel);
    const fc = libCoverage.createFileCoverage({ ...data, path: abs });
    const count = Object.values(fc.b).reduce((n, arr) => n + arr.length, 0);
    branchCounts.set(rel, Math.max(branchCounts.get(rel) ?? 0, count));
    merged.addFileCoverage(fc);
    files++;
  }
  console.log(`merged ${files} files from ${input}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "coverage-final.json"), JSON.stringify(merged.toJSON()));

let failed = false;
const rows = [];
const warnings = [];
for (const rel of MERGED_PER_FILE_GATED) {
  const abs = resolve(rel);
  const soft = warnOnly.has(rel);
  if (!merged.files().includes(abs)) {
    rows.push(`${rel.padEnd(28)} MISSING from every input${soft ? "  (warn-only)" : ""}`);
    if (soft) warnings.push(`${rel} is missing from every input (warn-only, not blocking)`);
    else failed = true;
    continue;
  }
  const fc = merged.fileCoverageFor(abs);
  const s = fc.toSummary();
  const merges = Object.values(fc.b).reduce((n, arr) => n + arr.length, 0);
  // Location-keyed merge must not grow the branch set: a larger count means the
  // two OSes mapped the same source to different locations (e.g. CRLF drift).
  const drift = merges > (branchCounts.get(rel) ?? 0) ? `  WARN branch map drift ${branchCounts.get(rel)}->${merges}` : "";
  const bad = s.lines.pct < MERGED_PER_FILE_MIN.lines || s.branches.pct < MERGED_PER_FILE_MIN.branches;
  if (bad && soft) {
    warnings.push(
      `${rel} below the per-file gate (lines ${s.lines.pct}%, branches ${s.branches.pct}%); warn-only, not blocking`,
    );
  } else if (bad) {
    failed = true;
  }
  rows.push(
    `${rel.padEnd(28)} lines ${String(s.lines.pct).padStart(6)}% (${s.lines.covered}/${s.lines.total})` +
      `  branches ${String(s.branches.pct).padStart(6)}% (${s.branches.covered}/${s.branches.total})` +
      `${bad ? (soft ? "  WARN (warn-only)" : "  FAIL") : "  ok"}${drift}`,
  );
}
console.log(`\nper-file gate: lines >= ${MERGED_PER_FILE_MIN.lines}%, branches >= ${MERGED_PER_FILE_MIN.branches}%`);
if (warnOnly.size > 0) console.log(`warn-only (not blocking): ${[...warnOnly].join(", ")}`);
for (const row of rows) console.log(row);
for (const w of warnings) console.log(`::warning::${w}`);
if (failed) {
  console.error(`\ncoverage gate FAILED on the merged report (${inputs.length} inputs)`);
  process.exit(1);
}
console.log("\ncoverage gate passed");
