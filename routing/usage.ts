/**
 * Subscription usage as a classifier input: what each provider account has left, as one fact the
 * classifier reads, and the models it cannot pick while their account is blocked. Pure: the
 * readers that fetch usage live in the host.
 *
 * @module routing/usage
 */
import type { Question } from "./core.js";
import type { JevAsk } from "./jev.js";
import { modelInfo, type ModelInfo } from "./models.js";

export type UsageStatus = "allowed" | "warning" | "blocked";

/** One provider account's usage at `checkedAtMs`. */
export type ProviderUsage = {
  provider: ModelInfo["provider"];
  status: UsageStatus;
  /** Why it is limited, in a few words: "the workspace spend cap is used up". */
  reason: string | null;
  /** When the limit that applies resets; null when the provider did not say. */
  resetsAtMs: number | null;
  checkedAtMs: number;
};

/** A blocked report with no reset time counts for this long after it arrived. */
export const BLOCKED_WITHOUT_RESET_MS = 60 * 60_000;

const ACCOUNT_NAMES = { codex: "Codex (GPT models)", claude: "Claude Code (Claude models)" } as const;
const MODEL_FAMILIES = { codex: "GPT", claude: "Claude" } as const;

/** The report as it stands at `now`: a block whose reset time passed no longer applies. */
export function current(usage: ProviderUsage, now: number): ProviderUsage | null {
  if (usage.status !== "blocked") return usage;
  const expires = usage.resetsAtMs ?? usage.checkedAtMs + BLOCKED_WITHOUT_RESET_MS;
  return now < expires ? usage : null;
}

function resetText(resetsAtMs: number | null, now: number): string {
  if (resetsAtMs === null) return "";
  const hours = (resetsAtMs - now) / 3_600_000;
  if (hours < 1) return ", resets in under an hour";
  if (hours < 48) return `, resets in ${Math.round(hours)} hours`;
  return `, resets on ${new Date(resetsAtMs).toISOString().slice(0, 10)}`;
}

/** "Codex (GPT models): blocked, the workspace spend cap is used up, resets on 2026-11-01". */
function accountLine(usage: ProviderUsage, now: number): string {
  const state = { allowed: "available", warning: "available but near its limit", blocked: "blocked" }[
    usage.status
  ];
  const reason = usage.reason === null ? "" : `, ${usage.reason}`;
  return `${ACCOUNT_NAMES[usage.provider]}: ${state}${reason}${resetText(usage.resetsAtMs, now)}`;
}

/** The providers whose models cannot run now. When every provider is blocked, none is left out. */
export function blockedProviders(usages: readonly ProviderUsage[], now: number): Set<ModelInfo["provider"]> {
  const live = usages.flatMap((usage) => current(usage, now) ?? []);
  const blocked = new Set(live.filter((usage) => usage.status === "blocked").map((usage) => usage.provider));
  return blocked.size === Object.keys(ACCOUNT_NAMES).length ? new Set() : blocked;
}

/** What the classifier reads about the accounts, or null when no provider reported usage. */
export function usageFact(usages: readonly ProviderUsage[], now: number): string | null {
  const live = usages.flatMap((usage) => current(usage, now) ?? []);
  if (live.length === 0) return null;
  const left = blockedProviders(usages, now);
  const note =
    left.size > 0
      ? " Models on a blocked account are not offered, because their requests would be refused."
      : live.some((usage) => usage.status !== "allowed")
        ? " Prefer models on an account with room left when two models are equally suited."
        : "";
  return `Subscription usage: ${live.map((usage) => accountLine(usage, now)).join("; ")}.${note}`;
}

/** The questions without the models of blocked providers. A question left with no model keeps them all. */
export function withoutBlocked(
  questions: Record<string, Question>,
  blocked: ReadonlySet<ModelInfo["provider"]>,
): Record<string, Question> {
  if (blocked.size === 0) return questions;
  return Object.fromEntries(
    Object.entries(questions).map(([name, question]) => {
      const keys = Object.keys(question.criteria);
      const isModelQuestion = keys.length > 0 && keys.every((key) => modelInfo(key) !== undefined);
      if (!isModelQuestion) return [name, question];
      const kept = Object.entries(question.criteria).filter(
        ([model]) => !blocked.has(modelInfo(model)!.provider),
      );
      return [name, kept.length === 0 ? question : { ...question, criteria: Object.fromEntries(kept) }];
    }),
  );
}

/** "GPT models were left out: Codex (GPT models): blocked, ...". Null when nothing was left out. */
export function limitsNote(usages: readonly ProviderUsage[], now: number): string | null {
  const blocked = blockedProviders(usages, now);
  if (blocked.size === 0) return null;
  const lines = usages
    .flatMap((usage) => current(usage, now) ?? [])
    .filter((usage) => blocked.has(usage.provider))
    .map((usage) => {
      const reason = usage.reason === null ? "its usage limit is reached" : usage.reason;
      return `${MODEL_FAMILIES[usage.provider]} models were left out because ${reason}${resetText(usage.resetsAtMs, now)}.`;
    });
  return lines.join(" ");
}

/**
 * The classifier with usage as an input: the usage fact goes before the state, and models on a
 * blocked account leave every model question. The reply names what was left out.
 */
export function withUsage(
  ask: JevAsk,
  readUsage: () => Promise<readonly ProviderUsage[]>,
  now: () => number = Date.now,
): JevAsk {
  return async (state, questions) => {
    const usages = await readUsage().catch(() => []);
    const at = now();
    const fact = usageFact(usages, at);
    const reply = await ask(
      fact === null ? state : `${fact}\n${state}`,
      withoutBlocked(questions, blockedProviders(usages, at)),
    );
    const limits = limitsNote(usages, at);
    return limits === null ? reply : { ...reply, jev: { ...reply.jev, limits } };
  };
}
