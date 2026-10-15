import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, stat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  buildDashboard,
  dashboardSchema,
  type RetainedSession,
} from "./dashboard.js";
import { summarizeRouting } from "./report.js";
import host from "./host.js";
import plugin from "./server.js";
import { defaultClassifierConfig } from "./routing/classifier-config.js";
const now = Date.UTC(2026, 9, 15, 12);
const usage = (
  at: number,
  inputTokens: number,
  turn: string,
  nativeSessionId?: string,
) => ({
  at,
  entry: {
    type: "usage",
    model: "gpt-6-luna",
    ...(nativeSessionId ? { nativeSessionId } : {}),
    usage: {
      kind: "usage",
      providerTurnId: turn,
      total: { inputTokens, outputTokens: 10, cachedInputTokens: 200 },
    },
  },
});
const session = (
  autoId: string,
  threadId: string,
  history: unknown[],
  helper = false,
): RetainedSession => ({
  autoId,
  threadId,
  helper,
  history,
  updatedAt: now,
  route: { model: "gpt-6-luna" },
  truncated: false,
});
const dashboard = (sessions: RetainedSession[], days: 1 | 7 | 30 | 90 = 7) =>
  buildDashboard({
    input: { days, baselineModel: "claude-opus-5-5" },
    hostId: "host-test",
    sessions,
    plans: [],
    setup: {
      configured: false,
      source: "missing",
      canValidate: false,
      provider: "jev",
      model: "jev-latest",
    },
    titles: new Map(),
    now,
  });

test("dashboard sums independent session totals and helpers without cross-session subtraction", () => {
  const a = session("a", "thread-a", [usage(now - 1000, 1000, "same-turn")]);
  const b = session(
    "b",
    "thread-b",
    [usage(now - 1000, 2000, "same-turn")],
    true,
  );
  const result = dashboard([a, b]);
  dashboardSchema.parse(result);
  assert.equal(result.totals.inputTokens, 3000);
  assert.equal(result.totals.outputTokens, 20);
  assert.equal(result.totals.tokens, 3020);
  assert.equal(result.totals.cacheReadTokens, 400);
  assert.equal(result.totals.helpers, 1);
  assert.equal(
    result.summary.modelUsd,
    summarizeRouting(a.history).modelUsd + summarizeRouting(b.history).modelUsd,
  );
  assert.equal(
    result.trend.reduce((n, b) => n + b.inputTokens, 0),
    3000,
  );
  assert.match(result.comparison.label, /same observed tokens/);
});

test("dashboard attributes only cumulative increments inside the selected window and merges repeated thread rows", () => {
  const old = usage(now - 2 * 86400000, 1000, "first");
  const recent = usage(now - 1000, 1500, "second");
  const result = dashboard(
    [
      session("a", "thread-a", [old, recent]),
      session("b", "thread-a", [usage(now - 1000, 1000, "other")]),
    ],
    1,
  );
  assert.equal(result.totals.inputTokens, 1500);
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0]?.tokens, 1510);
  assert.equal(
    result.trend.reduce((n, b) => n + b.inputTokens, 0),
    1500,
  );
});

test("native session identities prevent subtracting one native session from another in a retained ledger", () => {
  const result = dashboard([
    session("a", "thread-a", [
      usage(now - 2000, 1000, "same", "native-a"),
      usage(now - 1000, 1500, "same", "native-b"),
    ]),
  ]);
  assert.equal(result.totals.inputTokens, 2500);
  assert.equal(result.totals.outputTokens, 20);
});

test("forced helper routes do not count a Jev request that never happened", () => {
  const result = summarizeRouting([
    {
      at: now,
      entry: {
        type: "route",
        scope: "helper",
        route: { source: "jev" },
        jev: { isAnswered: true, ms: 0, inputTokens: 0, keyMs: 0 },
      },
    },
  ]);
  assert.equal(result.routes.helper, 1);
  assert.equal(result.jev.calls, 0);
});

