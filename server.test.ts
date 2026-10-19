import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import type { Route } from "./routing/core.js";
import type { JevAsk } from "./routing/jev.js";

const route: Route = {
  model: "gpt-6.1-sol",
  effort: "high",
  window: "200k",
  confidence: 1,
  source: "jev",
};
const helper: Route = {
  model: "claude-sonnet-5-5",
  effort: "medium",
  window: "1m",
  confidence: 1,
  source: "jev",
};
const noAnswer: JevAsk = async () => ({
  answers: null,
  jev: { isAnswered: false, ms: 0, inputTokens: 0, keyMs: 0 },
});

async function setup(
  options: {
    waitFails?: boolean;
    asksApproval?: boolean;
    outputFails?: boolean;
    archiveFails?: boolean;
    delegate?: boolean;
    ask?: JevAsk;
    hostRouting?: boolean;
    testClassifierOk?: boolean;
  } = {},
) {
  let revision = "turn-1";
  const host = createFakePluginHost({
    pluginId: "auto-router",
    experimental_callHostRpc: async ({ method }) =>
      method === "configureJevKey" ||
      method === "configureClassifier" ||
      method === "keyStatus"
        ? { configured: false }
        : method === "testClassifier"
          ? {
              ok: options.testClassifierOk !== false,
              message:
                "The service could not connect. Check API billing and model access.",
            }
          : method === "listSessions"
            ? { sessions: [], limited: false }
            : method === "evaluate"
              ? noAnswer("", {})
              : {
                  route,
                  revision,
                  delegation: {
                    delegate: options.delegate !== false,
                    share: 1,
                    helper,
                  },
                },
    sdk: {
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", available: true },
          { id: "auto", displayName: "Model Pilot", available: true },
        ],
        models: async () => ({
          models: [
            {
              id: "native-test",
              model: "catalog-native-test",
              displayName: "A model from BB",
              description: "Discovered from BB",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Fast" },
              ],
              isDefault: true,
            },
          ],
        }),
      },
      plugins: {
        getSettings: async ({ pluginId }) => ({
          ok: true,
          schema: {},
          values:
            pluginId === "provider-codex"
              ? { memoryEnabled: false, subagentsDisabled: true }
              : {
                  memoryEnabled: true,
                  sandboxEnabled: false,
                  chromeEnabled: true,
                  disable1MContext: true,
                },
        }),
      },
      system: { config: async () => ({ primaryHostId: "primary-test" }) },
      environments: {
        get: async () => ({ id: "env-test", hostId: "host-test" }),
      },
      threads: {
        get: async () =>
          makeThreadResponse({
            id: "thread-test",
            providerId: "auto",
            environmentId: "env-test",
          }),
        defaultExecutionOptions: async () => ({
          model: "auto",
          permissionMode: "auto",
          reasoningLevel: "high",
          serviceTier: "default",
          source: "client/thread/start",
        }),
        spawn: async () =>
          makeThreadResponse({
            id: "helper-test",
            providerId: "auto",
            environmentId: "env-test",
          }),
        wait: async ({ signal }: { signal?: AbortSignal }) => {
          if (options.waitFails) throw new Error("wait failed");
          if (options.asksApproval)
            await new Promise((_, reject) =>
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          return {};
        },
        interactions: {
          list: async () =>
            options.asksApproval
              ? [
                  {
                    payload: {
                      kind: "approval",
                      subject: { kind: "permission_grant", toolName: "mcp__claude_ai_Linear__list_teams" },
                    },
                  },
                ]
              : [],
        },
        output: async () => {
          if (options.outputFails) throw new Error("output failed");
          return { output: "Finished requested task." };
        },
        archive: async () => {
          if (options.archiveFails) throw new Error("archive failed");
          return {};
        },
        stop: async () => ({ ok: true }),
      },
    },
  });
  await plugin(
    host.bb,
    options.hostRouting ? { helperPollMs: 1 } : { ask: options.ask ?? noAnswer, helperPollMs: 1 },
  );
  return {
    ...host,
    setRevision: (value: string) => {
      revision = value;
    },
  };
}

test("Auto tools are selected only on Auto threads and are withheld from helper threads", async () => {
  const { harness } = await setup();
  try {
    const own = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        provider: { id: "auto", model: "auto" },
      }),
    );
    assert.equal(own.tools.length, 3);
    const native = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ provider: { id: "codex" } }),
    );
    assert.equal(native.tools.length, 0);
    const child = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        provider: {
          id: "auto",
          model: "auto-helper:claude-sonnet-5-5:medium:1m",
        },
      }),
    );
    assert.equal(child.tools.length, 0);
    assert.equal(child.instructions, null);
  } finally {
    await harness.dispose();
  }
});

