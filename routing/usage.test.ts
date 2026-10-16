import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Question } from "./core.js";
import type { JevAsk, JevReply } from "./jev.js";
import { makeThreadRouter } from "./router.js";
import { withUsage, type ProviderUsage } from "./usage.js";
import { bbUsage, codexUsage, makeUsageReader, readCodexLimits, recordUsage } from "./usage-sources.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const DAY = 86_400_000;

const codexBlocked: ProviderUsage = {
  provider: "codex",
  status: "blocked",
  reason: "the spend cap is used up",
  resetsAtMs: Date.parse("2026-11-01T00:00:00Z"),
  checkedAtMs: NOW,
};
const claudeAllowed: ProviderUsage = {
  provider: "claude",
  status: "allowed",
  reason: null,
  resetsAtMs: null,
  checkedAtMs: NOW,
};

/** A classifier that records what it was asked and votes 70% for the first option of each question. */
function recordingClassifier() {
  const seen: { state: string; questions: Record<string, Question> }[] = [];
  const ask: JevAsk = async (state, questions) => {
    seen.push({ state, questions });
    const answers = Object.fromEntries(
      Object.entries(questions).map(([name, question]) => {
        const options = Object.keys(question.criteria);
        const probabilities = Object.fromEntries(
          options.map((option, i) => [option, i === 0 ? 0.7 : 0.3 / (options.length - 1)]),
        );
        return [name, { choice: options[0]!, confidence: 0.7, probabilities }];
      }),
    );
    return { answers, jev: { isAnswered: true, ms: 1, inputTokens: 0, keyMs: 0 } } satisfies JevReply;
  };
  return { ask, seen };
}

test("a blocked Codex account leaves GPT models out and tells the classifier why", async () => {
  const classifier = recordingClassifier();
  const route = makeThreadRouter({
    ask: withUsage(classifier.ask, async () => [codexBlocked, claudeAllowed], () => NOW),
    record: async () => {},
    lastRoute: async () => undefined,
  });
  const reply = await route({ threadId: "thr_a", prompt: "Rename a variable.", turn: "first" });

  const asked = classifier.seen[0]!;
  assert.match(asked.state, /^Subscription usage: Codex \(GPT models\): blocked, the spend cap is used up, resets on 2026-11-01; Claude Code \(Claude models\): available\./);
  assert.match(asked.state, /Task:\nRename a variable\.$/);
  for (const name of ["model", "helperModel"])
    assert.ok(Object.keys(asked.questions[name]!.criteria).every((model) => !model.startsWith("gpt-")), name);
  assert.deepEqual(Object.keys(asked.questions.effort!.criteria), ["low", "medium", "high", "xhigh"]);
  assert.equal(reply.route?.model, "claude-sonnet-5-5");
  assert.equal(reply.limits, "GPT models were left out because the spend cap is used up, resets on 2026-11-01.");
});

test("usage that leaves room is only a fact, and a passed block no longer applies", async () => {
  const classifier = recordingClassifier();
  const nearLimit: ProviderUsage = {
    ...claudeAllowed,
    status: "warning",
    reason: "the five-hour limit is almost used",
    resetsAtMs: NOW + 3 * 3_600_000,
  };
  const ask = withUsage(classifier.ask, async () => [{ ...codexBlocked, resetsAtMs: NOW - 1 }, nearLimit], () => NOW);
  const reply = await ask("Task:\nx", { model: { type: "choice", instructions: "", criteria: { "gpt-6-luna": "", "claude-sonnet-5-5": "" } } });

  assert.equal(
    classifier.seen[0]!.state,
    "Subscription usage: Claude Code (Claude models): available but near its limit, the five-hour limit is almost used, resets in 3 hours. Prefer models on an account with room left when two models are equally suited.\nTask:\nx",
  );
  assert.deepEqual(Object.keys(classifier.seen[0]!.questions.model!.criteria), ["gpt-6-luna", "claude-sonnet-5-5"]);
  assert.equal(reply.jev.limits, undefined);
});

test("when every account is blocked, no model is left out", async () => {
  const classifier = recordingClassifier();
  const ask = withUsage(
    classifier.ask,
    async () => [codexBlocked, { ...claudeAllowed, status: "blocked", reason: null, resetsAtMs: NOW + DAY }],
    () => NOW,
  );
  const reply = await ask("Task:\nx", { model: { type: "choice", instructions: "", criteria: { "gpt-6-luna": "", "claude-sonnet-5-5": "" } } });
  assert.deepEqual(Object.keys(classifier.seen[0]!.questions.model!.criteria), ["gpt-6-luna", "claude-sonnet-5-5"]);
  assert.match(classifier.seen[0]!.state, /Claude Code \(Claude models\): blocked, resets in 24 hours/);
  assert.equal(reply.jev.limits, undefined);
});