test("host saves a private key outside session history and removes only its own key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "auto-key-test-"));
  const context = {
    experimental_paths: {
      dataDir: join(directory, "host-data"),
      tempDir: directory,
    },
    signal: new AbortController().signal,
    lifecycle: { signal: new AbortController().signal },
    experimental_emitSignal: async () => {},
    experimental_watch: async () => ({ dispose: async () => {} }),
    experimental_retainWorker: () => ({ dispose: async () => {} }),
  };
  await host.handlers.configureJevKey(
    { key: "not-a-real-secret", onePasswordReference: "" },
    context,
  );
  assert.equal(
    (await stat(join(directory, "jev-credential"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    await readFile(join(directory, "jev-credential"), "utf8"),
    "not-a-real-secret",
  );
  assert.deepEqual(await host.handlers.keyStatus({}, context), {
    configured: true,
  });
  await host.handlers.configureJevKey(
    { key: null, onePasswordReference: "" },
    context,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("classifier credentials stay private and separate when the provider changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilot-provider-keys-"));
  const context = {
    experimental_paths: {
      dataDir: join(directory, "host-data"),
      tempDir: directory,
    },
    signal: new AbortController().signal,
    lifecycle: { signal: new AbortController().signal },
    experimental_emitSignal: async () => {},
    experimental_watch: async () => ({ dispose: async () => {} }),
    experimental_retainWorker: () => ({ dispose: async () => {} }),
  };
  for (const provider of ["jev", "openai", "anthropic"] as const) {
    const configuration = defaultClassifierConfig(provider);
    const result = await host.handlers.configureClassifier(
      {
        configuration,
        key: `test-secret-${provider}`,
        onePasswordReference: "",
      },
      context,
    );
    assert.deepEqual(result, { configured: true });
    assert.deepEqual(await host.handlers.keyStatus({}, context), {
      configured: true,
    });
    const file = join(
      directory,
      provider === "jev" ? "jev-credential" : `jev-credential.${provider}`,
    );
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(file, "utf8"), `test-secret-${provider}`);
    const saved = await readFile(
      join(directory, "jev-credential.configuration"),
      "utf8",
    );
    assert.deepEqual(JSON.parse(saved), configuration);
    assert.equal(saved.includes("test-secret"), false);
  }
  assert.equal(
    await readFile(join(directory, "jev-credential"), "utf8"),
    "test-secret-jev",
  );
  assert.equal(
    await readFile(join(directory, "jev-credential.openai"), "utf8"),
    "test-secret-openai",
  );
});

test("public onboarding returns only status and provider launch provisions privately before execution", async () => {
  const calls: { method: string; input: unknown; hostId: string }[] = [];
  const fake = createFakePluginHost({
    pluginId: "auto-router",
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      calls.push({ method, input, hostId });
      if (method === "configureClassifier") return { configured: true };
      if (method === "keyStatus") return { configured: true };
      if (method === "listSessions") return { sessions: [], limited: false };
      return { ok: true, message: "Connected" };
    },
    sdk: {
      plugins: {
        getSettings: async () => ({ ok: true, schema: {}, values: {} }),
      },
      system: { config: async () => ({ primaryHostId: "host-test" }) },
    },
  });
  await plugin(fake.bb);
  try {
    const response = await fake.harness.callRpc("saveJevKey", {
      key: "not-a-real-secret",
    });
    assert.equal(JSON.stringify(response).includes("not-a-real-secret"), false);
    assert.equal(calls[0]?.method, "configureClassifier");
    assert.equal(calls[0]?.hostId, "host-test");
    const env = await fake.harness.resolveProviderEnv("auto", {
      hostId: "host-test",
      threadId: "thread-test",
      projectId: "project-test",
    });
    assert.deepEqual(env, []);
    const result = await fake.harness.callRpc("dashboard", {
      days: 7,
      baselineModel: "claude-opus-5-5",
    });
    assert.equal(JSON.stringify(result).includes("not-a-real-secret"), false);
    const descriptor = fake.harness.registrations.settingsDescriptors.jevApiKey;
    assert.ok(descriptor?.type === "string");
    assert.equal(descriptor.secret, true);
  } finally {
    await fake.harness.dispose();
  }
});

test("truncated sessions exclude the first cumulative checkpoint for each native session", () => {
  const saved = session("a", "thread-a", [
    usage(now - 4000, 100000, "old", "native-a"),
    usage(now - 3000, 101500, "new", "native-a"),
    usage(now - 2000, 80000, "old", "native-b"),
    usage(now - 1000, 80500, "new", "native-b"),
  ]);
  saved.truncated = true;
  const result = dashboard([saved]);
  assert.equal(result.totals.inputTokens, 2000);
  assert.equal(result.totals.outputTokens, 0);
  assert.equal(
    result.trend.reduce((n, b) => n + b.inputTokens, 0),
    2000,
  );
  assert.equal(result.summary.usageTurns, 2);
  assert.match(result.coverage.warnings.join(" "), /excluded checkpoint/);
});

test("dashboard identifies legacy hidden helper sessions from BB thread metadata", async () => {
  const saved = session("legacy", "hidden-helper", [
    usage(now - 1000, 1000, "turn"),
  ]);
  const fake = createFakePluginHost({
    pluginId: "auto-router",
    experimental_callHostRpc: async ({ method }) =>
      method === "listSessions"
        ? { sessions: [saved], limited: false }
        : { configured: false },
    sdk: {
      plugins: {
        getSettings: async () => ({ ok: true, schema: {}, values: {} }),
      },
      system: { config: async () => ({ primaryHostId: "host-test" }) },
      threads: {
        get: async () =>
          makeThreadResponse({
            id: "hidden-helper",
            originPluginId: "auto-router",
            visibility: "hidden",
          }),
      },
    },
  });
  await plugin(fake.bb);
  try {
    const response = await fake.harness.callRpc("dashboard", {
      days: 90,
      baselineModel: "claude-opus-5-5",
    });
    const data = dashboardSchema.parse(response);
    assert.equal(data.totals.helpers, 1);
    assert.equal(data.totals.threads, 0);
    assert.equal(data.threads[0]?.helper, true);
  } finally {
    await fake.harness.dispose();
  }
});
