import type { Tool } from '../core/tools/tool-types.js';
import { getOtelUrl } from '../observability/index.js';

const STATUS = (s: string) => (s === 'error' ? '❌' : '✓');

/**
 * inspect_monitoring — let Moss read its own monitoring data.
 *
 * Pulls the latest session + its trace tree + recent metrics from the OTLP
 * receiver (same URL tracing uses), returns a structured text summary so the
 * LLM can answer "what happened in the last turn / why was it slow / why failed".
 * Best-effort: degrades gracefully when tracing is off, receiver is down,
 * or there's no data yet.
 */
export const inspectMonitoringTool: Tool = {
  name: 'inspect_monitoring',
  description:
    '查最近一轮 Moss 对话的监控数据(trace/metrics/AI解读)。用于回答"刚才那轮为什么慢/失败/调了什么工具"之类的问题。无参数,返回最近一轮全貌。',
  inputSchema: { type: 'object', properties: {} },
  async execute(_input, _ctx) {
    try {
      const otelUrl = getOtelUrl();
      if (!otelUrl) {
        return '未启用监控(MOSS_OTEL_ENABLED 没设),无数据可查。';
      }
      const base = otelUrl.replace(/\/v1\/traces\/?$/, '');
      const withTimeout = (u: string) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        return fetch(u, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      };

      // 1. latest session
      const sRes = await withTimeout(`${base}/api/sessions`);
      if (!sRes.ok) return '监控不可用(receiver 未在跑或 /api/sessions 无响应)。';
      const sData = (await sRes.json()) as { sessions?: Array<Record<string, unknown>> };
      const session = sData.sessions?.[0] as Record<string, unknown> | undefined;
      if (!session) return '还没有监控数据,先跑一轮对话。';

      // 2. trace tree for this session's traceId
      let traceLines = '(无 trace)';
      const traceId = session.traceId as string | undefined;
      if (traceId) {
        try {
          const tRes = await withTimeout(`${base}/api/traces/${traceId}`);
          if (tRes.ok) {
            const tData = (await tRes.json()) as { traces?: Array<Record<string, unknown>> };
            const spans = (tData.traces ?? []) as Array<Record<string, unknown>>;
            if (spans.length > 0) {
              const byId = new Map(spans.map((s) => [s.spanId, s] as const));
              const roots = spans.filter((s) => {
                const p = s.parentSpanId;
                return !p || !byId.has(p);
              });
              const walk = (s: Record<string, unknown>, depth: number): string => {
                const a = (s.attrs ?? {}) as Record<string, unknown>;
                const bits = [`${s.name}(${STATUS(String(s.status))}, ${s.duration}ms)`];
                if (s.toolName) bits.push(`tool=${s.toolName}`);
                if (a.turn != null) bits.push(`turn=${a.turn}`);
                if (a.inputTokens != null) bits.push(`in=${a.inputTokens}/out=${a.outputTokens}`);
                if (s.statusMessage) bits.push(`err=${String(s.statusMessage).slice(0, 60)}`);
                const kids = spans.filter((c) => c.parentSpanId === s.spanId);
                const kidsStr = kids.map((c) => walk(c, depth + 1)).join('');
                return '  '.repeat(depth) + (depth > 0 ? '└─ ' : '') + bits.join(' ') + '\n' + kidsStr;
              };
              traceLines = roots.map((r) => walk(r, 0)).join('').trim();
            }
          }
        } catch {
          // trace fetch failed — leave "(无 trace)"
        }
      }

      // 3. recent metrics summary
      let metricsLine = '(无 metrics)';
      try {
        const mRes = await withTimeout(`${base}/api/metrics`);
        if (mRes.ok) {
          const mData = (await mRes.json()) as { metrics?: Array<Record<string, unknown>> };
          const ms = (mData.metrics ?? []) as Array<Record<string, unknown>>;
          const lastIn = ms.filter((m) => m.name === 'moss.llm.tokens' && (m.attrs as Record<string, unknown>)?.direction === 'input').pop();
          const lastOut = ms.filter((m) => m.name === 'moss.llm.tokens' && (m.attrs as Record<string, unknown>)?.direction === 'output').pop();
          const lastTool = ms.filter((m) => m.name === 'moss.tool.calls').pop();
          const sessMetrics = ms.filter((m) => m.name === 'moss.session.count');
          const errs = ms.filter((m) => m.name === 'moss.session.count' && (m.attrs as Record<string, unknown>)?.outcome === 'error').length;
          const parts: string[] = [];
          if (lastIn || lastOut) parts.push(`最近 token: in=${lastIn?.value ?? '?'}/out=${lastOut?.value ?? '?'}`);
          if (lastTool) parts.push(`最近工具: ${(lastTool.attrs as Record<string, unknown>)?.tool ?? '?'}(${lastTool.value})`);
          if (sessMetrics.length) parts.push(`会话数: ${sessMetrics.length}  错误: ${errs}`);
          metricsLine = parts.join('  ');
        }
      } catch {
        // metrics fetch failed — leave "(无 metrics)"
      }

      const lines = [
        '最近一轮监控:',
        `- 用户问: ${String(session.userMessage ?? '').slice(0, 200)}`,
        `- 结果: ${session.outcome ?? '?'}`,
        `- 🔍 AI解读: ${session.aiInsight ?? '(无)'}`,
        '- trace 树:',
        traceLines,
        '- metrics 概要:',
        `  ${metricsLine}`,
      ];
      return lines.join('\n');
    } catch (e) {
      return `查监控失败: ${String(e).slice(0, 120)}`;
    }
  },
};
