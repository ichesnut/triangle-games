#!/usr/bin/env node
// SonarQube-style code quality report for Triangle Games.
//
// Reads existing c8 coverage output (coverage/coverage-summary.json) plus
// `npm audit --json`, walks the source tree, and emits:
//   - reports/code-quality.md   (human-friendly summary with A-E grades)
//   - reports/code-quality.json (machine-readable)
//
// Zero runtime dependencies. Run after `npm run coverage`.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = join(ROOT, 'reports');

const SOURCE_GLOB = [
  'server',
  'shared',
  'games',
  'admin',
  'public/sw.js',
  'vite.config.js',
  'index.html',
];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.github',
  'data',
  'reports',
  'agents',
  '.claude',
  'tests',
]);

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.html', '.css']);

function walk(dirOrFile, acc = []) {
  const full = join(ROOT, dirOrFile);
  if (!existsSync(full)) return acc;
  const st = statSync(full);
  if (st.isFile()) {
    acc.push(full);
    return acc;
  }
  for (const entry of readdirSync(full)) {
    if (SKIP_DIRS.has(entry)) continue;
    const child = join(full, entry);
    const cst = statSync(child);
    if (cst.isDirectory()) {
      walk(relative(ROOT, child), acc);
    } else if (SOURCE_EXTS.has(extname(entry))) {
      acc.push(child);
    }
  }
  return acc;
}

function extname(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i);
}

function stripStringsAndComments(src) {
  // Best-effort scrub so reliability/smell regexes don't match operators
  // inside string literals or comments. Replaces contents with the same
  // length of dashes to keep line numbers (not strictly required here).
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  s = s.replace(/\/\/[^\n]*/g, (m) => m.replace(/./g, ' '));
  s = s.replace(/'(?:\\.|[^'\\\n])*'/g, "''");
  s = s.replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  s = s.replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``');
  return s;
}

function classifyLines(src) {
  // Returns { code, comment, blank } counts. Approximate: tracks /* */ blocks
  // and // line comments. Treats lines with both code and a trailing // as code.
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlock = false;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      comment++;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '') {
      blank++;
      continue;
    }
    if (line.startsWith('/*')) {
      comment++;
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//')) {
      comment++;
      continue;
    }
    code++;
  }
  return { code, comment, blank };
}

function countMatches(src, re) {
  const m = src.match(re);
  return m ? m.length : 0;
}

