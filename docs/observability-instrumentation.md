# Moss 监控埋点指南

Moss 的监控埋点埋在 agent 递归调用的天然边界——session（一轮对话）、agent.llm_turn（每次 LLM 推理）、tool.execute（每次工具调用）。三层嵌套天然形成父子 span 树，每轮对话 2-5 个 span，人能读、不爆炸。

## 调用链 + 埋点位置图

```
用户消息进来
  │
  ▼
streamChatViaAgentLoop  (moss-agent.ts)
  │
  ├─ startSpan('session', {runId, model, sessionKey, matchedSkills})   ← 【根 span】moss-agent.ts:1654
  │    │  （sessionSpan 作为 parentSpan 传给整条 run）
  │    │  setAttribute('matchedSkills', ...)  ← skill 命中记这  :1656
  │    │
  │    ├─ withSpan('agent.llm_turn', {turn, model})                    ← 【子 span】agent-loop-llm-call.ts:136
  │    │    │  addEvent('prompt_window', {messages, tools})
  │    │    │  → 调 LLM
  │    │    │  setAttribute(inputTokens/outputTokens)  ← token 记这
  │    │    │
  │    │    │   【metrics 记录】agent-loop-llm-call.ts:199-202(成功) / :225-226(失败)
  │    │    │     llm.calls / llm.tokens(in/out) / llm.duration_ms
  │    │    │
  │    │    └─ LLM 决定调工具时:
  │    │       │
  │    │       └─ withSpan('tool.execute', {toolName, toolCallId, sessionKey})  ← 【孙 span】execute-tool-call.ts:435
  │    │            │  → 跑工具
  │    │            │
  │    │            │   【metrics 记录】execute-tool-call.ts:457-458
  │    │            │     tool.calls / tool.duration_ms
  │    │
  │    └─ (可能多轮 llm_turn + tool.execute)
  │
  ├─ notifyRunObserver  (会话结束收口)                                  ← moss-agent.ts:1374
  │    │  构造 summary {userMessage, outcome, tokens, toolCalls, traceId, aiInsight}
  │    │  → generateAiInsight (拉本轮回来的 trace + LLM 解读/fallback)  :1480
  │    │  → POST /v1/session-summary                                       :1530
  │    │
  │    │   【metrics 记录】moss-agent.ts:1502-1509
  │    │     session.count / session.duration_ms / session.turns
  │
  └─ sessionSpan.end()
```

## trace 埋点（3 层 span）

| 层级 | 位置 | span 名 | 属性 | 为什么埋这 |
|------|------|---------|------|-----------|
| 根 | `moss-agent.ts:1654` | `session` | runId, model, sessionKey, matchedSkills | 一次完整对话的边界，框住整轮，子 span 都挂它下 |
| 子 | `agent-loop-llm-call.ts:136` | `agent.llm_turn` | turn, model, inputTokens, outputTokens | LLM 推理是 agent 循环核心、最慢环节。看每轮耗时+token |
| 孙 | `execute-tool-call.ts:435` | `tool.execute` | toolName, toolCallId, sessionKey | 工具调用是 Moss 做事的地方。看调了啥、多久、成败 |

**父子串联机制**：`moss-agent.ts` 把 sessionSpan 赋给 `run.params.parentSpan`（:1664），agent 循环每层把 parentSpan 传给 `withSpan`（llm_call 传 `params.parentSpan`、tool.execute 传 `deps.parentSpan`）。otel-bridge 的 `OtelSpanState` + `OTEL_STATE` symbol 让子 span 继承父的 traceId + parentSpanId，自动串成树，无需额外 wiring。

**粒度选择**：没在更细处（工具内部、每个 token）埋——会爆炸成千上万 span 不可读。三层正好每轮 2-5 span。

## metrics 埋点（3 类指标，埋在数据产生的源头）

