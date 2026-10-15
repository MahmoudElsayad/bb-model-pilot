import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  providerUsageResultSchema,
  threadDeltaNotificationParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_assembleCapturedThreadEvents,
  experimental_runBridgeConformance,
  experimental_formatConformanceReport,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import host, {
  helperRoute,
  makeAutoBridge,
  nativeOptions,
  readAutoSession,
} from "./host.js";
import {
  rpcMessageSchema,
  type RpcMessage,
  type LaunchBridge,
  type BridgeClient,
} from "./transport.js";
import type { JevAsk, JevReply } from "./routing/jev.js";

const permissions = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} as const;
const options = {
  ...permissions,
  model: "auto",
  instructions: "Keep all existing instructions.",
  providerOptions: {
    additionalWorkspaceWriteRoots: ["/private/tmp/auto-test-storage"],
    nativeProviderOptions: {
      codex: { memoryEnabled: false },
      "claude-code": { sandboxEnabled: true },
    },
  },
};
const jev: JevReply = {
  answers: {
    model: { choice: "gpt-6-luna", confidence: 0.95 },
    effort: { choice: "low", confidence: 1 },
    window: { choice: "200k", confidence: 1 },
    delegate: { choice: "no", confidence: 1 },
  },
  jev: { isAnswered: true, ms: 3, inputTokens: 200, keyMs: 0 },
};

