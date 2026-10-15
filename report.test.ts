import test from "node:test";
import assert from "node:assert/strict";
import { summarizeRouting } from "./report.js";
const usage = (
  turn: string,
  input: number,
  output: number,
  read = 0,
  write = 0,
  model = "gpt-6-luna",
  at = 1,
) => ({
  at,
  entry: {
    type: "usage",
    model,
    usage: {
      kind: "usage",
      providerTurnId: turn,
      total: {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: read,
        cacheWriteInputTokens: write,
      },
    },
  },
});
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("alternate classifiers use recorded provider costs and output usage", () => {
  const summary = summarizeRouting([
    {
      at: 1,
      entry: {
        type: "plan",
        jev: {
          isAnswered: true,
          inputTokens: 1000,
          ms: 20,
          keyMs: 0,
          classifier: {
            provider: "openai",
            model: "gpt-4.1-mini",
            outputTokens: 100,
            cacheReadInputTokens: 200,
            estimatedUsd: 0.0005,
            confidenceKind: "categorical",
          },
        },
      },
    },
    {
      at: 2,
      entry: {
        type: "plan",
        jev: {
          isAnswered: true,
          inputTokens: 500,
          ms: 15,
          keyMs: 0,
          classifier: {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            outputTokens: 30,
            cacheReadInputTokens: 0,
            estimatedUsd: 0.00065,
            confidenceKind: "categorical",
          },
        },
      },
    },
  ]);
  assert.equal(summary.jev.calls, 2);
  assert.equal(summary.jev.inputTokens, 1500);
  assert.equal(summary.jev.outputTokens, 130);
  near(summary.jev.usd, 0.00115);
  near(summary.totalUsd, 0.00115);
});

test("unknown classifier prices suppress savings instead of using the Jev rate", () => {
  const summary = summarizeRouting([
    {
      at: 1,
      entry: {
        type: "plan",
        jev: {
          isAnswered: true,
          inputTokens: 1000,
          ms: 20,
          keyMs: 0,
          classifier: {
            provider: "openai",
            model: "gpt-4.1-mini",
            outputTokens: 100,
            cacheReadInputTokens: 0,
            estimatedUsd: null,
            confidenceKind: "categorical",
          },
        },
      },
    },
  ]);
  assert.equal(summary.savingsUsd, null);
  assert.equal(summary.jev.usd, 0);
  assert.deepEqual(summary.unpriced, ["classifier:openai:gpt-4.1-mini"]);
});

test("duplicate cumulative usage snapshots do not double charge", () => {
  const first = usage("one", 1000, 20, 100);
  const second = usage("two", 2500, 30, 400, 0, "gpt-6-luna", 2);
  const summary = summarizeRouting([
    first,
    first,
    second,
    second,
    { ...first, at: 3 },
  ]);
  assert.equal(summary.usageTurns, 2);
  assert.equal(summary.byModel["gpt-6-luna"]?.inputTokens, 2500);
  assert.equal(summary.byModel["gpt-6-luna"]?.outputTokens, 30);
  near(summary.modelUsd, 2100 * 1e-7 + 400 * 1e-8 + 30 * 5e-7);
});

test("later snapshots of the same turn replace earlier cumulative usage", () => {
  const summary = summarizeRouting([
    usage("one", 1000, 10),
    usage("one", 2000, 30, 0, 0, "gpt-6-luna", 2),
  ]);
  assert.equal(summary.usageTurns, 1);
  assert.equal(summary.byModel["gpt-6-luna"]?.inputTokens, 2000);
});

test("Claude input excludes cache while Codex input includes cache", () => {
  const claude = summarizeRouting([
    usage("one", 1000, 100, 200, 300, "claude-opus-5-5"),
  ]);
  near(claude.modelUsd, 1000 * 4e-6 + 100 * 2e-5 + 200 * 2e-7 + 300 * 8e-6);
  assert.equal(claude.byModel["claude-opus-5-5"]?.inputTokens, 1500);
  const codex = summarizeRouting([usage("one", 1000, 100, 200, 300)]);
  near(codex.modelUsd, 500 * 1e-7 + 100 * 5e-7 + 200 * 1e-8 + 300 * 1.25e-7);
});

