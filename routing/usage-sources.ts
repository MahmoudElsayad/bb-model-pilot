/**
 * Where subscription usage comes from. Codex answers on request through its app server. Claude
 * Code has no such request, so the bridge records the usage reports that BB sends during each
 * turn, and the router reads the latest one.
 *
 * @module routing/usage-sources
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { current, type ProviderUsage } from "./usage.js";

/** A Codex window or the spend cap counts as near its limit at this share used. */
const NEAR_LIMIT_PERCENT = 80;
/** A Codex read is reused this long, so routing asks the app server at most once per period. */
const CODEX_CACHE_MS = 2 * 60_000;
const CODEX_TIMEOUT_MS = 8_000;

const windowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable().optional(),
    resetsAt: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

const codexLimitsSchema = z.object({
  primary: windowSchema,
  secondary: windowSchema,
  individualLimit: z
    .object({ remainingPercent: z.number(), resetsAt: z.number().nullable().optional() })
    .nullable()
    .optional(),
  spendControlReached: z.boolean().nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
});

/** The reply to the Codex app server's `account/rateLimits/read`. */
export const codexRateLimitsReplySchema = z.object({ rateLimits: codexLimitsSchema });

const windowName = (minutes: number | null | undefined): string =>
  minutes === 10_080 ? "weekly limit" : minutes === 300 ? "five-hour limit" : "usage limit";

const REACHED_REASONS: Record<string, string> = {
  workspace_owner_credits_depleted: "the workspace credits are used up",
  workspace_member_credits_depleted: "the workspace credits are used up",
};

/** Codex's own report as usage: blocked at a reached limit, near its limit from 80% used. */
export function codexUsage(reply: z.infer<typeof codexRateLimitsReplySchema>, now: number): ProviderUsage {
  const limits = reply.rateLimits;
  const windows = [limits.primary, limits.secondary].flatMap((window) => window ?? []);
  const seconds = (value: number | null | undefined) => (value == null ? null : value * 1000);
  const full = windows.filter((window) => window.usedPercent >= 100);
  if (limits.spendControlReached === true || limits.rateLimitReachedType != null) {
    const resets = [
      ...(limits.spendControlReached === true ? [seconds(limits.individualLimit?.resetsAt)] : []),
      ...full.map((window) => seconds(window.resetsAt)),
    ].flatMap((value) => value ?? []);
    const reason =
      limits.spendControlReached === true
        ? "the spend cap is used up"
        : (REACHED_REASONS[limits.rateLimitReachedType ?? ""] ??
          `the ${windowName(full[0]?.windowDurationMins)} is reached`);
    return {
      provider: "codex",
      status: "blocked",
      reason,
      resetsAtMs: resets.length === 0 ? null : Math.max(...resets),
      checkedAtMs: now,
    };
  }
  const busiest = windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const capUsed = limits.individualLimit == null ? 0 : 100 - limits.individualLimit.remainingPercent;
  if (capUsed >= NEAR_LIMIT_PERCENT && capUsed >= (busiest?.usedPercent ?? 0))
    return {
      provider: "codex",
      status: "warning",
      reason: `${Math.round(capUsed)}% of the spend cap is used`,
      resetsAtMs: seconds(limits.individualLimit?.resetsAt),
      checkedAtMs: now,
    };
  if (busiest !== undefined && busiest.usedPercent >= NEAR_LIMIT_PERCENT)
    return {
      provider: "codex",
      status: "warning",
      reason: `${Math.round(busiest.usedPercent)}% of the ${windowName(busiest.windowDurationMins)} is used`,
      resetsAtMs: seconds(busiest.resetsAt),
      checkedAtMs: now,
    };
  return { provider: "codex", status: "allowed", reason: null, resetsAtMs: null, checkedAtMs: now };
}

/** BB's usage report for a provider, as a turn delta carries it. */
export const bbRateLimitsSchema = z.object({
  providerId: z.string(),
  status: z.enum(["allowed", "warning", "blocked", "unknown"]),
  kind: z.string(),
  windows: z.array(
    z.object({
      label: z.string().nullable(),
      status: z.enum(["allowed", "warning", "blocked", "unknown"]),
      resetsAtMs: z.number().nullable(),
    }),
  ),
  reachedReason: z.string().nullable(),
});