function analyseFile(absPath) {
  const src = readFileSync(absPath, 'utf8');
  const rel = relative(ROOT, absPath);
  const ext = extname(rel);
  const isJs = ext === '.js' || ext === '.mjs' || ext === '.cjs';

  const lineCounts = classifyLines(src);
  const total = lineCounts.code + lineCounts.comment + lineCounts.blank;

  let functions = 0;
  let complexity = 0;
  const reliability = [];
  const smells = [];

  if (isJs) {
    const scrubbed = stripStringsAndComments(src);

    // Function-like declarations. Rough but stable.
    functions += countMatches(scrubbed, /\bfunction\b/g);
    functions += countMatches(scrubbed, /=>\s*[({]/g);

    // Cyclomatic complexity proxy: branch keywords + short-circuit operators.
    complexity += countMatches(scrubbed, /\bif\s*\(/g);
    complexity += countMatches(scrubbed, /\belse\s+if\b/g);
    complexity += countMatches(scrubbed, /\bfor\s*\(/g);
    complexity += countMatches(scrubbed, /\bwhile\s*\(/g);
    complexity += countMatches(scrubbed, /\bcase\s+/g);
    complexity += countMatches(scrubbed, /\bcatch\s*\(/g);
    complexity += countMatches(scrubbed, /&&/g);
    complexity += countMatches(scrubbed, /\|\|/g);
    complexity += countMatches(scrubbed, /\?[^.?:]/g);

    // Reliability signals (likely bugs). Scan the scrubbed source so SQL/CSS
    // strings don't trigger false positives. `== null` / `!= null` (and
    // `undefined`) are widely-accepted idioms for "nullish check" and are
    // not flagged by SonarQube either.
    const looseEqRe = /([^=!<>])(==|!=)(?!=)\s*(\w+)/g;
    let m;
    let looseEq = 0;
    while ((m = looseEqRe.exec(scrubbed)) !== null) {
      const rhs = m[3];
      if (rhs === 'null' || rhs === 'undefined') continue;
      looseEq++;
    }
    // Also catch `<thing> == <expr>` where rhs starts with a non-word char.
    const looseEqNonWord = countMatches(scrubbed, /[^=!<>](==|!=)(?!=)\s*[^\w\s]/g);
    looseEq += looseEqNonWord;
    if (looseEq > 0) reliability.push({ file: rel, kind: 'loose-equality', count: looseEq });

    const varUses = countMatches(scrubbed, /^\s*var\s+/gm);
    if (varUses > 0) reliability.push({ file: rel, kind: 'var-declaration', count: varUses });

    // Maintainability signals (code smells). SonarQube classifies these as
    // smells, not bugs.
    const emptyCatch = countMatches(scrubbed, /catch\s*\([^)]*\)\s*\{\s*\}/g);
    if (emptyCatch > 0) smells.push({ file: rel, kind: 'empty-catch', count: emptyCatch });

    const todos = countMatches(src, /\b(?:TODO|FIXME|HACK|XXX)\b/g);
    if (todos > 0) smells.push({ file: rel, kind: 'todo-marker', count: todos });

    const consoleLogs = countMatches(scrubbed, /\bconsole\.(?:log|debug)\s*\(/g);
    if (consoleLogs > 0) smells.push({ file: rel, kind: 'console-log', count: consoleLogs });
  }

  return {
    path: rel,
    ext,
    isJs,
    total,
    code: lineCounts.code,
    comment: lineCounts.comment,
    blank: lineCounts.blank,
    functions,
    complexity,
    reliability,
    smells,
    src: isJs ? src : null,
  };
}

function findDuplicates(files, windowSize = 6) {
  // Sliding-window hash of normalised non-trivial lines. Reports the unique
  // duplicate blocks (each block counted once) plus total duplicated lines.
  const buckets = new Map();
  for (const f of files) {
    if (!f.src) continue;
    const lines = f.src.split('\n').map((l) => l.trim()).filter((l) => l.length > 4 && !l.startsWith('//'));
    for (let i = 0; i + windowSize <= lines.length; i++) {
      const key = lines.slice(i, i + windowSize).join('\n');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ file: f.path, line: i });
    }
  }
  let duplicatedBlocks = 0;
  let duplicatedLines = 0;
  const examples = [];
  for (const [key, occurrences] of buckets) {
    if (occurrences.length < 2) continue;
    duplicatedBlocks++;
    duplicatedLines += windowSize * (occurrences.length - 1);
    if (examples.length < 5) {
      examples.push({ window: windowSize, occurrences: occurrences.slice(0, 4), preview: key.split('\n')[0] });
    }
  }
  return { duplicatedBlocks, duplicatedLines, windowSize, examples };
}

function readCoverage() {
  const p = join(ROOT, 'coverage', 'coverage-summary.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j.total ?? null;
  } catch {
    return null;
  }
}

function readAudit() {
  // Run `npm audit --json`. Non-zero exit is normal when vulns exist; capture
  // stdout regardless.
  try {
    const out = execSync('npm audit --json', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    });
    return JSON.parse(out);
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout.toString());
      } catch {
        return { error: 'audit-output-unparseable' };
      }
    }
    return { error: err.code === 'ETIMEDOUT' ? 'audit-timeout' : 'audit-failed' };
  }
}

function gradeReliability(bugCount) {
  if (bugCount === 0) return 'A';
  if (bugCount <= 3) return 'B';
  if (bugCount <= 10) return 'C';
  if (bugCount <= 25) return 'D';
  return 'E';
}

function gradeSecurity(audit) {
  if (!audit || audit.error) return 'C';
  const sev = audit.metadata?.vulnerabilities ?? {};
  if (sev.critical > 0) return 'E';
  if (sev.high > 0) return 'D';
  if (sev.moderate > 0) return 'C';
  if (sev.low > 0) return 'B';
  return 'A';
}