test("Jev accounting includes failed calls and fallback route counts", () => {
  const summary = summarizeRouting([
    {
      at: 1,
      entry: {
        type: "route",
        scope: "main",
        route: { source: "jev" },
        jev: { isAnswered: true, inputTokens: 1000, ms: 10, keyMs: 20 },
        delegation: { delegate: true },
      },
    },
    {
      at: 2,
      entry: {
        type: "route",
        scope: "helper",
        route: { source: "fallback" },
        jev: { isAnswered: false, inputTokens: 0, ms: 30, keyMs: 0 },
      },
    },
  ]);
  assert.deepEqual(summary.routes, { main: 1, helper: 1, fallback: 1 });
  assert.equal(summary.jev.calls, 2);
  assert.equal(summary.jev.failed, 1);
  assert.equal(summary.jev.medianMs, 20);
  near(summary.jev.usd, (1000 * 0.042) / 1e6);
  assert.equal(summary.delegation.advised, 1);
});

test("unknown models and malformed history suppress savings claims", () => {
  const summary = summarizeRouting([
    usage("one", 100, 10, 0, 0, "unknown"),
    { private: "ignored" },
  ]);
  assert.deepEqual(summary.unpriced, ["unknown"]);
  assert.equal(summary.savingsUsd, null);
  assert.equal(summary.records.ignored, 1);
});

test("real BB ledger counts cumulative Codex totals once", () => {
  const history: unknown[] = [
    {
      at: 1792067828612,
      entry: {
        type: "route",
        scope: "main",
        isFirstPrompt: true,
        description: "Auto provider",
        route: {
          model: "gpt-6-luna",
          effort: "low",
          window: "200k",
          confidence: 0.99,
          source: "jev",
          vote: {
            "gpt-6-luna": 0.99,
            "gpt-6.1-sol": 0,
            "claude-sonnet-5-5": 0.01,
            "claude-opus-5-5": 0,
            "gpt-6-astra": 0,
            "claude-fable-5-1": 0,
          },
        },
        jev: { isAnswered: true, ms: 843, inputTokens: 1580, keyMs: 7026 },
        delegation: { delegate: false, share: 0.93, helper: null },
      },
    },
    {
      at: 1792067837322,
      entry: {
        type: "usage",
        model: "gpt-6-luna",
        usage: {
          kind: "usage",
          total: {
            totalTokens: 23834,
            inputTokens: 23822,
            cachedInputTokens: 1792,
            cacheReadInputTokens: 1792,
            cacheWriteInputTokens: 0,
            outputTokens: 12,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 23834,
            inputTokens: 23822,
            cachedInputTokens: 1792,
            cacheReadInputTokens: 1792,
            cacheWriteInputTokens: 0,
            outputTokens: 12,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258400,
          providerTurnId: "01a13f91-03ab-7ee2-84d3-b0ecb59cc79a",
        },
      },
    },
    {
      at: 1792067895738,
      entry: {
        type: "route",
        scope: "main",
        isFirstPrompt: false,
        description: "Auto provider",
        route: {
          model: "gpt-6-luna",
          effort: "low",
          window: "200k",
          confidence: 0.99,
          source: "jev",
          vote: {
            "gpt-6-luna": 0.99,
            "gpt-6.1-sol": 0,
            "claude-sonnet-5-5": 0.01,
            "claude-opus-5-5": 0,
            "gpt-6-astra": 0,
            "claude-fable-5-1": 0,
          },
        },
        jev: { isAnswered: true, ms: 563, inputTokens: 1113, keyMs: 0 },
        delegation: { delegate: false, share: 0.85, helper: null },
      },
    },
    {
      at: 1792067899649,
      entry: {
        type: "usage",
        model: "gpt-6-luna",
        usage: {
          kind: "usage",
          total: {
            totalTokens: 53656,
            inputTokens: 53638,
            cachedInputTokens: 25088,
            cacheReadInputTokens: 25088,
            cacheWriteInputTokens: 0,
            outputTokens: 18,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 29822,
            inputTokens: 29816,
            cachedInputTokens: 23296,
            cacheReadInputTokens: 23296,
            cacheWriteInputTokens: 0,
            outputTokens: 6,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258400,
          providerTurnId: "01a13f92-01bd-7132-947c-c711aad5c0e1",
        },
      },
    },
  ];
  const summary = summarizeRouting(history);
  assert.equal(summary.byModel["gpt-6-luna"]?.inputTokens, 53638);
  assert.equal(summary.byModel["gpt-6-luna"]?.outputTokens, 18);
  assert.equal(summary.jev.inputTokens, 2693);
});
