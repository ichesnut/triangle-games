#!/usr/bin/env node
// Generates public/deploy-info.json with the deploy timestamp and recent
// commit subjects. Runs before `dev` and `build` so the banner has data
// to display in both dev and production.
//
// In production builds the .git directory may not be present (e.g. when
// running inside a Docker layer that did not COPY .git). In that case we
// still write a file containing the build timestamp so the banner works,
// just without commit details.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, 'public');
const outPath = join(outDir, 'deploy-info.json');

function safeGit(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const deployedAt = new Date().toISOString();
const commit = safeGit('rev-parse --short HEAD');
const commitDate = safeGit('log -1 --pretty=format:%cI');
const log = safeGit("log -5 --no-merges --pretty=format:%s");
const changes = log
  ? log.split('\n').map(s => s.trim()).filter(Boolean)
  : [];

const info = {
  deployedAt,
  commit: commit || null,
  commitDate: commitDate || null,
  changes,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n');

console.log(`Wrote ${outPath} (commit ${commit || 'unknown'}, ${changes.length} changes)`);