function gradeCoverage(pct) {
  if (pct >= 85) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 30) return 'D';
  return 'E';
}

function gradeMaintainability(smellRatio) {
  // smells per KLOC of source code
  if (smellRatio < 5) return 'A';
  if (smellRatio < 10) return 'B';
  if (smellRatio < 20) return 'C';
  if (smellRatio < 50) return 'D';
  return 'E';
}

function gradeDuplication(pct) {
  if (pct < 3) return 'A';
  if (pct < 5) return 'B';
  if (pct < 10) return 'C';
  if (pct < 20) return 'D';
  return 'E';
}

function build() {
  const files = [];
  for (const root of SOURCE_GLOB) files.push(...walk(root));
  const analyses = files.map(analyseFile);

  const jsAnalyses = analyses.filter((a) => a.isJs);

  const totals = {
    files: analyses.length,
    jsFiles: jsAnalyses.length,
    linesTotal: analyses.reduce((s, a) => s + a.total, 0),
    linesCode: analyses.reduce((s, a) => s + a.code, 0),
    linesComment: analyses.reduce((s, a) => s + a.comment, 0),
    linesBlank: analyses.reduce((s, a) => s + a.blank, 0),
    functions: jsAnalyses.reduce((s, a) => s + a.functions, 0),
    complexity: jsAnalyses.reduce((s, a) => s + a.complexity, 0),
  };

  const reliabilityIssues = analyses.flatMap((a) => a.reliability);
  const smellIssues = analyses.flatMap((a) => a.smells);

  const largeFiles = jsAnalyses.filter((a) => a.code > 400).map((a) => ({
    file: a.path,
    code: a.code,
    kind: 'large-file',
  }));
  for (const lf of largeFiles) smellIssues.push(lf);

  const complexFiles = jsAnalyses.filter((a) => a.complexity > 50).map((a) => ({
    file: a.path,
    complexity: a.complexity,
    kind: 'complex-file',
  }));
  for (const cf of complexFiles) smellIssues.push(cf);

  const bugs = reliabilityIssues.reduce((s, i) => s + i.count, 0);
  const smells = smellIssues.reduce((s, i) => s + (i.count ?? 1), 0);

  const dup = findDuplicates(jsAnalyses);
  const dupPct = totals.linesCode > 0 ? (dup.duplicatedLines / totals.linesCode) * 100 : 0;

  const coverage = readCoverage();
  const audit = readAudit();
  const vulns = audit?.metadata?.vulnerabilities ?? {};

  const smellRatio = totals.linesCode > 0 ? (smells / totals.linesCode) * 1000 : 0;
  const linesPct = coverage?.lines?.pct ?? 0;

  const grades = {
    reliability: gradeReliability(bugs),
    security: gradeSecurity(audit),
    maintainability: gradeMaintainability(smellRatio),
    coverage: gradeCoverage(linesPct),
    duplication: gradeDuplication(dupPct),
  };

  const top10Complex = [...jsAnalyses]
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 10)
    .map((a) => ({ file: a.path, complexity: a.complexity, code: a.code, functions: a.functions }));

  const top10Largest = [...jsAnalyses]
    .sort((a, b) => b.code - a.code)
    .slice(0, 10)
    .map((a) => ({ file: a.path, code: a.code, functions: a.functions }));

  return {
    generatedAt: new Date().toISOString(),
    grades,
    summary: {
      bugs,
      vulnerabilities: vulns,
      codeSmells: smells,
      smellsPerKloc: Number(smellRatio.toFixed(2)),
      duplicatedLines: dup.duplicatedLines,
      duplicatedBlocks: dup.duplicatedBlocks,
      duplicationPct: Number(dupPct.toFixed(2)),
      coverage: coverage
        ? {
            lines: coverage.lines.pct,
            statements: coverage.statements.pct,
            functions: coverage.functions.pct,
            branches: coverage.branches.pct,
          }
        : null,
      ...totals,
    },
    reliabilityIssues,
    codeSmellIssues: smellIssues,
    duplication: dup,
    audit: audit?.error
      ? { error: audit.error }
      : {
          vulnerabilities: vulns,
          totalDependencies: audit.metadata?.dependencies?.total,
          dependencies: audit.metadata?.dependencies,
        },
    hotspots: {
      mostComplex: top10Complex,
      largest: top10Largest,
    },
  };
}

