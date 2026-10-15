import { z } from "zod";
import { MODELS, modelInfo, type Rate } from "./routing/models.js";
import { classifierMetadataSchema } from "./routing/classifier-config.js";

export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
export const tokensSchema = z.object({
  inputTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  cachedInputTokens: z.number().finite().nonnegative().default(0),
  cacheReadInputTokens: z.number().finite().nonnegative().optional(),
  cacheWriteInputTokens: z.number().finite().nonnegative().default(0),
});
const jevSchema = z.object({
  isAnswered: z.boolean(),
  inputTokens: z.number().nonnegative(),
  ms: z.number().nonnegative(),
  keyMs: z.number().nonnegative(),
  classifier: classifierMetadataSchema.optional(),
});
export const entrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("route"),
    scope: z.enum(["main", "helper"]),
    route: z.object({ source: z.enum(["jev", "fallback"]) }),
    jev: jevSchema,
    delegation: z
      .object({ delegate: z.boolean(), plan: z.boolean().optional() })
      .optional(),
  }),
  z.object({ type: z.literal("plan"), jev: jevSchema }),
  z.object({
    type: z.literal("usage"),
    model: z.string(),
    nativeSessionId: z.string().optional(),
    usage: z
      .object({
        kind: z.literal("usage"),
        total: tokensSchema.optional(),
        last: tokensSchema.optional(),
        providerTurnId: z.string().optional(),
      })
      .refine((usage) => usage.total !== undefined || usage.last !== undefined),
  }),
]);
export const lineSchema = z.object({
  at: z.number().finite(),
  entry: entrySchema,
});
type Tokens = z.infer<typeof tokensSchema>;
type UsageEntry = Extract<z.infer<typeof entrySchema>, { type: "usage" }>;
type PricedTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
export type RoutingSummary = {
  pricing: { estimated: true; source: string; scope: string };
  records: { accepted: number; ignored: number };
  routes: { main: number; helper: number; fallback: number };
  usageTurns: number;
  unpriced: string[];
  byModel: Record<
    string,
    {
      turns: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      usd: number;
    }
  >;
  modelUsd: number;
  totalUsd: number;
  baselineUsd: Record<string, number>;
  savingsUsd: Record<string, number> | null;
  jev: {
    calls: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    usd: number;
    medianMs: number;
    keyMs: number;
  };
  delegation: { asked: number; advised: number };
};
export const routingSummarySchema = z.object({
  pricing: z.object({
    estimated: z.literal(true),
    source: z.string(),
    scope: z.string(),
  }),
  records: z.object({ accepted: z.number(), ignored: z.number() }),
  routes: z.object({
    main: z.number(),
    helper: z.number(),
    fallback: z.number(),
  }),
  usageTurns: z.number(),
  unpriced: z.array(z.string()),
  byModel: z.record(
    z.string(),
    z.object({
      turns: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheWriteTokens: z.number(),
      usd: z.number(),
    }),
  ),
  modelUsd: z.number(),
  totalUsd: z.number(),
  baselineUsd: z.record(z.string(), z.number()),
  savingsUsd: z.record(z.string(), z.number()).nullable(),
  jev: z.object({
    calls: z.number(),
    failed: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    usd: z.number(),
    medianMs: z.number(),
    keyMs: z.number(),
  }),
  delegation: z.object({ asked: z.number(), advised: z.number() }),
});
const price = (tokens: PricedTokens, rate: Rate) =>
  tokens.input * rate.input +
  tokens.output * rate.output +
  tokens.cacheRead * rate.cacheRead +
  tokens.cacheWrite * rate.cacheWrite;
const normalize = (tokens: Tokens, model: string): PricedTokens => {
  const cacheRead =
    tokens.cacheReadInputTokens ??
    Math.max(0, tokens.cachedInputTokens - tokens.cacheWriteInputTokens);
  const cacheWrite = tokens.cacheWriteInputTokens;
  return {
    input: model.startsWith("gpt-")
      ? Math.max(0, tokens.inputTokens - cacheRead - cacheWrite)
      : tokens.inputTokens,
    output: tokens.outputTokens,
    cacheRead,
    cacheWrite,
  };
};
const subtract = (
  next: PricedTokens,
  previous: PricedTokens,
): PricedTokens => ({
  input: Math.max(0, next.input - previous.input),
  output: Math.max(0, next.output - previous.output),
  cacheRead: Math.max(0, next.cacheRead - previous.cacheRead),
  cacheWrite: Math.max(0, next.cacheWrite - previous.cacheWrite),
});
const emptyTokens = (): PricedTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});
const count = (tokens: PricedTokens) =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