async function harness(ask: JevAsk = async () => jev, completeTurns = false) {
  const directory = await mkdtemp(join(tmpdir(), "auto-bridge-test-"));
  const messages: RpcMessage[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const launches: {
    args: Parameters<LaunchBridge>[0];
    bridge: BridgeClient;
    closed: boolean;
  }[] = [];
  let lastNativeTurn = 0;
  const launch: LaunchBridge = async (args) => {
    const record = { args, closed: false, bridge: null as BridgeClient | null };
    const bridge: BridgeClient = {
      async request(method, params) {
        calls.push({ method, params });
        const p = z.record(z.string(), z.unknown()).parse(params);
        if (method === "initialize")
          return {
            protocolVersion: 2,
            capabilities: { grammarVersions: [3, 3] },
          };
        if (method === "thread/start" || method === "thread/resume") {
          args.onMessage({
            jsonrpc: "2.0",
            method: "thread/identity",
            params: { threadId: p.threadId, providerThreadId: "native-123" },
          });
          args.onMessage({
            jsonrpc: "2.0",
            method: "thread/delta",
            params: {
              threadId: p.threadId,
              deltas: [{ kind: "session.reset" }],
            },
          });
          return { providerThreadId: "native-123" };
        }
        if (method === "turn/start" || method === "turn/steer") {
          const turnId = `native-turn-${++lastNativeTurn}`;
          args.onMessage({
            jsonrpc: "2.0",
            method: "thread/delta",
            params: {
              threadId: p.threadId,
              deltas: [
                {
                  kind: "input.accepted",
                  clientRequestId: p.clientRequestId,
                  providerTurnId: turnId,
                },
                { kind: "turn.open", providerTurnId: turnId },
              ],
            },
          });
          if (completeTurns)
            args.onMessage({
              jsonrpc: "2.0",
              method: "thread/delta",
              params: {
                threadId: p.threadId,
                deltas: [
                  {
                    kind: "item.close",
                    key: { providerItemId: `answer-${lastNativeTurn}` },
                    item: { type: "agentMessage", text: "Hello." },
                    status: "completed",
                    providerTurnId: turnId,
                  },
                  {
                    kind: "turn.boundary",
                    status: "completed",
                    providerTurnId: turnId,
                  },
                ],
              },
            });
          return { threadId: p.threadId };
        }
        return { ok: true };
      },
      send(message) {
        calls.push({ method: "response", params: message });
      },
      close() {
        record.closed = true;
      },
    };
    record.bridge = bridge;
    launches.push({ ...record, bridge });
    return bridge;
  };
  const bridge = makeAutoBridge({
    ask,
    launch,
    write(line) {
      messages.push(rpcMessageSchema.parse(JSON.parse(line)));
    },
  });
  bridge.start?.({
    pluginId: "auto-router",
    dataDir: directory,
    tempDir: directory,
  });
  let id = 0;
  function send(method: string, params: unknown) {
    const current = ++id;
    bridge.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: current, method, params }),
    );
    return current;
  }
  async function response(id: number) {
    for (let count = 0; count < 400; count++) {
      const answer = messages.find(
        (message) => message.id === id && message.method === undefined,
      );
      if (answer) return answer;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`No response to ${id}: ${JSON.stringify(messages)}`);
  }
  async function start(model = "auto") {
    const answer = await response(
      send("thread/start", {
        threadId: "bb-thread",
        cwd: directory,
        options: { ...options, model },
        instructionMode: "replace",
        dynamicTools: [
          {
            name: "auto_plan",
            description: "Plan",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    assert.equal(answer.error, undefined);
    return z.object({ providerThreadId: z.string() }).parse(answer.result)
      .providerThreadId;
  }
  const turn = (autoId: string, clientRequestId = "creq_abcdefghij") =>
    send("turn/start", {
      threadId: "bb-thread",
      providerThreadId: autoId,
      input: [{ type: "text", text: "Say hello.", mentions: [] }],
      clientRequestId,
      options,
    });
  return {
    directory,
    messages,
    calls,
    launches,
    bridge,
    send,
    response,
    start,
    turn,
  };
}

test("defers native launch, preserves permissions and tools, and emits one identity/reset", async () => {
  const h = await harness();
  const id = await h.start();
  assert.equal(h.launches.length, 0);
  assert.equal((await h.response(h.turn(id))).error, undefined);
  assert.equal(h.launches.length, 1);
  const construction = z
    .object({
      options: z.record(z.string(), z.unknown()),
      dynamicTools: z.array(z.unknown()),
      instructionMode: z.string(),
    })
    .parse(h.calls.find((call) => call.method === "thread/start")?.params);
  for (const [key, value] of Object.entries(permissions))
    assert.equal(construction.options[key], value);
  assert.equal(construction.options.instructions, options.instructions);
  assert.equal(construction.options.model, "gpt-6-luna");
  assert.equal(construction.options.reasoningLevel, "low");
  assert.deepEqual(
    z
      .object({ additionalWorkspaceWriteRoots: z.array(z.string()) })
      .parse(construction.options.providerOptions)
      .additionalWorkspaceWriteRoots,
    ["/private/tmp/auto-test-storage"],
  );
  assert.equal(construction.instructionMode, "replace");
  assert.equal(construction.dynamicTools.length, 1);
  assert.equal(
    h.messages.filter((message) => message.method === "thread/identity").length,
    1,
  );
  const deltas = h.messages
    .filter((message) => message.method === "thread/delta")
    .flatMap(
      (message) =>
        threadDeltaNotificationParamsSchema.parse(message.params).deltas,
    );
  assert.equal(
    deltas.filter((delta) => delta.kind === "session.reset").length,
    1,
  );
  assert(
    deltas.some(
      (delta) =>
        delta.kind === "item.close" &&
        delta.item.type === "agentMessage" &&
        delta.item.text.includes("Luna"),
    ),
  );
  const events = experimental_assembleCapturedThreadEvents(h.messages, "auto");
  assert(
    events.some(
      (event) =>
        event.type === "item/completed" &&
        event.item.type === "agentMessage" &&
        event.item.text.includes("Luna"),
    ),
  );
  h.bridge.onClose?.();
});

test("persists native identity and resumes through the original provider", async () => {
  const h = await harness();
  const id = await h.start();
  await h.response(h.turn(id));
  await h.response(
    h.send("thread/stop", {
      threadId: "bb-thread",
      providerThreadId: id,
      intent: "release",
      activeTurnId: null,
    }),
  );
  const saved = await readAutoSession(h.directory, "bb-thread");
  assert.equal(saved?.nativeId, "native-123");
  assert.equal(saved?.route?.model, "gpt-6-luna");
  assert.equal(saved?.revision, "creq_abcdefghij");
  const answer = await h.response(
    h.send("thread/resume", {
      threadId: "bb-thread",
      providerThreadId: id,
      cwd: h.directory,
      options,
      instructionMode: "replace",
    }),
  );
  assert.equal(answer.error, undefined);
  await h.response(h.turn(id, "creq_abcdefghik"));
  assert(
    h.calls.some(
      (call) =>
        call.method === "thread/resume" &&
        z.object({ providerThreadId: z.string() }).parse(call.params)
          .providerThreadId === "native-123",
    ),
  );
  h.bridge.onClose?.();
});

test("forwards native tool calls with synthetic identity and returns the native request id", async () => {
  const h = await harness();
  const id = await h.start();
  await h.response(h.turn(id));
  const native = h.launches[0];
  assert(native);
  native.args.onMessage({
    jsonrpc: "2.0",
    id: 22,
    method: "item/tool/call",
    params: {
      threadId: "bb-thread",
      providerThreadId: "native-123",
      tool: "auto_plan",
      arguments: {},
    },
  });
  const tool = h.messages.find(
    (message) => message.method === "item/tool/call",
  );
  assert(tool);
  assert.equal(
    z.object({ providerThreadId: z.string() }).parse(tool.params)
      .providerThreadId,
    id,
  );
  h.bridge.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: tool.id,
      result: { content: [{ type: "text", text: "done" }] },
    }),
  );
  assert.equal(
    z
      .object({ id: z.number() })
      .parse(h.calls.find((call) => call.method === "response")?.params).id,
    22,
  );
  h.bridge.onClose?.();
});

test("cancels routing and queued turns before native startup", async () => {
  let release: ((reply: JevReply) => void) | undefined;
  const h = await harness(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const id = await h.start();
  const first = h.turn(id);
  const second = h.turn(id, "creq_abcdefghik");
  await new Promise((resolve) => setImmediate(resolve));
  await h.response(
    h.send("thread/stop", {
      threadId: "bb-thread",
      providerThreadId: id,
      intent: "interrupt",
      activeTurnId: null,
    }),
  );
  assert(release);
  release(jev);
  assert.match((await h.response(first)).error?.message ?? "", /cancelled/);
  assert.match((await h.response(second)).error?.message ?? "", /cancelled/);
  assert.equal(h.launches.length, 0);
  h.bridge.onClose?.();
});

test("release emits no fabricated turn boundary", async () => {
  const h = await harness();
  const id = await h.start();
  await h.response(h.turn(id));
  const before = h.messages.length;
  await h.response(
    h.send("thread/stop", {
      threadId: "bb-thread",
      providerThreadId: id,
      intent: "release",
      activeTurnId: null,
    }),
  );
  assert.equal(
    h.messages
      .slice(before)
      .filter((message) => message.method === "thread/delta").length,
    0,
  );
});

test("steering and helper completion reports preserve the plan revision and do not call Jev again", async () => {
  let asks = 0;
  const h = await harness(async () => {
    asks += 1;
    return jev;
  });
  const id = await h.start();
  await h.response(h.turn(id));
  const reply = await h.response(
    h.send("turn/steer", {
      threadId: "bb-thread",
      providerThreadId: id,
      input: [
        {
          type: "text",
          text: "[bb system]\n\nA helper completed its task.",
          mentions: [],
        },
      ],
      clientRequestId: "creq_abcdefghik",
      expectedTurnId: "native-turn-1",
      options,
    }),
  );
  assert.equal(reply.error, undefined);
  assert.equal(asks, 1);
  const saved = await readAutoSession(h.directory, "bb-thread");
  assert.equal(saved?.revision, "creq_abcdefghij");
  assert.equal(saved?.turnCount, 1);
  h.bridge.onClose?.();
});

test("background completion and failure reports preserve the active plan after the parent becomes idle", async () => {
  let asks = 0;
  const h = await harness(async () => {
    asks += 1;
    return jev;
  });
  const id = await h.start();
  await h.response(h.turn(id));
  for (const status of ["completed", "failed"]) {
    const reply = await h.response(
      h.send("turn/start", {
        threadId: "bb-thread",
        providerThreadId: id,
        input: [
          {
            type: "text",
            text: `[bb system]\n\n@thread:thr_k2abc234 ${status}:\nThe helper report.`,
            mentions: [],
          },
        ],
        clientRequestId: "creq_abcdefghik",
        options,
      }),
    );
    assert.equal(reply.error, undefined);
  }
  assert.equal(asks, 1);
  const saved = await readAutoSession(h.directory, "bb-thread");
  assert.equal(saved?.revision, "creq_abcdefghij");
  assert.equal(saved?.turnCount, 1);
  assert.deepEqual(saved?.delegation, {
    delegate: false,
    share: 0,
    helper: null,
  });
  h.bridge.onClose?.();
});

test("helper models bypass Jev and preserve the selected Claude context window", async () => {
  const h = await harness(async () => {
    throw new Error("Jev must not route a forced helper");
  });
  const id = await h.start("auto-helper:claude-opus-5-5:high:200k");
  assert.equal((await h.response(h.turn(id))).error, undefined);
  const construction = z
    .object({
      options: z.object({
        model: z.string(),
        reasoningLevel: z.string(),
        providerOptions: z.object({
          disable1MContext: z.boolean(),
          sandboxEnabled: z.boolean(),
        }),
      }),
    })
    .parse(h.calls.find((call) => call.method === "thread/start")?.params);
  assert.equal(construction.options.model, "claude-opus-5-5");
  assert.equal(construction.options.reasoningLevel, "high");
  assert.equal(construction.options.providerOptions.disable1MContext, true);
  assert.equal(construction.options.providerOptions.sandboxEnabled, true);
  assert.throws(() => helperRoute("auto-helper:unknown-model:high:200k"));
  assert.throws(() =>
    helperRoute("auto-helper:claude-haiku-4-5-20251001:low:1m"),
  );
  h.bridge.onClose?.();
});

test("usage response conforms to the SDK and invalid parameters reply with protocol errors", async () => {
  const h = await harness();
  const catalog = z
    .object({
      models: z.array(z.object({ id: z.string() })),
      selectedOnlyModels: z.array(z.object({ id: z.string() })),
    })
    .parse((await h.response(h.send("model/list", {}))).result);
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ["auto"],
  );
  assert.equal(catalog.selectedOnlyModels.length, 52);
  assert(
    catalog.selectedOnlyModels.some(
      (model) => model.id === "auto-helper:claude-opus-5-5:high:200k",
    ),
  );
  providerUsageResultSchema.parse(
    (await h.response(h.send("provider/usage", { providerId: "auto" }))).result,
  );
  assert.equal(
    (await h.response(h.send("thread/start", {}))).error?.code,
    -32602,
  );
  assert.equal(
    (await h.response(h.send("unknown/method", {}))).error?.code,
    -32601,
  );
  h.bridge.onClose?.();
});

test("host RPC reads the bridge-data sibling and ignores corrupt saved files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "auto-host-paths-"));
  const bridgeDir = join(directory, "bridge-data");
  const hostDir = join(directory, "host-data");
  await mkdir(join(bridgeDir, "sessions"), { recursive: true });
  await writeFile(join(bridgeDir, "sessions", "0000.json"), "broken");
  const h = await harness();
  const id = await h.start();
  await h.response(h.turn(id));
  await writeFile(
    join(bridgeDir, "sessions", `${id}.json`),
    await readFile(join(h.directory, "sessions", `${id}.json`)),
  );
  const result = await host.handlers.getSession(
    { threadId: "bb-thread" },
    {
      experimental_paths: { dataDir: hostDir, tempDir: directory },
      signal: new AbortController().signal,
      lifecycle: { signal: new AbortController().signal },
      experimental_emitSignal: async () => {},
      experimental_watch: async () => ({ dispose: async () => {} }),
      experimental_retainWorker: () => ({ dispose: async () => {} }),
    },
  );
  assert.equal(result.route?.model, "gpt-6-luna");
  assert.equal(result.revision, "creq_abcdefghij");
  h.bridge.onClose?.();
});

test("native options retain every permission mode without upgrading access", () => {
  const route = {
    model: "claude-opus-5-5",
    effort: "high",
    window: "1m",
    source: "jev",
    confidence: 1,
  } as const;
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(permissions).map((key) => [
        key,
        z.record(z.string(), z.unknown()).parse(nativeOptions(options, route))[
          key
        ],
      ]),
    ),
    permissions,
  );
});

test("passes the published BB provider bridge conformance kit", async () => {
  const h = await harness(async () => jev, true);
  let drained = 0;
  const report = await experimental_runBridgeConformance({
    providerId: "auto",
    timeoutMs: 1000,
    transport: {
      send(line) {
        h.bridge.handleLine(line);
      },
      takeMessages() {
        const fresh = h.messages.slice(drained);
        drained = h.messages.length;
        return fresh;
      },
      close() {
        h.bridge.onClose?.();
      },
    },
    session: {
      cwd: h.directory,
      promptInput: [{ type: "text", text: "Say hello.", mentions: [] }],
      options,
    },
  });
  assert.equal(
    report.passed,
    true,
    experimental_formatConformanceReport(report),
  );
});
