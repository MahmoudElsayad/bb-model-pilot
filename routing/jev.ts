import { execFile } from "node:child_process";
import { z } from "zod";
import type { Choice, Question } from "./core.js";
import type { ClassifierMetadata } from "./classifier.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_TIMEOUT_MS = 30_000;
export const KEY_RETRY_MS = 5 * 60_000;
export type JevCall = {
  isAnswered: boolean;
  ms: number;
  inputTokens: number;
  keyMs: number;
  classifier?: ClassifierMetadata;
  /** Which models subscription usage left out of the questions, and why. */
  limits?: string;
};
export const NO_JEV_CALL: JevCall = {
  isAnswered: true,
  ms: 0,
  inputTokens: 0,
  keyMs: 0,
};
export type JevReply = { answers: Record<string, Choice> | null; jev: JevCall };
export type JevAsk = (
  state: string,
  questions: Record<string, Question>,
) => Promise<JevReply>;

const replySchema = z.object({
  answers: z
    .record(
      z.string(),
      z.object({
        choice: z.unknown().optional(),
        confidence: z.number().optional(),
        probabilities: z.record(z.string(), z.number()).optional(),
      }),
    )
    .optional(),
  usage: z.object({ input_tokens: z.number().optional() }).optional(),
});

export async function readJevKey(
  onePasswordReference = "",
): Promise<string | null> {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  if (!onePasswordReference) return null;
  return new Promise((resolve) => {
    execFile(
      "op",
      ["read", onePasswordReference],
      { timeout: 20_000, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    );
  });
}

export type JevDeps = {
  readKey?: () => Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
};

export function makeJevAsk(deps: JevDeps = {}): JevAsk {
  const readKey = deps.readKey ?? readJevKey;
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let key: string | null = null;
  let failedAt = -Infinity;
  let readingKey: Promise<string | null> | undefined;
  return async (state, questions) => {
    const startedAt = now();
    if (key === null && startedAt - failedAt >= KEY_RETRY_MS) {
      readingKey ??= readKey().catch(() => null);
      key = await readingKey;
      readingKey = undefined;
      if (key === null) {
        failedAt = now();
        deps.warn?.("No Jev key is configured. Auto uses the fallback route.");
      }
    }
    const keyMs = now() - startedAt;
    if (key === null)
      return {
        answers: null,
        jev: { isAnswered: false, ms: 0, inputTokens: 0, keyMs },
      };
    const calledAt = now();
    try {
      const body = JSON.stringify({ model: "jev-latest", state, questions });
      const send = async () => {
        const response = await request(JEV_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
        });
        return { ok: response.ok, text: await response.text() };
      };
      let response: Awaited<ReturnType<typeof send>>;
      try {
        response = await send();
      } catch {
        await sleep(deps.retryDelayMs ?? 1000);
        response = await send();
      }
      if (!response.ok)
        throw new Error("Jev returned an unsuccessful response");
      const decoded: unknown = JSON.parse(response.text);
      const reply = replySchema.parse(decoded);
      const answers: Record<string, Choice> = {};
      for (const [name, answer] of Object.entries(reply.answers ?? {})) {
        if (typeof answer.choice !== "string") continue;
        answers[name] = {
          choice: answer.choice,
          confidence: answer.confidence ?? 1,
          ...(answer.probabilities === undefined
            ? {}
            : { probabilities: answer.probabilities }),
        };
      }
      return {
        answers,
        jev: {
          isAnswered: true,
          ms: now() - calledAt,
          inputTokens: reply.usage?.input_tokens ?? 0,
          keyMs,
        },
      };
    } catch {
      deps.warn?.("Jev did not answer. Auto uses the fallback route.");
      return {
        answers: null,
        jev: { isAnswered: false, ms: now() - calledAt, inputTokens: 0, keyMs },
      };
    }
  };
}