test("native provider settings remain in Auto provider options", async () => {
  const { harness } = await setup();
  try {
    const declaration = harness.registrations.providerRegistrations[0]!;
    const derived = declaration.deriveProviderOptions!({
      threadId: "thread-test",
      projectId: "project-test",
      model: "auto",
      permissionMode: "auto",
      settings: {},
      promptMode: "plan",
    });
    assert.deepEqual(derived.nativeProviderOptions, {
      codex: { memoryEnabled: false, providerSubagentsEnabled: false },
      "claude-code": {
        memoryEnabled: true,
        providerSubagentsEnabled: true,
        workflowsEnabled: true,
        chromeEnabled: true,
        disable1MContext: true,
        sandboxEnabled: false,
      },
    });
    assert.equal(derived.promptMode, "plan");
  } finally {
    await harness.dispose();
  }
});

test("plan input rejects cycles and invalid dependencies before Jev or helpers run", async () => {
  const { harness } = await setup();
  try {
    await assert.rejects(
      harness.callAgentTool("auto_plan", {
        steps: [
          { title: "A", after: [2] },
          { title: "B", after: [1] },
        ],
      }),
      /cycles/,
    );
    await assert.rejects(
      harness.callAgentTool("auto_plan", {
        steps: [{ title: "A", after: [3] }],
      }),
      /existing steps/,
    );
    assert.equal(harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await harness.dispose();
  }
});

test("helper preserves selected effort, context and parent permissions, then archives and stops", async () => {
  const { harness } = await setup();
  try {
    const result = await harness.callAgentTool("auto_delegate", {
      task: "Read the requested file.",
    });
    assert.match(String(result), /Finished requested task/);
    const [args] = harness.sdk.callsTo("threads.spawn")[0]!;
    assert.ok(args && typeof args === "object");
    assert.equal(Reflect.get(args, "providerId"), "auto");
    assert.equal(
      Reflect.get(args, "model"),
      "auto-helper:claude-sonnet-5-5:medium:1m",
    );
    assert.equal(Reflect.get(args, "permissionMode"), "auto");
    assert.deepEqual(Reflect.get(args, "environment"), {
      type: "reuse",
      environmentId: "env-test",
    });
    assert.equal(Reflect.get(args, "parentThreadId"), undefined);
    assert.equal(Reflect.get(args, "lifecycleOwnerThreadId"), "thread-test");
    assert.equal(Reflect.get(args, "visibility"), "hidden");
    const calls = harness.sdk.calls.map((call) => call.path);
    assert.ok(calls.indexOf("threads.archive") < calls.indexOf("threads.stop"));
  } finally {
    await harness.dispose();
  }
});

for (const failure of ["waitFails", "outputFails", "archiveFails"] as const) {
  test(`helper runtime stops when ${failure}`, async () => {
    const { harness } = await setup({ [failure]: true });
    try {
      await assert.rejects(
        harness.callAgentTool("auto_delegate", {
          task: "Read the requested file.",
        }),
        /failed/,
      );
      assert.equal(harness.sdk.callsTo("threads.archive").length, 1);
      assert.equal(harness.sdk.callsTo("threads.stop").length, 1);
    } finally {
      await harness.dispose();
    }
  });
}

test("a helper that asks for an approval is stopped at once, and the main agent is told what it asked for", async () => {
  const { harness } = await setup({ asksApproval: true });
  try {
    await assert.rejects(
      harness.callAgentTool("auto_delegate", { task: "List the teams in Linear." }),
      /approval to use mcp__claude_ai_Linear__list_teams.*Do this work yourself/,
    );
    assert.equal(harness.sdk.callsTo("threads.archive").length, 1);
    assert.equal(harness.sdk.callsTo("threads.stop").length, 1);
  } finally {
    await harness.dispose();
  }
});

test("unapproved route hints and already aborted calls never spawn a helper", async () => {
  const { harness } = await setup();
  try {
    await assert.rejects(
      harness.callAgentTool("auto_delegate", {
        task: "Read the file.",
        model: "gpt-6-astra",
      }),
      /classification model selected/,
    );
    await assert.rejects(
      harness.callAgentTool("auto_delegate", {
        task: "Read the file.",
        effort: "xhigh",
      }),
      /classification model selected/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      harness.callAgentTool(
        "auto_delegate",
        { task: "Read the file." },
        { signal: controller.signal },
      ),
      /abort/i,
    );
    assert.equal(harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await harness.dispose();
  }
});

test("a new message cannot complete the prior message plan", async () => {
  const { harness, setRevision } = await setup();
  try {
    await harness.callAgentTool("auto_plan", {
      steps: [{ title: "First message step" }],
    });
    setRevision("turn-2");
    await assert.rejects(
      harness.callAgentTool("auto_step_done", { steps: [1] }),
      /existing main-agent steps/,
    );
    await harness.callAgentTool("auto_plan", {
      steps: [{ title: "Second message step" }],
    });
    const result = await harness.callAgentTool("auto_step_done", {
      steps: [1],
    });
    assert.match(String(result), /Second message step/);
    assert.doesNotMatch(String(result), /First message step/);
  } finally {
    await harness.dispose();
  }
});

test("disposing the plugin cancels and stops a background helper", async () => {
  const ask: JevAsk = async () => ({
    answers: Object.fromEntries(
      Object.entries({
        owner_1: "helper",
        model_1: helper.model,
        effort_1: helper.effort,
        context_1: helper.window,
        owner_2: "main",
      }).map(([key, choice]) => [key, { choice, confidence: 1 }]),
    ),
    jev: { isAnswered: true, ms: 1, inputTokens: 1, keyMs: 0 },
  });
  const { harness } = await setup({ ask });
  harness.sdk.stub(
    "threads.wait",
    (args: unknown) =>
      new Promise((_resolve, reject) => {
        assert.ok(args && typeof args === "object");
        const signal: unknown = Reflect.get(args, "signal");
        assert.ok(signal instanceof AbortSignal);
        signal.addEventListener(
          "abort",
          () => reject(new Error("background aborted")),
          { once: true },
        );
      }),
  );
  try {
    await harness.callAgentTool("auto_plan", {
      steps: [{ title: "Read files" }, { title: "Do independent work" }],
    });
    const result = await harness.callAgentTool("auto_delegate", {
      task: "Read files.",
      step: 1,
    });
    assert.match(String(result), /Started background helper/);
    const [spawned] = harness.sdk.callsTo("threads.spawn")[0]!;
    assert.ok(spawned && typeof spawned === "object");
    assert.equal(Reflect.get(spawned, "parentThreadId"), "thread-test");
    assert.equal(Reflect.get(spawned, "lifecycleOwnerThreadId"), "thread-test");
    assert.equal(harness.sdk.callsTo("threads.stop").length, 0);
  } finally {
    await harness.dispose();
  }
  assert.equal(harness.sdk.callsTo("threads.archive").length, 1);
  assert.equal(harness.sdk.callsTo("threads.stop").length, 1);
});

test("production plan and CLI route call Jev on the thread environment host", async () => {
  const { harness } = await setup({ hostRouting: true });
  try {
    await harness.callAgentTool("auto_plan", {
      steps: [{ title: "Read files" }],
    });
    const result = await harness.runCli(
      ["route", "Explain the requested code."],
      {
        threadId: "thread-test",
        projectId: "project-test",
        signal: new AbortController().signal,
      },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const calls = harness.experimental_hostRpcCalls.filter(
      (call) => call.method === "evaluate",
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.hostId === "host-test"));
  } finally {
    await harness.dispose();
  }
});

test("CLI route without thread context calls Jev on the primary host", async () => {
  const { harness } = await setup({ hostRouting: true });
  try {
    const result = await harness.runCli([
      "route",
      "Explain the requested code.",
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const calls = harness.experimental_hostRpcCalls.filter(
      (call) => call.method === "evaluate",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.hostId, "primary-test");
  } finally {
    await harness.dispose();
  }
});

test("saved Jev secrets never appear in CLI status, dashboard results or provider options", async () => {
  const { harness } = await setup();
  const secret = "regression-sentinel-never-return-this-key";
  try {
    const saved = await harness.callRpc("saveJevKey", { key: secret });
    assert.equal(JSON.stringify(saved).includes(secret), false);
    const status = await harness.runCli(["status"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.stdout.includes(secret), false);
    assert.equal(status.stdout.includes("jevApiKey"), false);
    assert.match(status.stdout, /"jevKeyConfigured": true/);
    const dashboard = await harness.callRpc("dashboard", {
      days: 7,
      baselineModel: "claude-opus-5-5",
    });
    assert.equal(JSON.stringify(dashboard).includes(secret), false);
    const declaration = harness.registrations.providerRegistrations[0]!;
    const options = declaration.deriveProviderOptions!({
      threadId: "thread-test",
      projectId: "project-test",
      model: "auto",
      permissionMode: "auto",
      settings: {},
      promptMode: "plan",
    });
    assert.equal(JSON.stringify(options).includes(secret), false);
    assert.equal(Object.hasOwn(options, "jevApiKey"), false);
    assert.deepEqual(
      await harness.resolveProviderEnv("auto", {
        threadId: "thread-test",
        projectId: "project-test",
        hostId: "host-test",
      }),
      [],
    );
  } finally {
    await harness.dispose();
  }
});

test("classification setup tests a candidate before saving and never returns its key", async () => {
  const { harness } = await setup();
  const secret = "openai-key-private-sentinel";
  try {
    const saved = await harness.callRpc("saveClassifier", {
      provider: "openai",
      model: "gpt-5.6-luna",
      key: secret,
    });
    assert.ok(typeof saved === "object" && saved !== null);
    assert.equal(Reflect.get(saved, "provider"), "openai");
    assert.equal(Reflect.get(saved, "model"), "gpt-5.6-luna");
    assert.equal(JSON.stringify(saved).includes(secret), false);
    const calls = harness.experimental_hostRpcCalls;
    assert.ok(
      calls.findIndex((call) => call.method === "testClassifier") <
        calls.findIndex((call) => call.method === "configureClassifier"),
    );
    const status = await harness.runCli(["status"]);
    assert.equal(status.stdout.includes(secret), false);
    const dashboard = await harness.callRpc("dashboard", {
      days: 7,
      baselineModel: "claude-opus-5-5",
    });
    assert.equal(JSON.stringify(dashboard).includes(secret), false);
    const declaration = harness.registrations.providerRegistrations[0]!;
    const providerOptions = declaration.deriveProviderOptions!({
      threadId: "thread-test",
      projectId: "project-test",
      model: "auto",
      permissionMode: "auto",
      settings: {},
      promptMode: "plan",
    });
    assert.equal(JSON.stringify(providerOptions).includes(secret), false);
  } finally {
    await harness.dispose();
  }
});

test("failed classification setup preserves the previous selected service and credentials", async () => {
  const { harness } = await setup({ testClassifierOk: false });
  try {
    await harness.callRpc("saveJevKey", {
      key: "existing-jev-key-private-sentinel",
    });
    await assert.rejects(
      harness.callRpc("saveClassifier", {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        key: "rejected-key-private-sentinel",
      }),
      /Check API billing/,
    );
    const status = await harness.callRpc("setupStatus", {});
    assert.ok(typeof status === "object" && status !== null);
    assert.equal(Reflect.get(status, "provider"), "jev");
    assert.equal(Reflect.get(status, "source"), "setting");
    assert.equal(JSON.stringify(status).includes("private-sentinel"), false);
    await assert.rejects(
      harness.callRpc("saveClassifier", {
        provider: "openai",
        model: "jev-latest",
        key: "private",
      }),
    );
    const candidates = harness.experimental_hostRpcCalls.filter(
      (call) => call.method === "testClassifier",
    );
    assert.equal(candidates.length, 1);
  } finally {
    await harness.dispose();
  }
});

test("BB classifier catalog uses discovered models and rejects unknown or recursive selections", async () => {
  const { harness } = await setup();
  try {
    const catalog = await harness.callRpc("localModels", {});
    assert.deepEqual(Reflect.get(catalog!, "models"), [
      {
        providerId: "codex",
        modelId: "catalog-native-test",
        label: "A model from BB",
        description: "Discovered from BB",
        providerLabel: "Codex",
        reasoningEffort: "low",
      },
    ]);
    await assert.rejects(
      harness.callRpc("saveNativeClassifier", {
        providerId: "codex",
        modelId: "invented",
      }),
      /available through BB/,
    );
    await assert.rejects(
      harness.callRpc("saveNativeClassifier", {
        providerId: "auto",
        modelId: "auto",
      }),
    );
    const saved = await harness.callRpc("saveNativeClassifier", {
      providerId: "codex",
      modelId: "catalog-native-test",
    });
    assert.equal(Reflect.get(saved!, "provider"), "native");
    assert.equal(Reflect.get(saved!, "model"), "catalog-native-test");
    assert.equal(Reflect.get(saved!, "nativeProvider"), "codex");
    const calls = harness.experimental_hostRpcCalls;
    assert.ok(
      calls.findIndex((call) => call.method === "testClassifier") <
        calls.findIndex((call) => call.method === "configureClassifier"),
    );
  } finally {
    await harness.dispose();
  }
});
test("failed BB classifier connection preserves the saved selection", async () => {
  const { harness } = await setup({ testClassifierOk: false });
  try {
    await assert.rejects(
      harness.callRpc("saveNativeClassifier", {
        providerId: "codex",
        modelId: "catalog-native-test",
      }),
    );
    const status = await harness.callRpc("setupStatus", {});
    assert.equal(Reflect.get(status!, "provider"), "jev");
    assert.equal(Reflect.get(status!, "model"), "jev-latest");
  } finally {
    await harness.dispose();
  }
});

test("a thread's usage includes the helpers it started", async () => {
  // Usage that Model Pilot logged for a real thread and one of its Sonnet helpers.
  const at = Date.now() - 60_000;
  const usage = (model: string, nativeSessionId: string, read: number, write: number, input: number, output: number) => ({
    at,
    entry: {
      type: "usage",
      model,
      nativeSessionId,
      usage: {
        kind: "usage",
        total: {
          totalTokens: read + write + input + output,
          inputTokens: input,
          cachedInputTokens: read + write,
          cacheReadInputTokens: read,
          cacheWriteInputTokens: write,
          outputTokens: output,
          reasoningOutputTokens: 0,
        },
      },
    },
  });
  const histories: Record<string, unknown[]> = {
    "thread-main": [usage("claude-opus-5-5", "native-main", 340_976, 45_494, 16, 5_216)],
    "thread-helper": [usage("claude-sonnet-5-5", "native-helper", 46_577, 22_571, 4, 1_296)],
    "thread-other-helper": [usage("claude-sonnet-5-5", "native-other", 1_000_000, 0, 0, 0)],
  };
  const thread = (id: string, owner: string | null, archived: boolean) => ({
    ...makeThreadResponse({ id, providerId: "auto", environmentId: "env-test" }),
    lifecycleOwnerThreadId: owner,
    originPluginId: owner === null ? null : "auto-router",
    visibility: owner === null ? "visible" : "hidden",
    archivedAt: archived ? at : null,
  });
  const threads = [
    thread("thread-main", null, false),
    thread("thread-helper", "thread-main", true),
    thread("thread-other-helper", "thread-other", true),
  ];
  const host = createFakePluginHost({
    pluginId: "auto-router",
    experimental_callHostRpc: async ({ method, input }) => {
      const threadId = (input as { threadId?: string } | undefined)?.threadId ?? "";
      if (method === "getSession")
        return { route, delegation: null, revision: null, history: histories[threadId] ?? [] };
      if (method === "listSessions")
        return {
          limited: false,
          sessions: Object.entries(histories).map(([id, history]) => ({
            autoId: `auto-${id}`,
            threadId: id,
            helper: id !== "thread-main",
            updatedAt: at,
            route: null,
            history,
            truncated: false,
          })),
        };
      return { configured: false };
    },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-test" }) },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
      providers: { list: async () => [], models: async () => ({ models: [] }) },
      environments: { get: async () => ({ id: "env-test", hostId: "host-test" }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => threads.find((t) => t.id === threadId)!,
        list: async (args?: { archived?: boolean; includeHidden?: boolean }) =>
          threads.filter(
            (t) => (args?.archived === true) === (t.archivedAt !== null) && (args?.includeHidden === true || t.visibility !== "hidden"),
          ),
        defaultExecutionOptions: async () => null,
      },
    },
  });
  await plugin(host.bb, { ask: noAnswer });
  const { harness } = host;
  try {
    const opus = 16 * 4e-6 + 340_976 * 2e-7 + 45_494 * 8e-6 + 5_216 * 2e-5;
    const sonnet = 4 * 2e-6 + 46_577 * 2e-7 + 22_571 * 4e-6 + 1_296 * 1e-5;

    const status = await harness.runCli(["status", "--thread", "thread-main"]);
    assert.equal(status.exitCode, 0, status.stderr);
    const summary = JSON.parse(status.stdout).usage;
    assert.deepEqual(Object.keys(summary.byModel).sort(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
    assert.equal(summary.byModel["claude-sonnet-5-5"].outputTokens, 1_296);
    assert.ok(Math.abs(summary.totalUsd - (opus + sonnet)) < 1e-9, `${summary.totalUsd}`);

    const dashboard = (await harness.callRpc("dashboard", {
      days: 7,
      baselineModel: "claude-opus-5-5",
      threadId: "thread-main",
    })) as { summary: { totalUsd: number } };
    assert.ok(Math.abs(dashboard.summary.totalUsd - (opus + sonnet)) < 1e-9, `${dashboard.summary.totalUsd}`);
  } finally {
    await harness.dispose();
  }
});
