import assert from "node:assert/strict";
import test from "node:test";
import {
  classifierConfigSchema,
  classifierSetupInputSchema,
  defaultClassifierConfig,
  makeClassifierAsk,
} from "./classifier.js";

const questions = {
  shape: {
    type: "choice" as const,
    instructions: "Choose task shape.",
    criteria: { main: "One task", plan: "Several tasks" },
  },
};
const openaiReply = (answer: unknown = { shape: { main: 70, plan: 30 } }) => ({
  status: "completed",
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(answer) }],
    },
  ],
  usage: {
    input_tokens: 80,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 20 },
  },
});
const anthropicReply = (answer: unknown = { shape: { main: 20, plan: 80 } }) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", name: "routing_decisions", input: answer }],
  usage: { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 20 },
});

test("classification configuration rejects arbitrary model/provider combinations and blank keys", () => {
  assert.equal(
    classifierConfigSchema.safeParse({
      provider: "openai",
      model: "jev-latest",
    }).success,
    false,
  );
  assert.equal(
    classifierConfigSchema.safeParse({
      provider: "untrusted",
      model: "gpt-5.6-luna",
    }).success,
    false,
  );
  assert.equal(
    classifierSetupInputSchema.safeParse({
      ...defaultClassifierConfig("openai"),
      key: "  ",
    }).success,
    false,
  );
});

test("OpenAI uses a constrained response schema and records its real usage with provider-specific pricing", async () => {
  let sent: Record<string, unknown> | undefined;
  const ask = makeClassifierAsk(defaultClassifierConfig("openai"), {
    readKey: async () => "private-key",
    fetch: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer private-key",
      );
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(openaiReply()));
    },
  });
  const reply = await ask("task", questions);
  assert.deepEqual(reply.answers, {
    shape: {
      choice: "main",
      confidence: 0.7,
      probabilities: { main: 0.7, plan: 0.3 },
    },
  });
  assert.equal(reply.jev.inputTokens, 80);
  assert.equal(reply.jev.classifier?.outputTokens, 8);
  assert.equal(reply.jev.classifier?.cacheReadInputTokens, 20);
  assert.equal(
    reply.jev.classifier?.estimatedUsd,
    (60 * 0.2 + 20 * 0.02 + 8 * 1.2) / 1_000_000,
  );
  assert.equal(reply.jev.classifier?.confidenceKind, "estimated");
  assert.equal(JSON.stringify(reply).includes("private-key"), false);
  assert.deepEqual(sent?.reasoning, { effort: "none" });
  assert.equal(sent?.store, false);
  assert.match(
    JSON.stringify(sent?.text),
    /"required":\["main","plan"\],"additionalProperties":false/,
  );
});

test("Haiku returns exact tool choices and adds cache input only once", async () => {
  const ask = makeClassifierAsk(defaultClassifierConfig("anthropic"), {
    readKey: async () => "private-key",
    fetch: async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "private-key");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.tool_choice, {
        type: "tool",
        name: "routing_decisions",
        disable_parallel_tool_use: true,
      });
      return new Response(JSON.stringify(anthropicReply()));
    },
  });
  const reply = await ask("task", questions);
  assert.equal(reply.answers?.shape?.choice, "plan");
  assert.equal(reply.answers?.shape?.probabilities?.plan, 0.8);
  assert.equal(reply.jev.inputTokens, 80);
  assert.equal(reply.jev.classifier?.outputTokens, 7);
  assert.equal(reply.jev.classifier?.provider, "anthropic");
  assert.equal(
    reply.jev.classifier?.estimatedUsd,
    (60 + 20 * 0.1 + 7 * 5) / 1_000_000,
  );
});

