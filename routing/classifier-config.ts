import { z } from "zod";
import type { Question } from "./core.js";

export const classifierProviderSchema = z.enum([
  "native",
  "jev",
  "openai",
  "anthropic",
]);
export type ClassifierProvider = z.infer<typeof classifierProviderSchema>;
export const CLASSIFIER_MODELS = [
  { provider: "jev", model: "jev-latest", label: "Jev" },
  { provider: "openai", model: "gpt-5.6-luna", label: "OpenAI GPT-5.6 Luna" },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    label: "Anthropic Claude Haiku 4.5",
  },
] as const;
export const nativeProviderSchema = z.enum(["codex", "claude-code"]);
export const nativeModelSchema = z.object({
  providerId: nativeProviderSchema,
  modelId: z.string().min(1),
  label: z.string(),
  providerLabel: z.string(),
  description: z.string(),
  reasoningEffort: z.string(),
});
export type NativeModel = z.infer<typeof nativeModelSchema>;
export const nativeClassifierSchema = z
  .object({
    provider: z.literal("native"),
    nativeProvider: nativeProviderSchema,
    model: z.string(),
    effort: z
      .enum([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
        "ultracode",
      ])
      .optional(),
  })
  .strict();
const variants = [
  z
    .object({ provider: z.literal("jev"), model: z.literal("jev-latest") })
    .strict(),
  z
    .object({ provider: z.literal("openai"), model: z.literal("gpt-5.6-luna") })
    .strict(),
  z
    .object({
      provider: z.literal("anthropic"),
      model: z.literal("claude-haiku-4-5-20251001"),
    })
    .strict(),
] as const;
export const classifierConfigSchema = z.discriminatedUnion("provider", [
  ...variants,
  nativeClassifierSchema,
]);
export type ClassifierConfig = z.infer<typeof classifierConfigSchema>;
const keyField = {
  key: z
    .string()
    .trim()
    .min(1, "Enter an API key or use a saved key.")
    .max(8192)
    .optional(),
};
export const classifierSetupInputSchema = z.discriminatedUnion("provider", [
  variants[0].extend(keyField),
  variants[1].extend(keyField),
  variants[2].extend(keyField),
  nativeClassifierSchema.extend(keyField),
]);
export type ClassifierSetupInput = z.infer<typeof classifierSetupInputSchema>;
export function defaultClassifierConfig(
  provider: ClassifierProvider,
): ClassifierConfig {
  switch (provider) {
    case "native":
      return { provider, nativeProvider: "codex", model: "" };
    case "jev":
      return { provider, model: "jev-latest" };
    case "openai":
      return { provider, model: "gpt-5.6-luna" };
    case "anthropic":
      return { provider, model: "claude-haiku-4-5-20251001" };
  }
}
export const classifierMetadataSchema = z
  .object({
    provider: classifierProviderSchema,
    model: z.string().min(1),
    outputTokens: z.number().finite().nonnegative(),
    cacheReadInputTokens: z.number().finite().nonnegative(),
    estimatedUsd: z.number().finite().nonnegative().nullable(),
    confidenceKind: z.enum(["vote", "categorical"]),
  })
  .strict();
export type ClassifierMetadata = z.infer<typeof classifierMetadataSchema>;
export const CONNECTION_QUESTIONS: Record<string, Question> = {
  connection: {
    type: "choice",
    instructions: "Choose connected.",
    criteria: { connected: "The connection works." },
  },
};
export const classifierResultSchema = z.object({
  answers: z
    .record(
      z.string(),
      z.object({
        choice: z.string(),
        confidence: z.number(),
        probabilities: z.record(z.string(), z.number()).optional(),
      }),
    )
    .nullable(),
  jev: z.object({
    isAnswered: z.boolean(),
    ms: z.number(),
    inputTokens: z.number(),
    keyMs: z.number(),
    classifier: classifierMetadataSchema.optional(),
  }),
});