function gradeBadge(g) {
  const color = { A: '🟢', B: '🟢', C: '🟡', D: '🟠', E: '🔴' }[g] ?? '⚪';
  return `${color} ${g}`;
}

function renderMarkdown(r) {
  const cov = r.summary.coverage;
  const v = r.summary.vulnerabilities ?? {};
  const lines = [];
  lines.push('# Code Quality Report');
  lines.push('');
  lines.push(`_Generated ${r.generatedAt}_`);
  lines.push('');
  lines.push('## Quality Gate');
  lines.push('');
  lines.push('| Category | Grade | Detail |');
  lines.push('| --- | --- | --- |');
  lines.push(`| Reliability | ${gradeBadge(r.grades.reliability)} | ${r.summary.bugs} bug(s) |`);
  lines.push(
    `| Security | ${gradeBadge(r.grades.security)} | ` +
      `${v.critical ?? 0} critical, ${v.high ?? 0} high, ${v.moderate ?? 0} moderate, ${v.low ?? 0} low |`,
  );
  lines.push(
    `| Maintainability | ${gradeBadge(r.grades.maintainability)} | ${r.summary.codeSmells} smell(s), ${r.summary.smellsPerKloc}/KLOC |`,
  );
  lines.push(
    `| Coverage | ${gradeBadge(r.grades.coverage)} | ${cov ? `${cov.lines.toFixed(2)}% lines, ${cov.branches.toFixed(2)}% branches` : 'no coverage data'} |`,
  );
  lines.push(
    `| Duplication | ${gradeBadge(r.grades.duplication)} | ${r.summary.duplicationPct}% (${r.summary.duplicatedLines} lines across ${r.summary.duplicatedBlocks} blocks, ${r.duplication.windowSize}-line window) |`,
  );
  lines.push('');
  lines.push('## Size');
  lines.push('');
  lines.push(`- **Files:** ${r.summary.files} (${r.summary.jsFiles} JS)`);
  lines.push(`- **Lines:** ${r.summary.linesTotal} total, ${r.summary.linesCode} code, ${r.summary.linesComment} comments, ${r.summary.linesBlank} blank`);
  lines.push(`- **Functions:** ${r.summary.functions}`);
  lines.push(`- **Cyclomatic complexity (sum):** ${r.summary.complexity}`);
  lines.push('');

  if (cov) {
    lines.push('## Coverage');
    lines.push('');
    lines.push('| Metric | Coverage |');
    lines.push('| --- | --- |');
    lines.push(`| Lines | ${cov.lines.toFixed(2)}% |`);
    lines.push(`| Statements | ${cov.statements.toFixed(2)}% |`);
    lines.push(`| Functions | ${cov.functions.toFixed(2)}% |`);
    lines.push(`| Branches | ${cov.branches.toFixed(2)}% |`);
    lines.push('');
    lines.push('<sub>Threshold: 85% lines/functions/statements, 75% branches (.c8rc.json).</sub>');
    lines.push('');
  } else {
    lines.push('## Coverage');
    lines.push('');
    lines.push('No coverage data found. Run `npm run coverage` first.');
    lines.push('');
  }

  lines.push('## Reliability — Potential Bugs');
  lines.push('');
  if (r.reliabilityIssues.length === 0) {
    lines.push('_No reliability issues detected._');
  } else {
    lines.push('| File | Kind | Count |');
    lines.push('| --- | --- | --- |');
    for (const issue of r.reliabilityIssues) {
      lines.push(`| \`${issue.file}\` | ${issue.kind} | ${issue.count} |`);
    }
  }
  lines.push('');

  lines.push('## Security — npm audit');
  lines.push('');
  if (r.audit.error) {
    lines.push(`_npm audit unavailable: ${r.audit.error}_`);
  } else {
    lines.push(`Dependencies scanned: **${r.audit.totalDependencies ?? 'n/a'}**`);
    lines.push('');
    lines.push('| Severity | Count |');
    lines.push('| --- | --- |');
    for (const sev of ['critical', 'high', 'moderate', 'low', 'info']) {
      lines.push(`| ${sev} | ${v[sev] ?? 0} |`);
    }
  }
  lines.push('');

  lines.push('## Maintainability — Code Smells');
  lines.push('');
  if (r.codeSmellIssues.length === 0) {
    lines.push('_No code smells detected._');
  } else {
    const byKind = new Map();
    for (const s of r.codeSmellIssues) {
      const k = s.kind;
      const count = s.count ?? 1;
      byKind.set(k, (byKind.get(k) ?? 0) + count);
    }
    lines.push('| Kind | Total |');
    lines.push('| --- | --- |');
    for (const [kind, count] of byKind) {
      lines.push(`| ${kind} | ${count} |`);
    }
    lines.push('');
    lines.push('<details><summary>Per-file detail</summary>');
    lines.push('');
    lines.push('| File | Kind | Count/Size |');
    lines.push('| --- | --- | --- |');
    for (const s of r.codeSmellIssues) {
      const detail = s.count ?? s.code ?? s.complexity ?? '';
      lines.push(`| \`${s.file}\` | ${s.kind} | ${detail} |`);
    }
    lines.push('');
    lines.push('</details>');
  }
  lines.push('');

  lines.push('## Duplication');
  lines.push('');
  if (r.duplication.duplicatedBlocks === 0) {
    lines.push('_No duplicated blocks detected._');
  } else {
    lines.push(`${r.duplication.duplicatedBlocks} duplicated block(s) of ${r.duplication.windowSize}+ lines.`);
    lines.push('');
    lines.push('| Example | Locations |');
    lines.push('| --- | --- |');
    for (const ex of r.duplication.examples) {
      const locs = ex.occurrences.map((o) => `\`${o.file}:${o.line + 1}\``).join('<br>');
      lines.push(`| \`${ex.preview.slice(0, 80).replace(/\|/g, '\\|')}\` | ${locs} |`);
    }
  }
  lines.push('');

  lines.push('## Hotspots');
  lines.push('');
  lines.push('### Most complex files');
  lines.push('');
  lines.push('| File | Cyclomatic complexity | LOC | Functions |');
  lines.push('| --- | --- | --- | --- |');
  for (const h of r.hotspots.mostComplex) {
    lines.push(`| \`${h.file}\` | ${h.complexity} | ${h.code} | ${h.functions} |`);
  }
  lines.push('');
  lines.push('### Largest files');
  lines.push('');
  lines.push('| File | LOC | Functions |');
  lines.push('| --- | --- | --- |');
  for (const h of r.hotspots.largest) {
    lines.push(`| \`${h.file}\` | ${h.code} | ${h.functions} |`);
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('<sub>Generated by `scripts/quality-report.mjs`. SonarQube-style metrics, zero deps. Coverage from c8 (`npm run coverage`); security from `npm audit`.</sub>');
  return lines.join('\n');
}

function main() {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const report = build();
  writeFileSync(join(REPORT_DIR, 'code-quality.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(REPORT_DIR, 'code-quality.md'), renderMarkdown(report));

  const g = report.grades;
  const worstOrder = ['E', 'D', 'C', 'B', 'A'];
  const worst = worstOrder.find((grade) => Object.values(g).includes(grade));
  // eslint-disable-next-line no-console
  console.log(
    `Quality report written to reports/code-quality.md\n` +
      `  Reliability ${g.reliability} | Security ${g.security} | Maintainability ${g.maintainability} | Coverage ${g.coverage} | Duplication ${g.duplication}\n` +
      `  Worst grade: ${worst}`,
  );

  const exitOnE = process.argv.includes('--fail-on-e');
  if (exitOnE && worst === 'E') process.exit(1);
}

main();