const BB_PROVIDERS = { "claude-code": "claude", codex: "codex" } as const;

/** BB's report as usage; null for a provider the router does not use or an unknown status. */
export function bbUsage(report: z.infer<typeof bbRateLimitsSchema>, now: number): ProviderUsage | null {
  const provider = BB_PROVIDERS[report.providerId as keyof typeof BB_PROVIDERS];
  if (provider === undefined || report.status === "unknown") return null;
  const limited = report.windows.filter((window) => window.status === report.status);
  const resets = limited.flatMap((window) => window.resetsAtMs ?? []);
  const label = limited[0]?.label?.toLowerCase();
  const reason =
    report.status === "allowed"
      ? null
      : report.kind === "spend-control"
        ? "the spend limit is reached"
        : report.kind === "credits"
          ? "the credits are used up"
          : label === undefined
            ? null
            : `the ${label} is ${report.status === "blocked" ? "reached" : "almost used"}`;
  return {
    provider,
    status: report.status,
    reason,
    resetsAtMs: resets.length === 0 ? null : Math.max(...resets),
    checkedAtMs: now,
  };
}

const usageSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  status: z.enum(["allowed", "warning", "blocked"]),
  reason: z.string().nullable(),
  resetsAtMs: z.number().nullable(),
  checkedAtMs: z.number(),
});

const usageFile = (directory: string, provider: ProviderUsage["provider"]) =>
  join(directory, "usage", `${provider}.json`);

/** Saves the latest report for its provider. The bridge and the host share `directory`. */
export async function recordUsage(directory: string, usage: ProviderUsage): Promise<void> {
  await mkdir(join(directory, "usage"), { recursive: true, mode: 0o700 });
  const target = usageFile(directory, usage.provider);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(usage), { mode: 0o600 });
  await rename(temporary, target);
}

export async function readRecordedUsage(
  directory: string,
  provider: ProviderUsage["provider"],
): Promise<ProviderUsage | null> {
  try {
    return usageSchema.parse(JSON.parse(await readFile(usageFile(directory, provider), "utf8")));
  } catch {
    return null;
  }
}

/** Asks the Codex app server for the account's limits. Null when Codex is missing or does not answer. */
export function readCodexLimits(
  env: NodeJS.ProcessEnv,
  options: { spawn?: typeof spawn; timeoutMs?: number } = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = (options.spawn ?? spawn)("codex", ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let buffer = "";
    const finish = (value: unknown) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? CODEX_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin?.on("error", () => finish(null));
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 256_000) return finish(null);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown };
          if (message.id === 2) return finish(message.result ?? null);
        } catch {}
      }
    });
    // The app server exits when its input ends, so the input stays open until the answer arrives.
    child.stdin?.write(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "model-pilot", version: "0" } } },
        { jsonrpc: "2.0", method: "initialized" },
        { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n",
    );
  });
}

/**
 * Usage for every provider: Codex read live, reused for two minutes, else its last recorded report;
 * Claude Code's last recorded report. A report whose block has passed is dropped.
 */
export function makeUsageReader(
  directory: string,
  options: { readCodex: () => Promise<unknown>; now?: () => number },
) {
  const now = options.now ?? Date.now;
  let codex: { at: number; usage: ProviderUsage | null } | null = null;
  return async (): Promise<ProviderUsage[]> => {
    const at = now();
    if (codex === null || at - codex.at >= CODEX_CACHE_MS) {
      const reply = codexRateLimitsReplySchema.safeParse(await options.readCodex().catch(() => null));
      codex = { at, usage: reply.success ? codexUsage(reply.data, at) : null };
    }
    const usages = [
      codex.usage ?? (await readRecordedUsage(directory, "codex")),
      await readRecordedUsage(directory, "claude"),
    ];
    return usages.flatMap((usage) => (usage === null ? [] : (current(usage, at) ?? [])));
  };
}
