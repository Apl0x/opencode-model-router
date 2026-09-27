#!/usr/bin/env node
// Merge istanbul coverage-final.json files produced on different machines
// (Windows + Linux CI runners) and enforce the per-file gate declared in
// vitest.config.ts (MERGED_PER_FILE_GATED / MERGED_PER_FILE_MIN).
//
// Usage: node scripts/coverage-merge.mjs <out-dir> <coverage-final.json>...
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

const [outDir, ...inputs] = process.argv.slice(2);
if (!outDir || inputs.length === 0) {
  console.error("usage: node scripts/coverage-merge.mjs <out-dir> <coverage-final.json>...");
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
for (const rel of MERGED_PER_FILE_GATED) {
  const abs = resolve(rel);
  if (!merged.files().includes(abs)) {
    rows.push(`${rel.padEnd(28)} MISSING from every input`);
    failed = true;
    continue;
  }
  const fc = merged.fileCoverageFor(abs);
  const s = fc.toSummary();
  const merges = Object.values(fc.b).reduce((n, arr) => n + arr.length, 0);
  // Location-keyed merge must not grow the branch set: a larger count means the
  // two OSes mapped the same source to different locations (e.g. CRLF drift).
  const drift = merges > (branchCounts.get(rel) ?? 0) ? `  WARN branch map drift ${branchCounts.get(rel)}->${merges}` : "";
  const bad = s.lines.pct < MERGED_PER_FILE_MIN.lines || s.branches.pct < MERGED_PER_FILE_MIN.branches;
  if (bad) failed = true;
  rows.push(
    `${rel.padEnd(28)} lines ${String(s.lines.pct).padStart(6)}% (${s.lines.covered}/${s.lines.total})` +
      `  branches ${String(s.branches.pct).padStart(6)}% (${s.branches.covered}/${s.branches.total})` +
      `${bad ? "  FAIL" : "  ok"}${drift}`,
  );
}
console.log(`\nper-file gate: lines >= ${MERGED_PER_FILE_MIN.lines}%, branches >= ${MERGED_PER_FILE_MIN.branches}%`);
for (const row of rows) console.log(row);
if (failed) {
  console.error("\ncoverage gate FAILED on the merged Windows+Linux report");
  process.exit(1);
}
console.log("\ncoverage gate passed");
