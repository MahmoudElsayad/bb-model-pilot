import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { makeJevAsk, KEY_RETRY_MS, type JevReply } from "./jev.js";
import { FALLBACK_THREAD, makeThreadRouter, routeThread, THREAD_MODELS, type RouteRecord } from "./router.js";
import { delegationFrom, EFFORTS, helperModelsFor, pick, pickEnough, pickModel, planFrom, withStepStarted, withStepsDone, isPlanFinished, type Route } from "./core.js";

const reply = (answers: JevReply["answers"]): JevReply => ({ answers,
  jev: { isAnswered: answers !== null, ms: 1, inputTokens: 0, keyMs: 0 } });

test("core/model tables match their recorded T3 source hashes", () => {
  const provenance = z.object({
    sourceSha256: z.object({ "core.ts": z.string(), "models.ts": z.string() }),
  }).parse(JSON.parse(readFileSync(new URL("./provenance.json", import.meta.url), "utf8")));
  for (const file of ["core.ts", "models.ts"] as const) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
      .replace('"./models.js"', '"./models.ts"');
    assert.equal(createHash("sha256").update(source).digest("hex"), provenance.sourceSha256[file]);
  }
});

test("ordered votes use weighted median rather than winner", () => {
  assert.equal(pick({ choice: "high", confidence: .4, probabilities: { low: .35, medium: .3, high: .35 } },
    { low: "", medium: "", high: "" })?.choice, "medium");
  assert.deepEqual(routeThread(null), FALLBACK_THREAD);
});

test("Jev retries a disconnected socket once but does not retry HTTP failure", async () => {
  let calls = 0;
  const ask = makeJevAsk({ readKey: async () => "test-key", retryDelayMs: 0,
    fetch: async () => {
      calls++;
      if (calls === 1) throw new Error("Disconnected");
      return new Response(JSON.stringify({ answers: { model: { choice: "gpt-6-luna" } }, usage: { input_tokens: 12 } }));
    } });
  const answered = await ask("task", {});
  assert.equal(calls, 2);
  assert.equal(answered.answers?.model?.choice, "gpt-6-luna");
  assert.equal(answered.answers?.model?.confidence, 1);
  assert.equal(answered.jev.inputTokens, 12);
  calls = 0;
  const fail = makeJevAsk({ readKey: async () => "test-key", fetch: async () => {
    calls++;
    return new Response("unavailable", { status: 503 });
  } });
  assert.equal((await fail("task", {})).answers, null);
  assert.equal(calls, 1);
});

test("failed secret lookups wait five minutes and recover", async () => {
  let clock = 0;
  let reads = 0;
  const ask = makeJevAsk({ now: () => clock, readKey: async () => ++reads === 1 ? null : "test-key",
    fetch: async () => new Response('{"answers":{}}') });
  assert.equal((await ask("task", {})).jev.isAnswered, false);
  await ask("task", {});
  assert.equal(reads, 1);
  clock += KEY_RETRY_MS;
  assert.equal((await ask("task", {})).jev.isAnswered, true);
  assert.equal(reads, 2);
});

test("invalid network data falls back without leaking response content", async () => {
  const warnings: string[] = [];
  const ask = makeJevAsk({ readKey: async () => "test-key", warn: (line) => warnings.push(line),
    fetch: async () => new Response('{"answers":{"model":{"choice":"x","confidence":"private"}}}') });
  assert.equal((await ask("task", {})).answers, null);
  assert.equal(warnings.some((line) => line.includes("private") || line.includes("test-key")), false);
});

test("later turns retain the main route, and manual changes stop routing", async () => {
  const entries: RouteRecord[] = [];
  const states: string[] = [];
  let route: Route | undefined;
  const router = makeThreadRouter({ ask: async (state) => { states.push(state); return reply({
    model: { choice: "gpt-6-luna", confidence: 1 }, shape: { choice: "main", confidence: 1 },
  }); }, record: async (_, entry) => { entries.push(entry); route = entry.route; }, lastRoute: async () => route });
  const first = await router({ threadId: "thread", prompt: "first", turn: "first" });
  assert.equal(first.route?.model, "gpt-6-luna");
  const later = await router({ threadId: "thread", prompt: "later", turn: "later", currentModel: "gpt-6-luna" });
  assert.deepEqual(later.route, first.route);
  assert.equal(later.decision, "routed");
  assert.equal(entries.length, 2);
  const changed = await router({ threadId: "thread", prompt: "manual", turn: "later", currentModel: "claude-opus-5-5" });
  assert.equal(changed.decision, "changed");
  assert.equal(states.length, 2);
});