for (const [label, value] of [
  ["unknown choice", { shape: { main: 50, "malicious-model": 50 } }],
  ["missing question", {}],
  ["extra question", { shape: { main: 100, plan: 0 }, other: { main: 100 } }],
  ["single choice instead of a vote", { shape: "main" }],
  ["missing choice in a vote", { shape: { main: 100 } }],
  ["empty vote", { shape: { main: 0, plan: 0 } }],
  ["out-of-range percent", { shape: { main: 150, plan: 0 } }],
] as const) {
  test(`both providers reject ${label} rather than accept a partial decision`, async () => {
    for (const provider of ["openai", "anthropic"] as const) {
      const ask = makeClassifierAsk(defaultClassifierConfig(provider), {
        readKey: async () => "secret",
        fetch: async () =>
          new Response(
            JSON.stringify(
              provider === "openai"
                ? openaiReply(value)
                : anthropicReply(value),
            ),
          ),
      });
      const reply = await ask("task", questions);
      assert.equal(reply.answers, null);
      assert.equal(reply.jev.isAnswered, false);
      assert.ok(
        (reply.jev.classifier?.estimatedUsd ?? 0) > 0,
        "invalid classifications still count billed usage",
      );
    }
  });
}

test("refused, truncated, multiple-tool, and malformed responses fail safely", async () => {
  const refused = openaiReply();
  refused.output[0]!.content = [{ type: "refusal", text: "private response" }];
  const truncated = { ...openaiReply(), status: "incomplete" };
  const multiple = anthropicReply();
  multiple.content.push(multiple.content[0]!);
  for (const [provider, value] of [
    ["openai", refused],
    ["openai", truncated],
    ["anthropic", { ...anthropicReply(), stop_reason: "max_tokens" }],
    ["anthropic", multiple],
    ["openai", { error: "private detail" }],
  ] as const) {
    const ask = makeClassifierAsk(defaultClassifierConfig(provider), {
      readKey: async () => "secret",
      fetch: async () => new Response(JSON.stringify(value)),
    });
    assert.equal((await ask("task", questions)).answers, null);
  }
});

test("missing credentials, HTTP errors, and socket errors never expose secret content or retry paid requests", async () => {
  let calls = 0;
  const warnings: string[] = [];
  for (const fetcher of [
    async () => new Response("secret account detail", { status: 401 }),
    async () => {
      throw new Error("secret account detail");
    },
  ]) {
    const ask = makeClassifierAsk(defaultClassifierConfig("openai"), {
      readKey: async () => "secret",
      warn: (value) => warnings.push(value),
      fetch: async () => {
        calls++;
        return fetcher();
      },
    });
    assert.equal((await ask("task", questions)).answers, null);
  }
  assert.equal(calls, 2);
  assert.equal(warnings.join().includes("secret"), false);
  const ask = makeClassifierAsk(defaultClassifierConfig("openai"), {
    readKey: async () => null,
    fetch: async () => {
      throw new Error("must not call");
    },
  });
  assert.equal((await ask("task", questions)).answers, null);
});

test("unknown usage stays unpriced and Haiku cache writes use the cache write rate", async () => {
  const missingUsage = { status: "completed", output: openaiReply().output };
  const unknown = makeClassifierAsk(defaultClassifierConfig("openai"), {
    readKey: async () => "secret",
    fetch: async () => new Response(JSON.stringify(missingUsage)),
  });
  assert.equal(
    (await unknown("task", questions)).jev.classifier?.estimatedUsd,
    null,
  );
  const withWrites = {
    ...anthropicReply(),
    usage: { ...anthropicReply().usage, cache_creation_input_tokens: 10 },
  };
  const ask = makeClassifierAsk(defaultClassifierConfig("anthropic"), {
    readKey: async () => "secret",
    fetch: async () => new Response(JSON.stringify(withWrites)),
  });
  const reply = await ask("task", questions);
  assert.equal(reply.jev.inputTokens, 90);
  assert.equal(
    reply.jev.classifier?.estimatedUsd,
    (60 + 20 * 0.1 + 10 * 1.25 + 7 * 5) / 1_000_000,
  );
});
