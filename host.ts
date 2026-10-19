import {
  classifierEnvironment,
  makeNativeClassifierAsk,
} from "./routing/native-classifier.js";
import { withUsage, type ProviderUsage } from "./routing/usage.js";
import {
  bbRateLimitsSchema,
  bbUsage,
  makeUsageReader,
  readCodexLimits,
  recordUsage,
} from "./routing/usage-sources.js";
import {
  classifierConfigSchema,
  defaultClassifierConfig,
  makeClassifierAsk,
  CONNECTION_QUESTIONS,
  type ClassifierConfig,
  type ClassifierProvider,
} from "./routing/classifier.js";
import { lineSchema } from "./report.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
  chmod,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  skillsConfigureParamsSchema,
  threadDeltaNotificationParamsSchema,
  threadDiscardParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type AvailableModel,
  type ProviderBridgeContext,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { hostContract, delegationSchema } from "./contract.js";
import { NO_JEV_CALL, type JevAsk, readJevKey } from "./routing/jev.js";
import { modelInfo } from "./routing/models.js";
import {
  makeThreadRouter,
  planSchema,
  routeSchema,
  type RouteRecord,
  type RouteReply,
} from "./routing/router.js";
import {
  HELPER_MODELS,
  stepForHandOff,
  type Plan,
  type Route,
} from "./routing/core.js";
import {
  helperRowPresentation,
  planRowPresentation,
  routeRow,
  routeRowPresentation,
  ROUTE_ROW_KIND,
  type RouteRow,
} from "./routing/display.js";
import {
  launchBridge,
  rpcMessageSchema,
  type BridgeClient,
  type LaunchBridge,
  type RpcMessage,
} from "./transport.js";

export const DEFAULT_BB_ROOT =
  "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app";
const settingsSchema = z
  .object({
    bbRoot: z.string().default(DEFAULT_BB_ROOT),
    additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
    nativeProviderOptions: z
      .object({
        codex: z.record(z.string(), z.unknown()).default({}),
        "claude-code": z.record(z.string(), z.unknown()).default({}),
      })
      .default({ codex: {}, "claude-code": {} }),
  })
  .passthrough();
const savedSessionSchema = z.object({
  autoId: z.uuid(),
  threadId: z.string(),
  route: routeSchema.nullable(),
  delegation: delegationSchema.nullable().default(null),
  revision: z.string().nullable().default(null),
  helper: z.boolean().default(false),
  updatedAt: z.number().default(0),
  nativeId: z.string().nullable(),
  turnCount: z.number().int().nonnegative(),
});
type SavedSession = z.infer<typeof savedSessionSchema>;
type Construction = z.infer<typeof threadStartParamsSchema>;
type Turn = z.infer<typeof turnStartParamsSchema>;
type Session = {
  saved: SavedSession;
  construction: Construction;
  native: BridgeClient | null;
  nativeReady: Promise<void> | null;
  cancelled: number;
  activeTurn: string | null;
  routeRow: RouteRow | null;
  closing: boolean;
  queue: Promise<void>;
  ledger: Promise<void>;
  persistence: Promise<void>;
};

export function helperRoute(model: string | undefined): Route | null {
  if (!model?.startsWith("auto-helper:")) return null;
  const [prefix, selected, effort, window, extra] = model.split(":");
  const route = routeSchema.parse({
    model: selected,
    effort,
    window,
    confidence: 1,
    source: "jev",
  });
  if (
    prefix !== "auto-helper" ||
    extra !== undefined ||
    modelInfo(route.model) === undefined
  ) {
    throw new Error("Invalid Auto helper model");
  }
  if (modelInfo(route.model)?.maxWindow === "200k" && route.window === "1m") {
    throw new Error("The selected helper does not support a 1M context window");
  }
  return route;
}

export async function readAutoSession(
  dataDir: string,
  threadId: string,
): Promise<SavedSession | null> {
  const names = await readdir(join(dataDir, "sessions")).catch(() => []);
  let latest: SavedSession | null = null;
  for (const name of names) {
    if (!/^[0-9a-f-]+\.json$/.test(name)) continue;
    try {
      const saved = savedSessionSchema.safeParse(
        JSON.parse(await readFile(join(dataDir, "sessions", name), "utf8")),
      );
      if (
        saved.success &&
        saved.data.threadId === threadId &&
        (latest === null || saved.data.updatedAt >= latest.updatedAt)
      )
        latest = saved.data;
    } catch {}
  }
  return latest;
}

export function nativeOptions(
  options: Construction["options"],
  route: Route,
): Construction["options"] {
  const settings = settingsSchema.parse(options.providerOptions ?? {});
  const provider =
    modelInfo(route.model)?.provider === "codex" ? "codex" : "claude-code";
  return {
    ...options,
    model: route.model,
    reasoningLevel: route.effort,
    providerOptions: {
      ...settings.nativeProviderOptions[provider],
      ...(settings.additionalWorkspaceWriteRoots === undefined
        ? {}
        : {
            additionalWorkspaceWriteRoots:
              settings.additionalWorkspaceWriteRoots,
          }),
      ...(provider === "claude-code"
        ? {
            disable1MContext: route.window !== "1m",
            ...(options.promptMode === "plan"
              ? { claudeCodePermissionMode: "plan" }
              : {}),
          }
        : {}),
    },
  };
}

