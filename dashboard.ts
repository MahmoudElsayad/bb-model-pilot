import { z } from "zod";
import { MODELS, modelInfo } from "./routing/models.js";
import { classifierProviderSchema } from "./routing/classifier-config.js";
import {
  summarizeRouting,
  routingSummarySchema,
  type RoutingSummary,
} from "./report.js";

export const dashboardInputSchema = z
  .object({
    days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]),
    baselineModel: z
      .string()
      .refine(
        (id) => Object.hasOwn(MODELS, id),
        "Select a supported baseline model.",
      ),
    hostId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
  })
  .strict();
export const setupSchema = z.object({
  provider: classifierProviderSchema.default("jev"),
  model: z.string().default("jev-latest"),
  nativeProvider: z.enum(["codex", "claude-code"]).optional(),
  configured: z.boolean(),
  source: z.enum(["setting", "host", "missing"]),
  canValidate: z.boolean(),
});
const tokens = {
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
};
const modelSchema = z.object({
  model: z.string(),
  label: z.string(),
  turns: z.number(),
  ...tokens,
  usd: z.number(),
  share: z.number(),
});
const trendSchema = z.object({
  at: z.number(),
  label: z.string(),
  totalUsd: z.number(),
  baselineUsd: z.number(),
  ...tokens,
  jevUsd: z.number(),
});
const threadSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  helper: z.boolean(),
  updatedAt: z.number(),
  model: z.string().nullable(),
  tokens: z.number(),
  totalUsd: z.number(),
  baselineUsd: z.number(),
  jevCalls: z.number(),
  failures: z.number(),
});
export const dashboardSchema = z.object({
  generatedAt: z.number(),
  startAt: z.number(),
  endAt: z.number(),
  days: z.number(),
  hostId: z.string(),
  baselineModel: z.string(),
  baselineModels: z.array(z.object({ id: z.string(), label: z.string() })),
  summary: routingSummarySchema,
  totals: z.object({
    ...tokens,
    tokens: z.number(),
    sessions: z.number(),
    threads: z.number(),
    helpers: z.number(),
  }),
  trend: z.array(trendSchema),
  models: z.array(modelSchema),
  threads: z.array(threadSchema),
  coverage: z.object({
    scope: z.string(),
    retainedPerSession: z.number(),
    warnings: z.array(z.string()),
  }),
  setup: setupSchema,
  comparison: z.object({
    estimated: z.literal(true),
    baselineUsd: z.number(),
    autoUsd: z.number(),
    differenceUsd: z.number(),
    percent: z.number().nullable(),
    label: z.string(),
  }),
});
export type DashboardData = z.infer<typeof dashboardSchema>;
export const retainedSessionSchema = z.object({
  autoId: z.string(),
  threadId: z.string(),
  helper: z.boolean(),
  updatedAt: z.number(),
  route: z.object({ model: z.string() }).nullable(),
  history: z.array(z.unknown()).max(100),
  truncated: z.boolean(),
});
export type RetainedSession = z.infer<typeof retainedSessionSchema>;
export type PlanHistory = { threadId: string; history: unknown[] };
const datedSchema = z.object({ at: z.number().finite(), entry: z.unknown() });
const sums = (summary: RoutingSummary) =>
  Object.values(summary.byModel).reduce(
    (a, m) => ({
      inputTokens: a.inputTokens + m.inputTokens,
      outputTokens: a.outputTokens + m.outputTokens,
      cacheReadTokens: a.cacheReadTokens + m.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + m.cacheWriteTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  );
function merge(target: RoutingSummary, source: RoutingSummary) {
  target.records.accepted += source.records.accepted;
  target.records.ignored += source.records.ignored;
  target.usageTurns += source.usageTurns;
  target.modelUsd += source.modelUsd;
  target.totalUsd += source.totalUsd;
  for (const key of ["main", "helper", "fallback"] as const)
    target.routes[key] += source.routes[key];
  for (const key of [
    "calls",
    "failed",
    "inputTokens",
    "outputTokens",
    "usd",
    "keyMs",
  ] as const)
    target.jev[key] += source.jev[key];
  target.delegation.asked += source.delegation.asked;
  target.delegation.advised += source.delegation.advised;
  for (const model of source.unpriced)
    if (!target.unpriced.includes(model)) target.unpriced.push(model);
  for (const [model, amount] of Object.entries(source.baselineUsd))
    target.baselineUsd[model] = (target.baselineUsd[model] ?? 0) + amount;
  for (const [model, row] of Object.entries(source.byModel)) {
    const current = (target.byModel[model] ??= {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0,
    });
    for (const key of [
      "turns",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "usd",
    ] as const)
      current[key] += row[key];
  }
}
export function buildDashboard(args: {
  input: z.infer<typeof dashboardInputSchema>;
  hostId: string;
  sessions: RetainedSession[];
  plans: PlanHistory[];
  setup: z.infer<typeof setupSchema>;
  titles: Map<string, string>;
  now?: number;
  warnings?: string[];
}): DashboardData {
  const endAt = args.now ?? Date.now(),
    startAt = endAt - args.input.days * 86400000;
  const bucketMs = args.input.days === 1 ? 3600000 : 86400000;
  const bucketStart = Math.floor(startAt / bucketMs) * bucketMs;
  const trend: DashboardData["trend"] = [];
  for (let at = bucketStart; at <= endAt; at += bucketMs)
    trend.push({
      at,
      label: new Date(at).toISOString(),
      totalUsd: 0,
      baselineUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      jevUsd: 0,
    });
  const summary = summarizeRouting([]),
    threads: DashboardData["threads"] = [];
  const sessions = args.sessions.filter(
    (session) =>
      !args.input.threadId || session.threadId === args.input.threadId,
  );
  const groups = [
    ...sessions.map((session) => ({ session, history: session.history })),
    ...args.plans
      .filter(
        (plan) => !args.input.threadId || plan.threadId === args.input.threadId,
      )
      .map((plan) => ({ session: null, history: plan.history })),
  ];
  for (const group of groups) {
    const history = group.history
      .flatMap((raw) => {
        const line = datedSchema.safeParse(raw);
        return line.success ? [line.data] : [];
      })
      .sort((a, b) => a.at - b.at);
    let previous = summarizeRouting([]),
      selected = summarizeRouting([]);
    const prefix: unknown[] = [];
    const checkpointSessions = new Set<string>();
    for (const line of history) {
      prefix.push(line);
      const next = summarizeRouting(prefix);
      const usageCheckpoint = z
        .object({
          type: z.literal("usage"),
          nativeSessionId: z.string().optional(),
          usage: z.object({ total: z.unknown().optional() }),
        })
        .safeParse(line.entry);
      let excludedCheckpoint = false;
      if (
        group.session?.truncated &&
        usageCheckpoint.success &&
        usageCheckpoint.data.usage.total !== undefined
      ) {
        const identity = usageCheckpoint.data.nativeSessionId ?? "legacy";
        if (!checkpointSessions.has(identity)) {
          checkpointSessions.add(identity);
          excludedCheckpoint = true;
        }
      }
      if (!excludedCheckpoint && line.at >= startAt && line.at <= endAt) {
        const delta = summarizeRouting([]);
        for (const [model, row] of Object.entries(next.byModel)) {
          const before = previous.byModel[model];
          delta.byModel[model] = {
            turns: row.turns - (before?.turns ?? 0),
            inputTokens: row.inputTokens - (before?.inputTokens ?? 0),
            outputTokens: row.outputTokens - (before?.outputTokens ?? 0),
            cacheReadTokens:
              row.cacheReadTokens - (before?.cacheReadTokens ?? 0),
            cacheWriteTokens:
              row.cacheWriteTokens - (before?.cacheWriteTokens ?? 0),
            usd: row.usd - (before?.usd ?? 0),
          };
        }
        delta.modelUsd = next.modelUsd - previous.modelUsd;
        delta.totalUsd = next.totalUsd - previous.totalUsd;
        delta.usageTurns = next.usageTurns - previous.usageTurns;
        delta.records.accepted =
          next.records.accepted - previous.records.accepted;
        delta.records.ignored = next.records.ignored - previous.records.ignored;
        for (const key of ["main", "helper", "fallback"] as const)
          delta.routes[key] = next.routes[key] - previous.routes[key];
        for (const key of [
          "calls",
          "failed",
          "inputTokens",
          "outputTokens",
          "usd",
          "keyMs",
        ] as const)
          delta.jev[key] = next.jev[key] - previous.jev[key];
        delta.unpriced = next.unpriced;
        delta.delegation = {
          asked: next.delegation.asked - previous.delegation.asked,
          advised: next.delegation.advised - previous.delegation.advised,
        };
        for (const model of Object.keys(MODELS))
          delta.baselineUsd[model] =
            (next.baselineUsd[model] ?? 0) - (previous.baselineUsd[model] ?? 0);
        merge(selected, delta);
        const bucket = trend[Math.floor((line.at - bucketStart) / bucketMs)];
        if (bucket) {
          const t = sums(delta);
          bucket.totalUsd += delta.totalUsd;
          bucket.baselineUsd +=
            delta.baselineUsd[args.input.baselineModel] ?? 0;
          bucket.jevUsd += delta.jev.usd;
          for (const key of [
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
          ] as const)
            bucket[key] += t[key];
        }
      }
      previous = next;
    }
    merge(summary, selected);
    if (group.session && selected.records.accepted > 0) {
      const session = group.session,
        t = sums(selected);
      threads.push({
        threadId: session.threadId,
        title: args.titles.get(session.threadId) ?? session.threadId,
        helper: session.helper,
        updatedAt: session.updatedAt,
        model: session.route?.model ?? null,
        tokens: t.inputTokens + t.outputTokens,
        totalUsd: selected.totalUsd,
        baselineUsd: selected.baselineUsd[args.input.baselineModel] ?? 0,
        jevCalls: selected.jev.calls,
        failures: selected.jev.failed,
      });
    }
  }
  const timings = groups
    .flatMap((group) =>
      group.history.flatMap((raw) => {
        const parsed = z
          .object({
            at: z.number(),
            entry: z.object({
              jev: z.object({
                ms: z.number(),
                inputTokens: z.number(),
                keyMs: z.number(),
                isAnswered: z.boolean(),
              }),
            }),
          })
          .safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.at < startAt ||
          parsed.data.at > endAt
        )
          return [];
        const j = parsed.data.entry.jev;
        return j.ms || j.inputTokens || j.keyMs || !j.isAnswered ? [j.ms] : [];
      }),
    )
    .sort((a, b) => a - b);
  const middle = Math.floor(timings.length / 2);
  summary.jev.medianMs =
    timings.length === 0
      ? 0
      : timings.length % 2
        ? timings[middle]!
        : (timings[middle - 1]! + timings[middle]!) / 2;
  summary.savingsUsd = summary.unpriced.length
    ? null
    : Object.fromEntries(
        Object.entries(summary.baselineUsd).map(([model, usd]) => [
          model,
          usd - summary.totalUsd,
        ]),
      );
  const grouped = new Map<string, DashboardData["threads"][number]>();
  for (const row of threads) {
    const prior = grouped.get(row.threadId);
    if (!prior) {
      grouped.set(row.threadId, { ...row });
      continue;
    }
    prior.tokens += row.tokens;
    prior.totalUsd += row.totalUsd;
    prior.baselineUsd += row.baselineUsd;
    prior.jevCalls += row.jevCalls;
    prior.failures += row.failures;
    if (row.updatedAt > prior.updatedAt) {
      prior.updatedAt = row.updatedAt;
      prior.model = row.model;
    }
  }
  const totalTokens = sums(summary),
    baselineUsd = summary.baselineUsd[args.input.baselineModel] ?? 0;
  const warnings = [
    ...(args.warnings ?? []),
    "Only the last 100 retained records per session are available. Older usage can be missing. For truncated sessions, the first retained cumulative usage snapshot per native session is an excluded checkpoint. Totals conservatively exclude that snapshot.",
    "Prices are estimates from the bundled rate snapshot. Agent subscription charges are not measured.",
    "Comparison prices the same observed tokens on another model. It does not measure token reduction or changes in model behavior.",
    "Plan routing before dashboard installation retains only the latest plan per thread.",
    "Failed classifier requests can have unreported usage and are not included in the estimated cost.",
    "Connection tests and CLI route previews do not appear in this dashboard. Providers can charge for those requests.",
  ];
  if (sessions.some((s) => s.truncated))
    warnings.push(
      "Some sessions contain more records than the retained window. Totals exclude cumulative checkpoints and can be incomplete.",
    );
  if (summary.unpriced.length)
    warnings.push(
      "Some recorded models have no bundled rate. Cost estimates exclude their tokens.",
    );
  return {
    generatedAt: endAt,
    startAt,
    endAt,
    days: args.input.days,
    hostId: args.hostId,
    baselineModel: args.input.baselineModel,
    baselineModels: Object.keys(MODELS).map((id) => ({
      id,
      label: modelInfo(id)?.name ?? id,
    })),
    summary,
    totals: {
      ...totalTokens,
      tokens: totalTokens.inputTokens + totalTokens.outputTokens,
      sessions: threads.length,
      threads: new Set(threads.filter((t) => !t.helper).map((t) => t.threadId))
        .size,
      helpers: threads.filter((t) => t.helper).length,
    },
    trend,
    models: Object.entries(summary.byModel)
      .map(([model, row]) => ({
        model,
        label: modelInfo(model)?.name ?? model,
        ...row,
        share: summary.modelUsd ? row.usd / summary.modelUsd : 0,
      }))
      .sort((a, b) => b.usd - a.usd),
    threads: [...grouped.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    coverage: {
      scope:
        "Selected host, retained Auto session records only. Time buckets use UTC.",
      retainedPerSession: 100,
      warnings,
    },
    setup: args.setup,
    comparison: {
      estimated: true,
      baselineUsd,
      autoUsd: summary.totalUsd,
      differenceUsd: baselineUsd - summary.totalUsd,
      percent: baselineUsd
        ? ((baselineUsd - summary.totalUsd) / baselineUsd) * 100
        : null,
      label: "Estimated cost difference using the same observed tokens",
    },
  };
}
