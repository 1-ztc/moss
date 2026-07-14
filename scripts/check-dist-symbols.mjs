#!/usr/bin/env node
/**
 * check-dist-symbols — verify build artifacts actually contain the symbols
 * we wrote in src. Catches the case where a linter/formatter silently strips
 * code from src (or a file fails to compile in) but `npm run build` still
 * exits 0 because the rest compiled fine.
 *
 * Run after `npm run build`. Exits non-zero if any expected symbol is missing
 * from dist.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'packages/moss-agent/dist';

// [file (relative to dist), symbol that must appear in it]
const expected = [
  ['tools/inspect-monitoring.js', 'inspectMonitoringTool'],
  ['tools/inspect-monitoring.js', 'inspect_monitoring'],
  ['tools/builtin.js', 'inspectMonitoringTool'],
  ['observability/otel-bridge.js', 'getSpanTraceId'],
  ['observability/otel-bridge.js', 'enableOtelTracing'],
  ['observability/index.js', 'getSpanTraceId'],
  ['core/agent/moss-agent.js', 'generateAiInsight'],
  ['core/agent/moss-agent.js', 'getSpanTraceId'],
];

let missing = [];
for (const [relPath, symbol] of expected) {
  const full = join(dist, relPath);
  if (!existsSync(full)) {
    missing.push(`${relPath}: file missing (build did not emit it)`);
    continue;
  }
  const content = readFileSync(full, 'utf8');
  if (!content.includes(symbol)) {
    missing.push(`${relPath}: symbol "${symbol}" not in dist (linter may have stripped from src)`);
  }
}

if (missing.length > 0) {
  console.error('[check-dist-symbols] FAIL — build artifacts missing expected symbols:');
  for (const m of missing) console.error('  - ' + m);
  console.error('\nThis means src code was lost (linter/formatter) or a file did not compile into dist.');
  process.exit(1);
}

console.log('[check-dist-symbols] OK — all expected monitoring symbols present in dist.');
