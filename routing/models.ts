/**
 * The models the router knows: what each is called, which provider runs it, its list price and
 * how capable it is. Every name, price and tier the router uses comes from this table.
 *
 * @module routing/models
 */

/** US dollars per token. */
export type Rate = { input: number; output: number; cacheWrite: number; cacheRead: number };

export type ModelInfo = {
  readonly name: string;
  readonly provider: "claude" | "codex";
  /** 1 is the least capable, 4 the most. */
  readonly tier: 1 | 2 | 3 | 4;
  readonly rate: Rate;
  /** The largest context window; null where the provider has no window setting. */
  readonly maxWindow: "200k" | "1m" | null;
};

/**
 * Claude's prices are Anthropic's as LiteLLM listed them on 2026-10-02. Cache writes are priced at
 * the 1-hour rate (2x input), the one Claude Code pays: with it the report matched Claude Code's
 * own cost for a live session to the cent. OpenAI's are its list prices on 2026-10-03; OpenAI
 * bills no cache write except Luna's $0.125 per million.
 */
export const MODELS = {
  "claude-haiku-4-5-20251001": {
    name: "Haiku 4.5",
    provider: "claude",
    tier: 1,
    rate: { input: 1e-6, output: 5e-6, cacheWrite: 2e-6, cacheRead: 1e-7 },
    maxWindow: "200k",
  },
  "claude-sonnet-5-5": {
    name: "Sonnet 5.5",
    provider: "claude",
    tier: 2,
    rate: { input: 2e-6, output: 1e-5, cacheWrite: 4e-6, cacheRead: 2e-7 },
    maxWindow: "1m",
  },
  "claude-opus-5-5": {
    name: "Opus 5.5",
    provider: "claude",
    tier: 3,
    rate: { input: 4e-6, output: 2e-5, cacheWrite: 8e-6, cacheRead: 2e-7 },
    maxWindow: "1m",
  },
  "claude-fable-5-1": {
    name: "Fable 5.1",
    provider: "claude",
    tier: 4,
    rate: { input: 1e-5, output: 5e-5, cacheWrite: 2e-5, cacheRead: 2.5e-7 },
    maxWindow: "1m",
  },
  "gpt-6-luna": {
    name: "GPT-6 Luna",
    provider: "codex",
    tier: 1,
    rate: { input: 1e-7, output: 5e-7, cacheWrite: 1.25e-7, cacheRead: 1e-8 },
    maxWindow: null,
  },
  "gpt-6.1-sol": {
    name: "GPT-6.1 Sol",
    provider: "codex",
    tier: 2,
    rate: { input: 2e-6, output: 1e-5, cacheWrite: 2e-6, cacheRead: 1e-7 },
    maxWindow: null,
  },
  "gpt-6-astra": {
    name: "GPT-6 Astra",
    provider: "codex",
    tier: 4,
    rate: { input: 1e-5, output: 5e-5, cacheWrite: 1e-5, cacheRead: 1e-6 },
    maxWindow: null,
  },
} as const satisfies Record<string, ModelInfo>;

export type ModelId = keyof typeof MODELS;

export const modelInfo = (model: string): ModelInfo | undefined =>
  Object.hasOwn(MODELS, model) ? MODELS[model as ModelId] : undefined;

export const outputPricePerMillion = (info: ModelInfo): number => info.rate.output * 1_000_000;