function adaptedRoutingNote(note: string | null): string | null {
  return (
    note
      ?.replaceAll("the plan tool", "the auto_plan tool")
      .replaceAll("the delegate tool", "the auto_delegate tool")
      .replaceAll("call step_done", "call auto_step_done") ?? null
  );
}

export function makeAutoBridge(
  deps: {
    write?: (line: string) => void;
    ask?: JevAsk;
    launch?: LaunchBridge;
  } = {},
) {
  const io = createBridgeIo<RpcMessage>({ write: deps.write });
  const ask: JevAsk =
    deps.ask ??
    ((state, questions) => askWithUsage(dataDir(), state, questions));
  const launch = deps.launch ?? launchBridge;
  let context: ProviderBridgeContext | null = null;
  let closed = false;
  let requestSequence = 0;
  const sessions = new Map<string, Session>();
  const runtimeRequests = new Map<
    string,
    { child: BridgeClient; nativeId: string | number }
  >();
  let skills: z.infer<typeof skillsConfigureParamsSchema> | null = null;
  const dataDir = () => {
    if (context === null)
      throw new Error("Auto bridge did not receive its persistent directory");
    return context.dataDir;
  };
  const sessionFile = (id: string) =>
    join(dataDir(), "sessions", `${z.uuid().parse(id)}.json`);
  function persist(session: Session) {
    const operation = session.persistence.then(async () => {
      session.saved.updatedAt = Date.now();
      const target = sessionFile(session.saved.autoId);
      await mkdir(join(dataDir(), "sessions"), {
        recursive: true,
        mode: 0o700,
      });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(session.saved), {
        mode: 0o600,
      });
      await rename(temporary, target);
    });
    session.persistence = operation.catch(() => {});
    return operation;
  }
  async function record(threadId: string, entry: RouteRecord) {
    const session = sessions.get(threadId);
    if (session === undefined)
      throw new Error("Auto session disappeared during routing");
    session.saved.route = entry.route;
    session.saved.delegation = entry.delegation;
    await persist(session);
    await appendLedger(session, entry);
  }
  function appendLedger(session: Session, entry: unknown) {
    const target = join(
      dataDir(),
      "sessions",
      `${session.saved.autoId}.ndjson`,
    );
    const work = session.ledger.then(async () => {
      if (
        await stat(target)
          .then((value) => value.size > 2_000_000)
          .catch(() => false)
      ) {
        const lines = (await readFile(target, "utf8"))
          .trim()
          .split("\n")
          .slice(-100);
        await writeFile(target, `${lines.join("\n")}\n`, { mode: 0o600 });
      }
      await appendFile(
        target,
        `${JSON.stringify({ at: Date.now(), entry })}\n`,
        { mode: 0o600 },
      );
    });
    session.ledger = work.catch((error: unknown) => {
      process.stderr.write(
        `Auto audit log failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    return work;
  }
  const route = makeThreadRouter({
    ask,
    record,
    lastRoute: async (threadId) =>
      sessions.get(threadId)?.saved.route ?? undefined,
  });
  function deltas(session: Session, value: ThreadDelta[]) {
    io.send({
      jsonrpc: "2.0",
      method: "thread/delta",
      params: { threadId: session.saved.threadId, deltas: value },
    });
  }
  function announce(session: Session) {
    io.send({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: {
        threadId: session.saved.threadId,
        providerThreadId: session.saved.autoId,
        sessionRestorable: true,
      },
    });
    deltas(session, [{ kind: "session.reset" }]);
  }
  function getSession(threadId: string, autoId?: string) {
    const session = sessions.get(threadId);
    if (
      session === undefined ||
      session.closing ||
      (autoId !== undefined && session.saved.autoId !== autoId)
    ) {
      throw new Error(`No active Auto session for thread ${threadId}`);
    }
    return session;
  }
  /**
   * The plan the server routed for this thread, written by the host's notePlan handler. A plan
   * names each helper step's model, so plan and helper rows can show it.
   */
  function routedPlan(threadId: string): Plan | undefined {
    try {
      const parsed = planSchema.safeParse(
        JSON.parse(readFileSync(planFile(dataDir(), threadId), "utf8")),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  /** Routing tool rows as BB shows them: the plan's assignments and each helper's model. */
  function decorated(session: Session, delta: ThreadDelta): ThreadDelta {
    if (
      (delta.kind !== "item.open" && delta.kind !== "item.close") ||
      delta.item.type !== "tool"
    )
      return delta;
    if (delta.item.tool === "auto_plan") {
      const plan =
        delta.kind === "item.close" && delta.status === "completed"
          ? routedPlan(session.saved.threadId)
          : undefined;
      return { ...delta, presentation: planRowPresentation(plan) };
    }
    if (delta.item.tool === "auto_delegate") {
      const args = z
        .object({
          task: z.string().default(""),
          step: z.number().int().optional(),
        })
        .safeParse(delta.item.args ?? {});
      const step = args.success
        ? stepForHandOff(
            routedPlan(session.saved.threadId) ?? [],
            args.data.step,
            args.data.task,
          )
        : undefined;
      const helper = step?.helper ?? session.saved.delegation?.helper ?? null;
      return helper === null
        ? delta
        : { ...delta, presentation: helperRowPresentation(helper, step) };
    }
    return delta;
  }
  /** Keeps the latest usage report, so the next routing decision can read it. */
  function noteUsage(session: Session, delta: ThreadDelta) {
    const now = Date.now();
    const provider =
      modelInfo(session.saved.route?.model ?? "")?.provider ?? null;
    const report =
      delta.kind === "provider.rateLimits"
        ? bbRateLimitsSchema.safeParse(delta.rateLimits)
        : null;
    const usage =
      report !== null
        ? report.success
          ? bbUsage(report.data, now)
          : null
        : delta.kind === "provider.error" &&
            (delta.category ?? delta.errorInfo?.category) === "rate-limit" &&
            delta.willRetry !== true &&
            provider !== null
          ? {
              provider,
              status: "blocked" as const,
              reason: null,
              resetsAtMs: null,
              checkedAtMs: now,
            }
          : null;
    if (usage === null) return;
    void recordUsage(dirname(credentialFile(dataDir())), usage).catch(
      (error: unknown) =>
        process.stderr.write(
          `Auto usage record failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
    );
  }
  function nativeMessage(session: Session, message: RpcMessage) {
    if (session.closing || closed) return;
    if (message.method === "thread/identity") {
      const identity = z
        .object({ providerThreadId: z.string().min(1) })
        .parse(message.params);
      session.saved.nativeId = identity.providerThreadId;
      void persist(session).catch((error: unknown) =>
        process.stderr.write(
          `Auto identity persistence failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
      return;
    }
    if (message.method === "thread/delta") {
      const parsed = threadDeltaNotificationParamsSchema.parse(message.params);
      const output: z.infer<
        typeof threadDeltaNotificationParamsSchema
      >["deltas"] = [];
      for (const delta of parsed.deltas) {
        if (delta.kind === "session.reset" || delta.kind === "thread.identity")
          continue;
        output.push(decorated(session, delta));
        if (delta.kind === "turn.open") {
          session.activeTurn = delta.providerTurnId ?? "auto-active";
          if (session.routeRow !== null) {
            const key = { providerItemId: `auto-routing-${randomUUID()}` };
            const item = {
              type: "extension" as const,
              kind: ROUTE_ROW_KIND,
              payload: session.routeRow,
            };
            const presentation = routeRowPresentation(session.routeRow);
            output.push({
              kind: "item.open",
              key,
              item,
              presentation,
              providerTurnId: delta.providerTurnId,
            });
            output.push({
              kind: "item.close",
              key,
              item,
              presentation,
              status: "completed",
              providerTurnId: delta.providerTurnId,
            });
            session.routeRow = null;
          }
        }
        if (delta.kind === "turn.boundary") session.activeTurn = null;
        noteUsage(session, delta);
        if (delta.kind === "usage")
          void appendLedger(session, {
            type: "usage",
            model: session.saved.route?.model,
            nativeSessionId: session.saved.nativeId ?? undefined,
            usage: delta,
          });
      }
      if (output.length > 0)
        io.send({
          jsonrpc: "2.0",
          method: message.method,
          params: {
            ...parsed,
            threadId: session.saved.threadId,
            deltas: output,
          },
        });
      return;
    }
    const params = z.record(z.string(), z.unknown()).safeParse(message.params);
    const forwarded = params.success
      ? {
          ...message,
          params: {
            ...params.data,
            ...(typeof params.data.providerThreadId === "string"
              ? { providerThreadId: session.saved.autoId }
              : {}),
          },
        }
      : message;
    if (message.id !== undefined && message.method !== undefined) {
      const child = session.native;
      if (child === null)
        throw new Error(
          "Native provider requested a tool before startup completed",
        );
      const id = `auto-runtime-${++requestSequence}`;
      runtimeRequests.set(id, { child, nativeId: message.id });
      io.send({ ...forwarded, id });
    } else io.send(forwarded);
  }
  function nativeExit(session: Session, error: Error) {
    session.native = null;
    session.nativeReady = null;
    if (session.closing || closed) return;
    if (session.activeTurn !== null) {
      deltas(session, [
        {
          kind: "turn.boundary",
          providerTurnId: session.activeTurn,
          status: "failed",
          error: { message: error.message },
        },
      ]);
      session.activeTurn = null;
    }
    io.send({
      jsonrpc: "2.0",
      method: "error",
      params: {
        threadId: session.saved.threadId,
        providerThreadId: session.saved.autoId,
        message: error.message,
      },
    });
  }
  async function ready(
    session: Session,
    options: Construction["options"],
    selected: Route,
  ) {
    if (session.nativeReady !== null) return session.nativeReady;
    const generation = session.cancelled;
    const promise = (async () => {
      const settings = settingsSchema.parse(options.providerOptions ?? {});
      const provider =
        modelInfo(selected.model)?.provider === "codex"
          ? "codex"
          : "claude-code";
      const child = await launch({
        provider,
        bbRoot: settings.bbRoot,
        dataDir: dataDir(),
        onMessage: (message) => nativeMessage(session, message),
        onExit: (error) => {
          if (session.native === child) nativeExit(session, error);
        },
      });
      if (generation !== session.cancelled || session.closing || closed) {
        child.close();
        throw new Error("Auto startup was cancelled");
      }
      session.native = child;
      const init = await child.request("initialize", {
        protocolVersion: 2,
        client: { name: "bb-auto-router", version: "0.1.0" },
        grammarVersions: [3, 3],
      });
      const initialized = z
        .object({
          protocolVersion: z.literal(2),
          capabilities: z
            .object({
              grammarVersions: z.tuple([z.number(), z.number()]),
            })
            .passthrough(),
        })
        .parse(init);
      if (
        initialized.capabilities.grammarVersions[0] > 3 ||
        initialized.capabilities.grammarVersions[1] < 3
      ) {
        throw new Error(
          "Installed BB provider bridge does not support grammar version 3",
        );
      }
      if (skills !== null) await child.request("skills/configure", skills);
      const result = await child.request(
        session.saved.nativeId === null ? "thread/start" : "thread/resume",
        {
          ...session.construction,
          ...(session.saved.nativeId === null
            ? {}
            : { providerThreadId: session.saved.nativeId }),
          options: nativeOptions(
            { ...session.construction.options, ...options },
            selected,
          ),
        },
      );
      session.saved.nativeId = z
        .object({ providerThreadId: z.string().min(1) })
        .parse(result).providerThreadId;
      await persist(session);
      if (generation !== session.cancelled || session.closing || closed)
        throw new Error("Auto startup was cancelled");
    })();
    session.nativeReady = promise;
    try {
      await promise;
    } catch (error) {
      session.native?.close();
      session.native = null;
      session.nativeReady = null;
      throw error;
    }
  }
  async function startTurn(
    session: Session,
    turn: Turn,
    method: "turn/start" | "turn/steer",
    generation: number,
    expectedTurnId?: string,
  ) {
    if (generation !== session.cancelled || session.closing || closed)
      throw new Error("Auto routing was cancelled");
    const prompt = turn.input
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const previous = session.saved.route;
    const continuation =
      method === "turn/steer" ||
      (previous !== null &&
        /^\[bb system\]\s+@thread:thr_[a-z0-9]+ (completed|failed):/.test(
          prompt,
        ));
    if (!continuation) {
      session.saved.revision = turn.clientRequestId;
      await unlink(planFile(dataDir(), turn.threadId)).catch(() => {});
    }
    const forced = helperRoute(session.construction.options.model);
    const decision: RouteReply = continuation
      ? {
          route: previous,
          decision: "routed",
          delegation: session.saved.delegation,
          note: null,
          limits: null,
        }
      : forced === null
        ? await route(
            previous === null
              ? {
                  threadId: turn.threadId,
                  prompt,
                  turn: "first",
                  permissionMode: turn.options.permissionMode,
                }
              : {
                  threadId: turn.threadId,
                  prompt,
                  turn: "later",
                  currentModel: previous.model,
                  permissionMode: turn.options.permissionMode,
                },
          )
        : {
            route: forced,
            decision: "routed",
            delegation: null,
            note: null,
            limits: null,
          };
    if (forced !== null && !continuation)
      await record(turn.threadId, {
        type: "route",
        scope: "helper",
        isFirstPrompt: previous === null,
        description: "Auto provider",
        route: forced,
        jev: NO_JEV_CALL,
        delegation: { delegate: false, share: 0, helper: null },
      });
    if (generation !== session.cancelled || session.closing || closed)
      throw new Error("Auto routing was cancelled");
    const selected = decision.route ?? session.saved.route;
    if (selected === null) throw new Error("Auto did not select a model");
    if (!continuation)
      session.routeRow = routeRow(
        selected,
        decision.delegation,
        previous === null ? "first" : "later",
        decision.limits,
      );
    await ready(session, turn.options, selected);
    const child = session.native;
    const nativeId = session.saved.nativeId;
    if (child === null || nativeId === null)
      throw new Error("Auto native session did not start");
    const note = adaptedRoutingNote(decision.note);
    const input =
      note === null
        ? turn.input
        : [
            ...turn.input,
            {
              type: "text" as const,
              text: note,
              mentions: [],
              visibility: "agent-only" as const,
            },
          ];
    const reply = await child.request(method, {
      ...turn,
      providerThreadId: nativeId,
      input,
      ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
      options: nativeOptions(turn.options, selected),
    });
    if (!continuation) session.saved.turnCount += 1;
    await persist(session);
    return reply;
  }
  async function construct(params: Construction, saved?: SavedSession) {
    const prior = sessions.get(params.threadId);
    if (prior !== undefined) {
      prior.closing = true;
      prior.cancelled += 1;
      prior.native?.close();
    }
    const session: Session = {
      saved: saved ?? {
        autoId: randomUUID(),
        threadId: params.threadId,
        route: null,
        delegation: null,
        revision: null,
        helper: helperRoute(params.options.model) !== null,
        nativeId: null,
        turnCount: 0,
        updatedAt: Date.now(),
      },
      construction: params,
      native: null,
      nativeReady: null,
      cancelled: 0,
      activeTurn: null,
      routeRow: null,
      closing: false,
      queue: Promise.resolve(),
      ledger: Promise.resolve(),
      persistence: Promise.resolve(),
    };
    sessions.set(params.threadId, session);
    await persist(session);
    announce(session);
    return { providerThreadId: session.saved.autoId, sessionRestorable: true };
  }
  const supported = new Set([
    "initialize",
    "model/list",
    "provider/health",
    "provider/usage",
    "thread/start",
    "thread/resume",
    "thread/stop",
    "thread/discard",
    "turn/start",
    "turn/steer",
    "skills/configure",
  ]);
  async function request(message: z.infer<typeof bridgeRequestEnvelopeSchema>) {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize": {
        initializeParamsSchema.parse(params);
        return {
          protocolVersion: 2,
          capabilities: {
            sessionRestore: true,
            fork: "none",
            grammarVersions: [3, 3],
            approvalEnforcedBy: "provider",
            steerMode: "inject",
            skills: { configure: true },
          },
        };
      }
      case "model/list": {
        modelListParamsSchema.parse(params);
        const model: AvailableModel = {
          id: "auto",
          model: "auto",
          displayName: "Model Pilot",
          description:
            "Model Pilot selects a coding model, reasoning effort, context window, and helper policy for the task.",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedServiceTiers: [],
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map(
            (reasoningEffort) => ({
              reasoningEffort: z
                .enum(["low", "medium", "high", "xhigh"])
                .parse(reasoningEffort),
              description:
                "The classification model selects the effort for each routed task.",
            }),
          ),
        };
        const selectedOnlyModels = Object.keys(HELPER_MODELS).flatMap(
          (nativeModel) =>
            ["low", "medium", "high", "xhigh"].flatMap((effort) =>
              (modelInfo(nativeModel)?.maxWindow === "200k"
                ? ["200k"]
                : ["200k", "1m"]
              ).map((window) => {
                const id = `auto-helper:${nativeModel}:${effort}:${window}`;
                return {
                  ...model,
                  id,
                  model: id,
                  isDefault: false,
                  displayName: `Auto helper (${modelInfo(nativeModel)?.name ?? nativeModel}, ${effort}, ${window})`,
                };
              }),
            ),
        );
        return { models: [model], selectedOnlyModels };
      }
      case "provider/health": {
        const maintenance = providerMaintenanceParamsSchema.parse(params);
        const settings = settingsSchema.parse(
          maintenance.providerOptions ?? {},
        );
        const installed = await access(
          join(
            settings.bbRoot,
            "host-daemon/dist/bb-provider-bridge-worker.mjs",
          ),
        ).then(
          () => true,
          () => false,
        );
        return {
          status: installed ? "ready" : "not_installed",
          statusMessage: installed
            ? "Model Pilot uses your existing Codex and Claude Code sign-ins. Connect a separate classification API key in Model Pilot."
            : "The configured BB installation does not contain provider bridges.",
          accountEmail: null,
          planLabel: null,
          installedVersion: null,
          minimumSupportedVersion: null,
          canInstall: false,
          canUpdate: false,
          loginCommand: null,
        };
      }
      case "provider/usage": {
        providerMaintenanceParamsSchema.parse(params);
        return { supported: false };
      }
      case "thread/start":
        return construct(threadStartParamsSchema.parse(params));
      case "thread/resume": {
        const resume = threadResumeParamsSchema.parse(params);
        const id = z.uuid().parse(resume.providerThreadId);
        const saved = savedSessionSchema.parse(
          JSON.parse(await readFile(sessionFile(id), "utf8")),
        );
        if (saved.threadId !== resume.threadId)
          throw new Error(
            "Saved Auto session belongs to a different BB thread",
          );
        return construct(resume, saved);
      }
      case "turn/start":
      case "turn/steer": {
        const turn =
          message.method === "turn/start"
            ? turnStartParamsSchema.parse(params)
            : turnSteerParamsSchema.parse(params);
        const session = getSession(turn.threadId, turn.providerThreadId);
        const expectedTurnId =
          "expectedTurnId" in turn && typeof turn.expectedTurnId === "string"
            ? turn.expectedTurnId
            : undefined;
        const generation = session.cancelled;
        const result = session.queue.then(() =>
          startTurn(
            session,
            turn,
            message.method === "turn/start" ? "turn/start" : "turn/steer",
            generation,
            expectedTurnId,
          ),
        );
        session.queue = result.then(
          () => {},
          () => {},
        );
        return result;
      }
      case "thread/stop": {
        const stop = threadStopParamsSchema.parse(params);
        const session = getSession(stop.threadId, stop.providerThreadId);
        session.cancelled += 1;
        if (stop.intent === "release") {
          session.closing = true;
          session.native?.close();
          sessions.delete(stop.threadId);
          return { ok: true };
        }
        if (session.native !== null && session.saved.nativeId !== null) {
          return session.native.request(message.method, {
            ...stop,
            providerThreadId: session.saved.nativeId,
          });
        }
        return { ok: true };
      }
      case "thread/discard": {
        const discard = threadDiscardParamsSchema.parse(params);
        const session = getSession(discard.threadId, discard.providerThreadId);
        session.closing = true;
        session.cancelled += 1;
        if (session.native !== null && session.saved.nativeId !== null) {
          try {
            await session.native.request(message.method, {
              ...discard,
              providerThreadId: session.saved.nativeId,
            });
          } finally {
            session.native.close();
          }
        }
        sessions.delete(discard.threadId);
        return { ok: true };
      }
      case "skills/configure": {
        skills = skillsConfigureParamsSchema.parse(params);
        await Promise.all(
          [...sessions.values()].map((session) =>
            session.native?.request(message.method, skills),
          ),
        );
        return { ok: true };
      }
      default:
        throw new Error(`Unknown method ${message.method}`);
    }
  }
  function parsedMessage(value: unknown) {
    const decoded = rpcMessageSchema.safeParse(value);
    if (!decoded.success) return;
    const message = decoded.data;
    if (message.method === undefined) {
      const pending =
        typeof message.id === "string"
          ? runtimeRequests.get(message.id)
          : undefined;
      if (pending !== undefined) {
        runtimeRequests.delete(String(message.id));
        pending.child.send({ ...message, id: pending.nativeId });
      }
      return;
    }
    const envelope = bridgeRequestEnvelopeSchema.safeParse(message);
    if (!envelope.success) {
      if (message.id !== undefined)
        io.sendError(message.id, -32602, envelope.error.message);
      return;
    }
    if (!supported.has(envelope.data.method)) {
      io.sendError(
        envelope.data.id,
        -32601,
        `Unknown method ${envelope.data.method}`,
      );
      return;
    }
    void request(envelope.data).then(
      (result) => io.sendResult(envelope.data.id, result),
      (error: unknown) => {
        io.sendError(
          envelope.data.id,
          error instanceof z.ZodError ? -32602 : -32000,
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }
  function close() {
    closed = true;
    for (const session of sessions.values()) {
      session.closing = true;
      session.cancelled += 1;
      session.native?.close();
    }
    sessions.clear();
    runtimeRequests.clear();
  }
  return experimental_defineProviderBridge({
    start(value) {
      context = value;
    },
    handleLine: createBridgeLineHandler({ handleParsedMessage: parsedMessage }),
    onClose: close,
    onSigterm: close,
    onSigint: close,
  });
}

export const experimental_providerBridge = makeAutoBridge();
const credentialFile = (dataDir: string) =>
  join(
    basename(dataDir) === "host-data" || basename(dataDir) === "bridge-data"
      ? dirname(dataDir)
      : dataDir,
    "jev-credential",
  );
const asks = new Map<string, { signature: string; ask: JevAsk }>();
const providerCredentialFile = (
  dataDir: string,
  provider: ClassifierProvider,
) =>
  provider === "jev"
    ? credentialFile(dataDir)
    : `${credentialFile(dataDir)}.${provider}`;
const configurationFile = (dataDir: string) =>
  `${credentialFile(dataDir)}.configuration`;
async function savedKey(
  dataDir: string,
  provider: ClassifierProvider = "jev",
): Promise<string | null> {
  return await readFile(providerCredentialFile(dataDir, provider), "utf8")
    .then((key) => key.trim() || null)
    .catch(() => null);
}
async function savedConfiguration(dataDir: string): Promise<ClassifierConfig> {
  try {
    return classifierConfigSchema.parse(
      JSON.parse(await readFile(configurationFile(dataDir), "utf8")),
    );
  } catch {
    return defaultClassifierConfig("jev");
  }
}
async function readClassifierKey(
  dataDir: string,
  provider: ClassifierProvider,
  reference: string,
) {
  const saved = await savedKey(dataDir, provider);
  if (saved) return saved;
  switch (provider) {
    case "native":
      return null;
    case "jev":
      return readJevKey(reference);
    case "openai":
      return process.env.OPENAI_API_KEY?.trim() || null;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY?.trim() || null;
  }
}
const usageReaders = new Map<string, () => Promise<ProviderUsage[]>>();
/** The classifier with each account's subscription usage as an input. */
function askWithUsage(
  dataDir: string,
  state: string,
  questions: Parameters<JevAsk>[1],
) {
  const directory = dirname(credentialFile(dataDir));
  let readUsage = usageReaders.get(directory);
  if (readUsage === undefined) {
    readUsage = makeUsageReader(directory, {
      readCodex: () => readCodexLimits(classifierEnvironment()),
    });
    usageReaders.set(directory, readUsage);
  }
  return withUsage(
    (state, questions) => askWithStoredKey(dataDir, state, questions),
    readUsage,
  )(state, questions);
}
async function askWithStoredKey(
  dataDir: string,
  state: string,
  questions: Parameters<JevAsk>[1],
) {
  const configuration = await savedConfiguration(dataDir);
  if (configuration.provider === "native") {
    const runtime = await readFile(
      `${configurationFile(dataDir)}.runtime`,
      "utf8",
    )
      .then((text) =>
        z
          .object({
            bbRoot: z.string(),
            nativeProviderOptions: z.record(z.string(), z.unknown()).optional(),
          })
          .parse(JSON.parse(text)),
      )
      .catch(() => ({ bbRoot: DEFAULT_BB_ROOT, nativeProviderOptions: {} }));
    return makeNativeClassifierAsk(configuration, {
      dataDir: dirname(credentialFile(dataDir)),
      bbRoot: runtime.bbRoot,
      providerOptions: runtime.nativeProviderOptions,
    })(state, questions);
  }
  const key = await savedKey(dataDir, configuration.provider);
  const file = credentialFile(dataDir);
  const reference = await readFile(`${file}.op-reference`, "utf8").catch(
    () => "",
  );
  const signature = JSON.stringify([
    configuration,
    key,
    reference,
    process.env.JEV_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ]);
  let cached = asks.get(file);
  if (!cached || cached.signature !== signature) {
    cached = {
      signature,
      ask: makeClassifierAsk(configuration, {
        readKey: () =>
          readClassifierKey(dataDir, configuration.provider, reference),
        warn: () => {},
      }),
    };
    asks.set(file, cached);
  }
  return cached.ask(state, questions);
}
async function writePrivateFile(file: string, value: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
const planFile = (dataDir: string, threadId: string) =>
  join(
    dataDir,
    "plans",
    `${z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(threadId)}.json`,
  );
const bridgeDirectory = (hostDir: string) =>
  basename(hostDir) === "host-data"
    ? join(dirname(hostDir), "bridge-data")
    : hostDir;
export async function readRetainedSessions(dataDir: string) {
  const names = (
    await readdir(join(dataDir, "sessions")).catch(() => [])
  ).filter((name) => /^[0-9a-f-]+\.json$/.test(name));
  const sessions = [];
  let remainingRecords = 5000;
  let limited = names.length > 500;
  const savedFiles = [];
  for (const name of names) {
    try {
      savedFiles.push(
        savedSessionSchema.parse(
          JSON.parse(await readFile(join(dataDir, "sessions", name), "utf8")),
        ),
      );
    } catch {}
  }
  savedFiles.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const saved of savedFiles.slice(0, 500)) {
    try {
      const lines = await readFile(
        join(dataDir, "sessions", `${saved.autoId}.ndjson`),
        "utf8",
      )
        .then((text) => text.trim().split("\n"))
        .catch(() => []);
      const retained = Math.min(100, remainingRecords);
      if (lines.length > retained) limited = true;
      const history = (retained > 0 ? lines.slice(-retained) : []).flatMap(
        (line) => {
          try {
            const parsed = lineSchema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
          } catch {
            return [];
          }
        },
      );
      remainingRecords -= history.length;
      sessions.push({
        autoId: saved.autoId,
        threadId: saved.threadId,
        helper: saved.helper,
        updatedAt: saved.updatedAt,
        route: saved.route === null ? null : { model: saved.route.model },
        history,
        truncated: lines.length > retained,
      });
    } catch {}
  }
  return { sessions, limited };
}
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async configureClassifier(
      {
        configuration,
        key,
        onePasswordReference,
        bbRoot,
        nativeProviderOptions,
      },
      context,
    ) {
      const dataDir = context.experimental_paths.dataDir;
      if (configuration.provider === "native") {
        await writePrivateFile(
          configurationFile(dataDir),
          JSON.stringify(configuration),
        );
        await writePrivateFile(
          `${configurationFile(dataDir)}.runtime`,
          JSON.stringify({
            bbRoot: bbRoot ?? DEFAULT_BB_ROOT,
            nativeProviderOptions,
          }),
        );
        asks.delete(credentialFile(dataDir));
        return { configured: Boolean(configuration.model) };
      }
      const file = providerCredentialFile(dataDir, configuration.provider);
      if (key?.trim()) await writePrivateFile(file, key.trim());
      else
        await unlink(file).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw new Error("Could not remove the saved classification key.");
        });
      const referenceFile = `${credentialFile(dataDir)}.op-reference`;
      if (onePasswordReference)
        await writePrivateFile(referenceFile, onePasswordReference);
      else await unlink(referenceFile).catch(() => {});
      await writePrivateFile(
        configurationFile(dataDir),
        JSON.stringify(configuration),
      );
      asks.delete(credentialFile(dataDir));
      return {
        configured: Boolean(
          await readClassifierKey(
            dataDir,
            configuration.provider,
            onePasswordReference,
          ),
        ),
      };
    },
    async testClassifier(
      { candidate, onePasswordReference, bbRoot, nativeProviderOptions },
      context,
    ) {
      const { key, ...configuration } = candidate;
      const ask =
        configuration.provider === "native"
          ? makeNativeClassifierAsk(configuration, {
              dataDir: dirname(
                credentialFile(context.experimental_paths.dataDir),
              ),
              bbRoot: bbRoot ?? DEFAULT_BB_ROOT,
              providerOptions: nativeProviderOptions,
            })
          : makeClassifierAsk(configuration, {
              readKey: async () =>
                key ??
                readClassifierKey(
                  context.experimental_paths.dataDir,
                  configuration.provider,
                  onePasswordReference,
                ),
              warn: () => {},
            });
      const reply = await ask("Connection test.", CONNECTION_QUESTIONS);
      const ok =
        reply.jev.isAnswered &&
        reply.answers?.connection?.choice === "connected";
      return {
        ok,
        message: ok
          ? "Connection works. Classification uses the selected provider account and its usage limits."
          : "The classification service did not return a valid answer. Check the API key, API billing, model access, and network connection. Your saved configuration did not change.",
      };
    },
    async configureJevKey({ key, onePasswordReference }, context) {
      const file = credentialFile(context.experimental_paths.dataDir);
      if (key?.trim()) {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, key.trim(), { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, file);
      } else
        await unlink(file).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw new Error("Could not remove the saved Jev key.");
        });
      if (onePasswordReference) {
        await writeFile(`${file}.op-reference`, onePasswordReference, {
          mode: 0o600,
        });
        await chmod(`${file}.op-reference`, 0o600);
      } else await unlink(`${file}.op-reference`).catch(() => {});
      asks.delete(file);
      return { configured: Boolean(key?.trim()) };
    },
    async keyStatus(_, context) {
      const dataDir = context.experimental_paths.dataDir;
      const configuration = await savedConfiguration(dataDir);
      if (configuration.provider === "native")
        return { configured: Boolean(configuration.model) };
      const reference = await readFile(
        `${credentialFile(dataDir)}.op-reference`,
        "utf8",
      ).catch(() => "");
      const envKey =
        configuration.provider === "jev"
          ? process.env.JEV_API_KEY
          : configuration.provider === "openai"
            ? process.env.OPENAI_API_KEY
            : process.env.ANTHROPIC_API_KEY;
      return {
        configured: Boolean(
          (await savedKey(dataDir, configuration.provider)) ||
            envKey ||
            (configuration.provider === "jev" && reference),
        ),
      };
    },
    async validateKey(_, context) {
      const reply = await askWithStoredKey(
        context.experimental_paths.dataDir,
        "Connection test.",
        CONNECTION_QUESTIONS,
      );
      const ok =
        reply.jev.isAnswered &&
        reply.answers?.connection?.choice === "connected";
      return {
        ok,
        message: ok
          ? "Connection works. Classification uses the selected provider account and its usage limits."
          : "The classification service did not return a valid answer. Check the API key, API billing, model access, and network connection.",
      };
    },
    async evaluate({ state, questions }, context) {
      return askWithUsage(
        context.experimental_paths.dataDir,
        state,
        questions,
      );
    },
    async listSessions(_, context) {
      return readRetainedSessions(
        bridgeDirectory(context.experimental_paths.dataDir),
      );
    },
    async notePlan({ threadId, plan }, context) {
      await writePrivateFile(
        planFile(bridgeDirectory(context.experimental_paths.dataDir), threadId),
        JSON.stringify(plan),
      );
      return {};
    },
    async getSession({ threadId }, context) {
      const bridgeDir = bridgeDirectory(context.experimental_paths.dataDir);
      const saved = await readAutoSession(bridgeDir, threadId);
      const lines =
        saved === null
          ? []
          : await readFile(
              join(bridgeDir, "sessions", `${saved.autoId}.ndjson`),
              "utf8",
            )
              .then((text) => text.trim().split("\n").slice(-100))
              .catch(() => []);
      const history = lines.flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      return {
        route: saved?.route ?? null,
        delegation: saved?.delegation ?? null,
        revision: saved?.revision ?? null,
        history,
      };
    },
  },
});