test("a plan or a helper needs the same vote share as a model pick, else the main agent works", () => {
  const shape = (probabilities: Record<string, number>) => ({ shape: { choice: "", confidence: 0, probabilities } });
  assert.deepEqual(delegationFrom(shape({ main: 0.49, plan: 0.51 }), FALLBACK_THREAD),
    { delegate: false, share: 0.51, helper: null });
  assert.deepEqual(delegationFrom(shape({ main: 0.4, helper: 0.6 }), FALLBACK_THREAD),
    { delegate: false, share: 0.6, helper: null });
  assert.equal(delegationFrom(shape({ main: 0.24, plan: 0.76 }), FALLBACK_THREAD).plan, true);
  assert.equal(delegationFrom(shape({ main: 0.3, helper: 0.7 }), FALLBACK_THREAD).delegate, true);
});

test("in auto permission mode no helper runs on Haiku, which asks for approvals nobody sees", async () => {
  assert.ok("claude-haiku-4-5-20251001" in helperModelsFor("accept-edits"));
  assert.ok(!("claude-haiku-4-5-20251001" in helperModelsFor("auto")));
  const asked: string[][] = [];
  const router = makeThreadRouter({
    ask: async (_, questions) => {
      asked.push(Object.keys(questions.helperModel?.criteria ?? {}));
      return reply({ shape: { choice: "helper", confidence: 1 } });
    },
    record: async () => {}, lastRoute: async () => undefined,
  });
  const routed = await router({ threadId: "thread", prompt: "List the teams in Linear.", turn: "first", permissionMode: "auto" });
  assert.ok(!asked[0]!.includes("claude-haiku-4-5-20251001"));
  assert.equal(routed.delegation?.helper?.model, "claude-sonnet-5-5", "with no model answer the helper gets the cheapest Claude model offered");
  const plan = planFrom([{ title: "look up" }, { title: "answer", after: [1] }],
    { owner_1: { choice: "helper", confidence: 1 } }, FALLBACK_THREAD, helperModelsFor("auto"));
  assert.equal(plan[0]?.helper?.model, "claude-sonnet-5-5");
});

test("plan dependency ownership controls helper background work", () => {
  const steps = [{ title: "collect" }, { title: "independent" }, { title: "combine", after: [1] }];
  const plan = planFrom(steps, { owner_1: { choice: "helper", confidence: 1 },
    model_1: { choice: "gpt-6-luna", confidence: 1 } }, FALLBACK_THREAD);
  assert.equal(plan[0]?.background, true);
  assert.equal(plan[0]?.helper?.model, "gpt-6-luna");
  const started = withStepStarted(plan, 1);
  assert.equal(started[0]?.status, "started");
  assert.equal(isPlanFinished(withStepsDone(started, [1, 2, 3])), true);
});

test("model picks take the cheapest model that is enough, neither weaker nor stronger than needed", () => {
  const choose = (probabilities: Record<string, number>) =>
    pickModel({ choice: "", confidence: 0, probabilities }, THREAD_MODELS)?.choice;
  assert.equal(choose({ "gpt-6-luna": 0.99, "claude-sonnet-5-5": 0.01 }), "gpt-6-luna");
  assert.equal(
    choose({ "gpt-6-luna": 0.58, "gpt-6.1-sol": 0.09, "claude-sonnet-5-5": 0.31, "claude-opus-5-5": 0.01, "claude-fable-5-1": 0.01 }),
    "claude-sonnet-5-5",
    "a close call for the cheapest model goes to the next tier",
  );
  assert.equal(
    choose({ "gpt-6-luna": 0.7, "gpt-6.1-sol": 0.01, "claude-sonnet-5-5": 0.29 }),
    "gpt-6-luna",
    "a clear majority for the cheapest model keeps it",
  );
  for (const opus of [0.69, 0.71])
    assert.equal(
      choose({ "claude-opus-5-5": opus, "claude-fable-5-1": 1 - opus }),
      "claude-opus-5-5",
      "a strong model that is enough is not raised to the strongest when the vote moves slightly",
    );
  assert.equal(choose({ "claude-fable-5-1": 1 }), "claude-fable-5-1");
  assert.equal(
    pickModel({ choice: "claude-opus-5-5", confidence: 0.9 }, THREAD_MODELS)?.choice,
    "claude-opus-5-5",
    "a categorical answer above the floor is used as given",
  );
});

test("effort and context take the least option that is enough", () => {
  const effort = (probabilities: Record<string, number>) =>
    pickEnough({ choice: "", confidence: 0, probabilities }, EFFORTS)?.choice;
  assert.equal(effort({ low: 0.13, medium: 0.48, high: 0.39 }), "high", "a close call rises to the next level");
  assert.equal(effort({ low: 0.17, medium: 0.81, high: 0.02 }), "medium");
  assert.equal(effort({ low: 0.89, medium: 0.11 }), "low", "a clear vote for less effort keeps it");
});
