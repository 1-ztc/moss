#!/usr/bin/env node
/**
 * inspect_monitoring 工具测试 — 验证拉数据/拼文本/降级。
 *
 * 起一个 fixture receiver 全程在跑,每测试改 fixture 数据,调工具 execute。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspectMonitoringTool } from '../dist/tools/inspect-monitoring.js';

const FIXTURE_PORT = 14999;
let fixture = { sessions: [], traces: [], metrics: [] };

// 全程一个 fixture server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/sessions') return res.end(JSON.stringify({ sessions: fixture.sessions }));
  if (req.url.startsWith('/api/traces/')) return res.end(JSON.stringify({ traces: fixture.traces }));
  if (req.url.startsWith('/api/metrics')) return res.end(JSON.stringify({ metrics: fixture.metrics }));
  res.writeHead(404).end();
});

await new Promise((r) => server.listen(FIXTURE_PORT, r));

// enableOtelTracing once so getOtelUrl() returns our fixture base.
const { enableOtelTracing } = await import('../dist/observability/otel-bridge.js');
enableOtelTracing({ url: `http://localhost:${FIXTURE_PORT}/v1/traces` });

async function callTool() {
  return inspectMonitoringTool.execute({}, {});
}

test('正常会话:返回 trace 树 + 工具 + AI解读', async () => {
  fixture = {
    sessions: [{
      sessionKey: 'k1', traceId: 't1', userMessage: '查分支', outcome: 'completed',
      aiInsight: '调了git_branch', toolCalls: 1, tokensIn: 100, tokensOut: 50,
    }],
    traces: [
      { name: 'session', spanId: 's1', traceId: 't1', status: 'ok', duration: 5000 },
      { name: 'agent.llm_turn', spanId: 's2', parentSpanId: 's1', traceId: 't1', status: 'ok', duration: 3000, attrs: { turn: 1, inputTokens: 100, outputTokens: 50 } },
      { name: 'tool.execute', spanId: 's3', parentSpanId: 's2', traceId: 't1', status: 'ok', duration: 40, toolName: 'git_branch' },
    ],
    metrics: [
      { name: 'moss.llm.tokens', value: 100, attrs: { direction: 'input' } },
      { name: 'moss.llm.tokens', value: 50, attrs: { direction: 'output' } },
      { name: 'moss.tool.calls', value: 1, attrs: { tool: 'git_branch' } },
      { name: 'moss.session.count', value: 1, attrs: { outcome: 'completed' } },
    ],
  };
  const out = await callTool();
  assert.match(out, /查分支/);
  assert.match(out, /completed/);
  assert.match(out, /调了git_branch/);
  assert.match(out, /git_branch/);
  assert.match(out, /trace 树/);
});

test('空 session:提示先跑一轮', async () => {
  fixture = { sessions: [], traces: [], metrics: [] };
  const out = await callTool();
  assert.match(out, /还没有监控数据/);
});

test('session.traceId 空:trace 段为(无 trace)', async () => {
  fixture = {
    sessions: [{ sessionKey: 'k1', traceId: undefined, userMessage: 'x', outcome: 'completed' }],
    traces: [], metrics: [],
  };
  const out = await callTool();
  assert.match(out, /\(无 trace\)/);
});

// 关 server 让进程退出
test.after(() => server.close());