test("no usage report leaves the classifier input unchanged", async () => {
  const classifier = recordingClassifier();
  await withUsage(classifier.ask, async () => { throw new Error("offline"); }, () => NOW)("Task:\nx", {});
  assert.equal(classifier.seen[0]!.state, "Task:\nx");
});

test("Codex's own report: a reached spend cap blocks until the cap resets", () => {
  // The reply the Codex app server gave for an account over its workspace spend cap.
  const usage = codexUsage(
    {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_792_664_255 },
        secondary: null,
        individualLimit: { remainingPercent: 0, resetsAt: 1_793_491_201 },
        spendControlReached: true,
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      },
    },
    NOW,
  );
  assert.deepEqual(usage, { ...codexBlocked, resetsAtMs: 1_793_491_201_000 });
});

test("Codex's own report: 80% of a window used is near the limit", () => {
  const near = codexUsage(
    { rateLimits: { primary: { usedPercent: 86, windowDurationMins: 10_080, resetsAt: 1_792_664_255 }, secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1 } } },
    NOW,
  );
  assert.deepEqual(near, { provider: "codex", status: "warning", reason: "86% of the weekly limit is used", resetsAtMs: 1_792_664_255_000, checkedAtMs: NOW });
  const room = codexUsage({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 } } }, NOW);
  assert.equal(room.status, "allowed");
});

test("BB's Claude Code reports become usage", () => {
  const window = { label: "Five-hour limit", status: "blocked" as const, resetsAtMs: NOW + 3_600_000 };
  assert.deepEqual(
    bbUsage({ providerId: "claude-code", status: "blocked", kind: "subscription-window", windows: [window], reachedReason: null }, NOW),
    { provider: "claude", status: "blocked", reason: "the five-hour limit is reached", resetsAtMs: NOW + 3_600_000, checkedAtMs: NOW },
  );
  assert.equal(
    bbUsage({ providerId: "claude-code", status: "allowed", kind: "subscription-window", windows: [{ ...window, status: "allowed" }], reachedReason: null }, NOW)?.status,
    "allowed",
  );
  assert.equal(bbUsage({ providerId: "pi", status: "blocked", kind: "credits", windows: [], reachedReason: null }, NOW), null);
});

test("the usage reader asks Codex at most every two minutes and reads Claude's last report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-"));
  try {
    let now = NOW;
    let reads = 0;
    const read = makeUsageReader(directory, {
      now: () => now,
      readCodex: async () => {
        reads += 1;
        return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 } } };
      },
    });
    await recordUsage(directory, claudeAllowed);
    assert.deepEqual(
      (await read()).map((usage) => `${usage.provider} ${usage.status}`),
      ["codex allowed", "claude allowed"],
    );
    now += 60_000;
    await read();
    assert.equal(reads, 1);
    now += 60_000;
    await read();
    assert.equal(reads, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("without a live Codex answer, the reader uses Codex's last recorded report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-"));
  try {
    await recordUsage(directory, codexBlocked);
    const read = makeUsageReader(directory, { now: () => NOW, readCodex: async () => null });
    assert.deepEqual(await read(), [codexBlocked]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Codex read keeps the app server's input open until it answers", async () => {
  // Like the real app server: it answers after a moment and exits as soon as its input ends.
  const server = `
    const lines = require("node:readline").createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === 2) setTimeout(() => console.log(JSON.stringify({ id: 2, result: { rateLimits: {} } })), 50);
    });
    lines.on("close", () => process.exit(0));
  `;
  const result = await readCodexLimits(process.env, {
    spawn: ((_command: string, _args: string[], options: object) =>
      spawn(process.execPath, ["-e", server], options)) as unknown as typeof spawn,
  });
  assert.deepEqual(result, { rateLimits: {} });
});

test("a blocked Codex account never gets a helper, even the cheapest one", async () => {
  // Jev's vote from a real routed task: Haiku for the helper, with GPT models left out of the question.
  const ask: JevAsk = async (_state, questions) => {
    const answers = Object.fromEntries(
      Object.entries(questions).map(([name, question]) => {
        const options = Object.keys(question.criteria);
        const choice = name === "shape" ? "helper" : name === "helperModel" ? "claude-haiku-4-5-20251001" : options[0]!;
        const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? 0.99 : 0.01 / (options.length - 1)]));
        return [name, { choice, confidence: 0.99, probabilities }];
      }),
    );
    return { answers, jev: { isAnswered: true, ms: 1, inputTokens: 0, keyMs: 0 } } satisfies JevReply;
  };
  const route = makeThreadRouter({
    ask: withUsage(ask, async () => [codexBlocked, claudeAllowed], () => NOW),
    record: async () => {},
    lastRoute: async () => undefined,
  });
  const reply = await route({ threadId: "thr_a", prompt: "Search Slack for ideas about classifying PDFs.", turn: "first" });
  assert.equal(reply.delegation?.delegate, true);
  assert.equal(reply.delegation?.helper?.model, "claude-haiku-4-5-20251001");
});