export function summarizeRouting(history: unknown[]): RoutingSummary {
  const summary: RoutingSummary = {
    pricing: {
      estimated: true,
      source:
        "Frozen T3 Code agent rates dated October 2-3, 2026; classifier estimates use the recorded provider rate snapshot.",
      scope:
        "Recorded usage only. Baselines price the same observed tokens on each model and exclude behavior or cache changes.",
    },
    records: { accepted: 0, ignored: 0 },
    routes: { main: 0, helper: 0, fallback: 0 },
    usageTurns: 0,
    unpriced: [],
    byModel: {},
    modelUsd: 0,
    totalUsd: 0,
    baselineUsd: Object.fromEntries(
      Object.keys(MODELS).map((model) => [model, 0]),
    ),
    savingsUsd: null,
    jev: {
      calls: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      medianMs: 0,
      keyMs: 0,
    },
    delegation: { asked: 0, advised: 0 },
  };
  const lines = history
    .flatMap((line) => {
      const parsed = lineSchema.safeParse(line);
      if (!parsed.success) {
        summary.records.ignored++;
        return [];
      }
      summary.records.accepted++;
      return [parsed.data];
    })
    .sort((a, b) => a.at - b.at);
  const timings: number[] = [];
  const usages = new Map<string, { at: number; entry: UsageEntry }>();
  for (const { at, entry } of lines) {
    if (entry.type === "usage") {
      const key = `${entry.nativeSessionId ?? "legacy"}:${entry.usage.providerTurnId ?? `snapshot:${entry.model}:${JSON.stringify(entry.usage)}`}`;
      const prior = usages.get(key);
      const total = entry.usage.total ?? entry.usage.last;
      const priorTotal = prior?.entry.usage.total ?? prior?.entry.usage.last;
      if (
        total &&
        (!priorTotal ||
          count(normalize(total, entry.model)) >=
            count(normalize(priorTotal, entry.model)))
      )
        usages.set(key, { at: prior?.at ?? at, entry });
      continue;
    }
    if (entry.type === "route") {
      summary.routes[entry.scope]++;
      if (entry.route.source === "fallback") summary.routes.fallback++;
      if (entry.delegation) {
        summary.delegation.asked++;
        if (entry.delegation.delegate || entry.delegation.plan)
          summary.delegation.advised++;
      }
    }
    if (
      entry.jev.isAnswered &&
      entry.jev.ms === 0 &&
      entry.jev.inputTokens === 0 &&
      entry.jev.keyMs === 0
    )
      continue;
    summary.jev.calls++;
    if (!entry.jev.isAnswered) summary.jev.failed++;
    summary.jev.inputTokens += entry.jev.inputTokens;
    summary.jev.outputTokens += entry.jev.classifier?.outputTokens ?? 0;
    const classifier = entry.jev.classifier;
    if (classifier === undefined) {
      summary.jev.usd += entry.jev.inputTokens * JEV_USD_PER_INPUT_TOKEN;
    } else if (classifier.estimatedUsd !== null) {
      summary.jev.usd += classifier.estimatedUsd;
    } else {
      const unknown = `classifier:${classifier.provider}:${classifier.model}`;
      if (!summary.unpriced.includes(unknown)) summary.unpriced.push(unknown);
    }
    summary.jev.keyMs += entry.jev.keyMs;
    timings.push(entry.jev.ms);
  }
  const previousBySession = new Map<string, PricedTokens>();
  for (const { entry } of [...usages.values()].sort((a, b) => a.at - b.at)) {
    const model = entry.model.replace(/\[1m\]$/, "");
    const total = entry.usage.total;
    let tokens: PricedTokens;
    if (total) {
      const previous =
        previousBySession.get(entry.nativeSessionId ?? "legacy") ??
        emptyTokens();
      const cumulative = normalize(total, model);
      const reset = count(cumulative) < count(previous);
      tokens = subtract(cumulative, reset ? emptyTokens() : previous);
      previousBySession.set(entry.nativeSessionId ?? "legacy", cumulative);
    } else if (entry.usage.last) tokens = normalize(entry.usage.last, model);
    else continue;
    summary.usageTurns++;
    const info = modelInfo(model);
    if (!info) {
      if (!summary.unpriced.includes(model)) summary.unpriced.push(model);
      continue;
    }
    const usd = price(tokens, info.rate);
    const line = (summary.byModel[model] ??= {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0,
    });
    line.turns++;
    line.inputTokens += tokens.input + tokens.cacheRead + tokens.cacheWrite;
    line.outputTokens += tokens.output;
    line.cacheReadTokens += tokens.cacheRead;
    line.cacheWriteTokens += tokens.cacheWrite;
    line.usd += usd;
    summary.modelUsd += usd;
    for (const [baseline, baselineInfo] of Object.entries(MODELS))
      summary.baselineUsd[baseline] += price(tokens, baselineInfo.rate);
  }
  summary.totalUsd = summary.modelUsd + summary.jev.usd;
  timings.sort((a, b) => a - b);
  const middle = Math.floor(timings.length / 2);
  summary.jev.medianMs =
    timings.length === 0
      ? 0
      : timings.length % 2
        ? timings[middle]!
        : (timings[middle - 1]! + timings[middle]!) / 2;
  if (summary.unpriced.length === 0)
    summary.savingsUsd = Object.fromEntries(
      Object.entries(summary.baselineUsd).map(([model, usd]) => [
        model,
        usd - summary.totalUsd,
      ]),
    );
  return summary;
}