| 类别 | 位置 | 指标 | 维度 | 为什么埋这 |
|------|------|------|------|-----------|
| LLM（成功） | `agent-loop-llm-call.ts:199-202` | llm.calls / llm.tokens(in/out) / llm.duration_ms | model, status, direction | recordLlmUsage 调用点，usage/tokens/duration 全在手边 |
| LLM（失败） | `agent-loop-llm-call.ts:225-226` | llm.calls / llm.duration_ms | model, status=error | catch 块也记，不漏失败 |
| 工具 | `execute-tool-call.ts:457-458` | tool.calls / tool.duration_ms | tool, status | withSpan 之后拿结果那一刻，toolName/duration/isError 已知 |
| 会话 | `moss-agent.ts:1502-1509` | session.count / session.duration_ms / session.turns | outcome | notifyRunObserver 收口，outcome/duration/toolCalls 这时才齐 |

**session.duration_ms 的来源**：复用 trace 的 sessionSpan 起始时间——`getSpanStartTime(run.params.parentSpan)` 算（:1505），不重复计时。

## session 摘要 + AI 解读（1 个收口点）

`notifyRunObserver`（moss-agent.ts:1374）是会话结束的唯一收口：
- 构造 summary（userMessage/outcome/tokens/toolCalls/**traceId**/**aiInsight**）
- 调 `generateAiInsight`（:1480）：拉本轮回来的 trace（`/api/traces/:traceId`）→ LLM 解读 → 失败走规则 fallback（generateRuleInsight）
- POST 给 receiver 的 `/v1/session-summary`

**为什么埋这**：所有结果（outcome/token/工具数/traceId）在会话结束这一刻才齐。AI 解读在这生成（复用本轮回来的 trace + Moss 自己的 LLM）。

## skill 命中（被动埋点，非独立 span）

`moss-agent.ts:1656` 的 `sessionSpan.setAttribute('matchedSkills', ...)`——往 session span 加属性，不是独立 span。skill 匹配发生在 CLI 层（`getMatchedSkillNames`），结果经 `ChatOptions.matchedSkills` 透传到 agent，再 setAttribute。埋 session span 是因为"命中哪些 skill"是会话级属性。

## 数据流

```
trace span 结束 → otel-bridge sendSpan() → fetch POST :4318/v1/traces → SQLite spans 表
metrics → OTel SDK PeriodicExportingMetricReader → POST :4318/v1/metrics → SQLite metrics 表
session 摘要 → notifyRunObserver fetch POST :4318/v1/session-summary → SQLite sessions 表（含 ai_insight）
                                                                                      ↓
                                                              面板 :3000 / Moss inspect_monitoring 工具读
```

trace 用手写 otel-bridge（纯 fetch + OTLP JSON，不依赖官方 SDK），metrics 用官方 OTel SDK（PeriodicExportingMetricReader 批量发）。两者独立开关、互不依赖——trace 没开 metrics 也能记（mossMetrics 有独立 noop 入口）。

## 埋点设计原则

1. **埋在 agent 递归的天然边界**（session/llm_turn/tool.execute），不在更细处——每轮 2-5 span，人能读。
2. **trace 和 metrics 分开埋**——trace 在 span 收发（otel-bridge 管），metrics 在数据源头（各业务点管），独立开关。
3. **跟着既有数据走**——recordLlmUsage 已有 usage、withSpan 已有 duration、notifyRunObserver 已有 outcome，埋点"顺手记"不额外查询。
4. **不侵入业务逻辑**——trace 用 `withSpan` 包裹（不动 fn 体）、metrics 用 `mossMetrics.xxx.add()`（一行调用），改动都是"加几行"非"重构"。

## 已知风险

- metrics 埋点里（如 `agent-loop-llm-call.ts:199` 的 `_llmModel`/`_llmDuration`）耦合业务局部变量——以后改 LLM 调用的变量名/结构，metrics 会静默记错值（不报错）。metrics 记录的值正确性暂无单测覆盖（trace 传播和 inspect 工具有单测）。
- trace 采样在 otel-bridge（`MOSS_TRACE_SAMPLE_RATIO`，traceId-hash 比例，只影响 sendSpan 发送不影响 span 树结构），metrics 不采样（时序指标全采）。
