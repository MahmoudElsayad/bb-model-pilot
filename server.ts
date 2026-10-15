import {
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type JsonValue,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildDashboard,
  dashboardInputSchema,
  dashboardSchema,
  setupSchema,
} from "./dashboard.js";
import { hostContract } from "./contract.js";
import { type JevAsk } from "./routing/jev.js";
import {
  classifierProviderSchema,
  classifierConfigSchema,
  classifierSetupInputSchema,
  defaultClassifierConfig,
  type ClassifierConfig,
  nativeModelSchema,
  nativeProviderSchema,
  type NativeModel,
} from "./routing/classifier.js";
import { makeThreadRouter, planSchema, routeSchema } from "./routing/router.js";
import { makePlanRouter } from "./routing/plans.js";
import { ACCENT, routeRowSchema } from "./routing/display.js";
import { summarizeRouting } from "./report.js";
import {
  planText,
  stepForHandOff,
  withStepStarted,
  withStepsDone,
  type Plan,
  type Route,
} from "./routing/core.js";

const stepsSchema = z
  .array(
    z.object({
      title: z.string().trim().min(1).max(1000),
      after: z.array(z.number().int().positive()).optional(),
    }),
  )
  .min(1)
  .max(32)
  .superRefine((steps, ctx) => {
    const visiting = new Set<number>();
    const visited = new Set<number>();
    const visit = (index: number): boolean => {
      if (visiting.has(index)) return false;
      if (visited.has(index)) return true;
      visiting.add(index);
      for (const dependency of steps[index - 1]?.after ?? []) {
        if (dependency > steps.length || !visit(dependency)) return false;
      }
      visiting.delete(index);
      visited.add(index);
      return true;
    };
    if (steps.some((_, index) => !visit(index + 1))) {
      ctx.addIssue({
        code: "custom",
        message:
          "Plan dependencies must refer to existing steps and contain no cycles.",
      });
    }
  });
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const rpcContract = defineRpcContract({
  dashboard: { input: dashboardInputSchema, output: dashboardSchema },
  setupStatus: {
    input: z.object({ hostId: z.string().optional() }).strict(),
    output: setupSchema,
  },
  localModels: {
    input: z.object({ hostId: z.string().optional() }).strict(),
    output: z.object({
      models: z.array(nativeModelSchema),
      warnings: z.array(z.string()),
    }),
  },
  saveNativeClassifier: {
    input: z
      .object({
        providerId: nativeProviderSchema,
        modelId: z.string().min(1),
        hostId: z.string().optional(),
      })
      .strict(),
    output: setupSchema,
  },
  saveClassifier: {
    input: z
      .object({
        provider: classifierProviderSchema,
        model: z.string(),
        key: z.string().trim().min(1).max(8192).optional(),
        hostId: z.string().optional(),
      })
      .strict()
      .superRefine((value, context) => {
        const { hostId: _, ...candidate } = value;
        if (!classifierSetupInputSchema.safeParse(candidate).success)
          context.addIssue({
            code: "custom",
            message: "Select a supported classification provider and model.",
          });
      }),
    output: setupSchema,
  },
  saveJevKey: {
    input: z
      .object({
        key: z.string().trim().max(8192),
        hostId: z.string().optional(),
      })
      .strict(),
    output: setupSchema,
  },
  validateKey: {
    input: z.object({ hostId: z.string().optional() }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
});
export default async function plugin(
  bb: BbPluginApi,
  dependencies: { ask?: JevAsk } = {},
) {
  const settings = bb.settings.define({
    classifierProvider: {
      type: "string",
      label: "Classification provider",
      default: "jev",
    },
    classifierModel: {
      type: "string",
      label: "Classification model",
      default: "",
    },
    nativeClassifierProvider: {
      type: "string",
      label: "BB classification provider",
      default: "codex",
    },
    nativeClassifierEffort: {
      type: "string",
      label: "BB classification effort",
      default: "",
    },
    openaiApiKey: { type: "string", label: "OpenAI API key", secret: true },
    anthropicApiKey: {
      type: "string",
      label: "Anthropic API key",
      secret: true,
    },
    jevApiKey: { type: "string", label: "Jev API key", secret: true },
    onePasswordReference: {
      type: "string",
      label: "Optional 1Password reference",
      default: "",
    },
    toolsOnPickedThreads: {
      type: "boolean",
      label: "Auto tools on manually selected models",
      default: false,
    },
    bbRoot: {
      type: "string",
      label: "BB application root",
      default:
        "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app",
    },
  });
  let currentSettings = await settings.get();
  settings.onChange((next) => {
    currentSettings = next;
  });
  const native: Record<string, Record<string, JsonValue>> = {
    codex: {},
    "claude-code": {},
  };
  async function refreshNativeSettings() {
    const results = await Promise.allSettled([
      bb.sdk.plugins.getSettings({ pluginId: "provider-codex" }),
      bb.sdk.plugins.getSettings({ pluginId: "provider-claude-code" }),
    ]);
    const codex = results[0];
    if (codex.status === "fulfilled") {
      const s = codex.value.values;
      native.codex = {
        memoryEnabled: s.memoryEnabled !== false,
        providerSubagentsEnabled: s.subagentsDisabled !== true,
      };
    }
    const claude = results[1];
    if (claude.status === "fulfilled") {
      const s = claude.value.values;
      native["claude-code"] = {
        memoryEnabled: s.memoryEnabled !== false,
        providerSubagentsEnabled: s.subagentsDisabled !== true,
        workflowsEnabled: s.workflowsDisabled !== true,
        chromeEnabled: s.chromeEnabled === true,
        disable1MContext: s.disable1MContext === true,
        sandboxEnabled: s.sandboxEnabled !== false,
      };
    }
  }
  await refreshNativeSettings();
  const refreshTimer = setInterval(() => {
    void refreshNativeSettings().catch((error) => bb.log.warn(message(error)));
  }, 30_000);
  const lifetime = new AbortController();
  const jobs = new Set<Promise<unknown>>();
  bb.onDispose(async () => {
    clearInterval(refreshTimer);
    lifetime.abort();
    await Promise.allSettled([...jobs]);
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  function askOnHost(hostId: string, signal?: AbortSignal): JevAsk {
    return (
      dependencies.ask ??
      (async (state, questions) => {
        await provisionKey(hostId);
        return host.call(
          "evaluate",
          { state, questions },
          { hostId, signal, timeoutMs: 90_000 },
        );
      })
    );
  }
  async function cliHostId(threadId?: string): Promise<string> {
    if (threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        return environment.hostId;
      }
    }
    const primaryHostId = (await bb.sdk.system.config()).primaryHostId;
    if (!primaryHostId)
      throw new Error(
        "No primary machine is connected. Run this command from a thread with an environment.",
      );
    return primaryHostId;
  }
  function selectedConfiguration(
    values: typeof currentSettings,
  ): ClassifierConfig {
    const provider = classifierProviderSchema.parse(
      values.classifierProvider === "native" &&
        !values.classifierModel &&
        (values.jevApiKey || values.onePasswordReference)
        ? "jev"
        : values.classifierProvider,
    );
    if (provider === "native")
      return classifierConfigSchema.parse({
        provider,
        model: values.classifierModel,
        nativeProvider: values.nativeClassifierProvider,
        ...(values.nativeClassifierEffort
          ? { effort: values.nativeClassifierEffort }
          : {}),
      });
    return classifierConfigSchema.parse({
      provider,
      model: values.classifierModel || defaultClassifierConfig(provider).model,
    });
  }
  function settingKey(
    values: typeof currentSettings,
    provider: ClassifierConfig["provider"],
  ): string | null {
    switch (provider) {
      case "native":
        return null;
      case "jev":
        return values.jevApiKey ?? null;
      case "openai":
        return values.openaiApiKey ?? null;
      case "anthropic":
        return values.anthropicApiKey ?? null;
    }
  }
  const provisioned = new Map<string, string>();
  async function provisionKey(hostId: string) {
    const next = await settings.get();
    const configuration = selectedConfiguration(next);
    const key = settingKey(next, configuration.provider);
    const signature = JSON.stringify([
      configuration,
      key,
      next.onePasswordReference,
    ]);
    if (provisioned.get(hostId) === signature) return;
    await host.call(
      "configureClassifier",
      {
        configuration,
        key,
        onePasswordReference: next.onePasswordReference,
        bbRoot: next.bbRoot,
        ...(configuration.provider === "native"
          ? { nativeProviderOptions: native[configuration.nativeProvider] }
          : {}),
      },
      { hostId },
    );
    provisioned.set(hostId, signature);
  }
  host.experimental_onWorkerExit(({ hostId }) => {
    provisioned.delete(hostId);
  });
  async function localModels(hostId: string) {
    const providers = await bb.sdk.providers.list({ hostId });
    const models: NativeModel[] = [];
    const warnings: string[] = [];
    const supported = providers.filter(
      (provider) => provider.id === "codex" || provider.id === "claude-code",
    );
    for (const provider of providers) {
      if (
        provider.id !== "auto" &&
        provider.available &&
        !supported.includes(provider)
      )
        warnings.push(
          `${provider.displayName} is available in BB, but this version supports classification through Codex and Claude Code only.`,
        );
    }
    for (const provider of supported) {
      if (!provider.available) {
        warnings.push(
          `${provider.displayName} is not connected. Sign in through BB to use its models.`,
        );
        continue;
      }
      try {
        const catalog = await bb.sdk.providers.models({
          hostId,
          providerId: provider.id,
        });
        for (const model of catalog.models) {
          if (model.routeProviderId && model.routeProviderId !== provider.id)
            continue;
          const efforts = model.supportedReasoningEfforts.map(
            (item) => item.reasoningEffort,
          );
          models.push(
            nativeModelSchema.parse({
              providerId: provider.id,
              modelId: model.model,
              label: model.displayName,
              providerLabel: provider.displayName,
              description: model.description,
              reasoningEffort: efforts.includes("low")
                ? "low"
                : efforts.includes("none")
                  ? "none"
                  : model.defaultReasoningEffort,
            }),
          );
        }
      } catch {
        warnings.push(
          `BB could not load models for ${provider.displayName}. Refresh after checking its connection.`,
        );
      }
    }
    return { models, warnings };
  }
  async function setupStatus(hostId: string) {
    await provisionKey(hostId);
    const status = await host.call("keyStatus", {}, { hostId });
    const configuration = selectedConfiguration(currentSettings);
    return {
      ...configuration,
      configured: status.configured,
      source: settingKey(currentSettings, configuration.provider)
        ? ("setting" as const)
        : status.configured
          ? ("host" as const)
          : ("missing" as const),
      canValidate: status.configured,
    };
  }
  bb.rpc.register(rpcContract, {
    async dashboard(input) {
      const hostId = input.hostId ?? (await cliHostId());
      const [retained, setup, rows] = await Promise.all([
        host.call("listSessions", {}, { hostId }),
        setupStatus(hostId),
        bb.storage.kv.list("plan-history:"),
      ]);
      const plans = [];
      for (const key of rows) {
        const row = await bb.storage.kv.get(key);
        const parsed = z
          .object({
            threadId: z.string(),
            hostId: z.string(),
            history: z.array(z.unknown()),
          })
          .safeParse(row);
        if (parsed.success && parsed.data.hostId === hostId)
          plans.push(parsed.data);
      }
      const latest = await bb.storage.kv.list("plan-routing:");
      for (const key of latest) {
        const row = await bb.storage.kv.get(key);
        const threadId = key.slice("plan-routing:".length);
        if (plans.some((p) => p.threadId === threadId)) continue;
        const parsed = z
          .object({ at: z.number(), jev: z.unknown() })
          .safeParse(row);
        if (!parsed.success) continue;
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          if (!thread.environmentId) continue;
          const env = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
          });
          if (env.hostId === hostId)
            plans.push({
              threadId,
              hostId,
              history: [
                {
                  at: parsed.data.at,
                  entry: { type: "plan", jev: parsed.data.jev },
                },
              ],
            });
        } catch {}
      }
      const titles = new Map<string, string>();
      await Promise.all(
        [...new Set(retained.sessions.map((s) => s.threadId))].map(
          async (threadId) => {
            try {
              const t = await bb.sdk.threads.get({ threadId });
              titles.set(threadId, t.title ?? threadId);
              if (
                t.originPluginId === bb.pluginId &&
                t.visibility === "hidden"
              ) {
                for (const saved of retained.sessions)
                  if (saved.threadId === threadId) saved.helper = true;
              }
            } catch {}
          },
        ),
      );
      return buildDashboard({
        input,
        hostId,
        sessions: retained.sessions,
        plans,
        setup,
        titles,
        warnings: retained.limited
          ? [
              "The host report is capped at 500 sessions and 5,000 records. Some older records are missing.",
            ]
          : [],
      });
    },
    async localModels(input) {
      return localModels(input.hostId ?? (await cliHostId()));
    },
    async saveNativeClassifier(input) {
      const hostId = input.hostId ?? (await cliHostId());
      const catalog = await localModels(hostId);
      const model = catalog.models.find(
        (item) =>
          item.providerId === input.providerId &&
          item.modelId === input.modelId,
      );
      if (!model)
        throw new Error("Select a model available through BB on this machine.");
      const candidate = classifierConfigSchema.parse({
        provider: "native",
        nativeProvider: model.providerId,
        model: model.modelId,
        effort: model.reasoningEffort,
      });
      const tested = await host.call(
        "testClassifier",
        {
          candidate,
          onePasswordReference: "",
          bbRoot: currentSettings.bbRoot,
          nativeProviderOptions: native[model.providerId],
        },
        { hostId, timeoutMs: 90000 },
      );
      if (!tested.ok) throw new Error(tested.message);
      await settings.experimental_set({
        classifierProvider: "native",
        classifierModel: model.modelId,
        nativeClassifierProvider: model.providerId,
        nativeClassifierEffort: model.reasoningEffort,
      });
      currentSettings = await settings.get();
      provisioned.delete(hostId);
      return setupStatus(hostId);
    },
    async setupStatus(input) {
      return setupStatus(input.hostId ?? (await cliHostId()));
    },
    async saveClassifier(input) {
      const { hostId: requestedHostId, ...raw } = input;
      const candidate = classifierSetupInputSchema.parse(raw);
      if (candidate.provider === "native")
        throw new Error("Use the BB model connection form.");
      const hostId = requestedHostId ?? (await cliHostId());
      const next = await settings.get();
      const existingKey = settingKey(next, candidate.provider);
      const tested = await host.call(
        "testClassifier",
        {
          candidate: {
            ...candidate,
            ...(candidate.key || !existingKey ? {} : { key: existingKey }),
          },
          onePasswordReference: next.onePasswordReference,
        },
        { hostId, timeoutMs: 90_000 },
      );
      if (!tested.ok) throw new Error(tested.message);
      const keySetting =
        candidate.key === undefined
          ? {}
          : candidate.provider === "jev"
            ? { jevApiKey: candidate.key }
            : candidate.provider === "openai"
              ? { openaiApiKey: candidate.key }
              : { anthropicApiKey: candidate.key };
      await settings.experimental_set({
        classifierProvider: candidate.provider,
        classifierModel: candidate.model,
        ...keySetting,
      });
      currentSettings = await settings.get();
      provisioned.delete(hostId);
      return setupStatus(hostId);
    },
    async saveJevKey(input) {
      await settings.experimental_set({ jevApiKey: input.key || null });
      currentSettings = await settings.get();
      const hostId = input.hostId ?? (await cliHostId());
      provisioned.delete(hostId);
      return setupStatus(hostId);
    },
    async validateKey(input) {
      const hostId = input.hostId ?? (await cliHostId());
      await provisionKey(hostId);
      return host.call("validateKey", {}, { hostId, timeoutMs: 90000 });
    },
  });
  bb.providers.register({
    id: "auto",
    displayName: "Model Pilot",
    icon: "Sparkles",
    family: "auto",
    strings: {
      signInHint:
        "Choose a connected BB model in Model Pilot. Sign in to Codex or Claude Code through BB.",
      expiredHint: "Sign in to the selected native provider again.",
      installUrl: "https://getbb.app",
      planModeCopy:
        "Auto selects a model and asks it to plan without making changes.",
    },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh"],
    },
    maintenance: { health: true, usage: false, installation: false },
    composerActions: ["plan"],
    completedTurnDisplay: "flat",
    extensionKinds: { route: { item: routeRowSchema } },
    models: {
      scope: "host",
      fallback: [
        {
          id: "auto",
          displayName: "Model Pilot",
          description: "Model Pilot selects the coding model for the task.",
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
            { reasoningEffort: "xhigh", description: "Extra high" },
          ],
          defaultReasoningEffort: "medium",
        },
      ],
    },
    env: {
      passthrough: [
        "BB_CODEX_EXECUTABLE",
        "BB_CLAUDE_CODE_EXECUTABLE",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "JEV_API_KEY",
      ],
    },
    deriveProviderOptions(ctx) {
      return {
        bbRoot: currentSettings.bbRoot,
        nativeProviderOptions: native,
        promptMode: ctx.promptMode ?? null,
      };
    },
  });
  bb.providers.experimental_contributeEnv("auto", async ({ hostId }) => {
    await provisionKey(hostId);
    return [];
  });
  bb.agents.configure((context) => ({
    tools:
      context.pluginMetadata.autoHelper !== true &&
      !context.provider.model.startsWith("auto-helper:") &&
      (context.provider.id === "auto" || currentSettings.toolsOnPickedThreads)
        ? ["auto_plan", "auto_step_done", "auto_delegate"]
        : [],
    skills: [],
    instructions:
      context.provider.id === "auto" &&
      context.pluginMetadata.autoHelper !== true &&
      !context.provider.model.startsWith("auto-helper:")
        ? "Auto routing tools are auto_plan, auto_step_done, and auto_delegate. When routing instructions say plan, step_done, or delegate, use these tools. Helpers receive only your brief. Include all facts and paths they need. Respect plan dependencies and do not edit the same files concurrently."
        : undefined,
  }));
  const revisions = new Map<string, string>();
  const planKey = (id: string, revision = revisions.get(id) ?? "") =>
    `plan:${id}:${revision}`;
  const readPlan = async (
    id: string,
    revision = revisions.get(id) ?? "",
  ): Promise<Plan> => {
    const parsed = planSchema.safeParse(
      await bb.storage.kv.get(planKey(id, revision)),
    );
    return parsed.success ? parsed.data : [];
  };
  const locks = new Map<string, Promise<void>>();
  async function updatePlan(
    id: string,
    change: (plan: Plan) => Plan,
    revision = revisions.get(id) ?? "",
  ): Promise<Plan> {
    const previous = locks.get(id) ?? Promise.resolve();
    let next: Plan = [];
    const operation = previous
      .catch(() => {})
      .then(async () => {
        next = change(await readPlan(id, revision));
        await bb.storage.kv.set(planKey(id, revision), next);
      });
    locks.set(id, operation);
    try {
      await operation;
      return next;
    } finally {
      if (locks.get(id) === operation) locks.delete(id);
    }
  }
  async function session(threadId: string, signal?: AbortSignal) {
    const thread = await bb.sdk.threads.get({ threadId, signal });
    if (thread.providerId !== "auto" && !currentSettings.toolsOnPickedThreads)
      throw new Error("Auto tools are disabled for this thread.");
    if (thread.environmentId === null)
      throw new Error("The thread has no environment.");
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    const state =
      thread.providerId === "auto"
        ? await host.call(
            "getSession",
            { threadId },
            { hostId: environment.hostId, signal },
          )
        : { route: null, delegation: null, revision: null, history: [] };
    const revision = state.revision ?? "";
    revisions.set(threadId, revision);
    const execution = await bb.sdk.threads.defaultExecutionOptions({
      threadId,
    });
    const route =
      state.route ??
      (execution
        ? routeSchema.parse({
            model: execution.model,
            effort: ["low", "medium", "high", "xhigh"].includes(
              execution.reasoningLevel,
            )
              ? execution.reasoningLevel
              : "high",
            window: "200k",
            confidence: 0,
            source: "fallback",
          })
        : null);
    if (route === null) throw new Error("Auto has not routed this thread yet.");
    return {
      thread,
      environment,
      route,
      delegation: state.delegation,
      revision,
      history: state.history,
      execution,
    };
  }
  bb.agents.registerTool({
    name: "auto_plan",
    description:
      "List the steps for this task. The classification model assigns each step to the main agent or a helper.",
    presentation: {
      label: { pending: "Routing plan steps", completed: "Routed plan" },
      icon: { glyph: "ListTodo" },
      tint: ACCENT,
    },
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              after: { type: "array", items: { type: "integer" } },
            },
            required: ["title"],
          },
        },
      },
      required: ["steps"],
    },
    async execute(raw, ctx) {
      const { steps } = z.object({ steps: stepsSchema }).parse(raw);
      const { route, environment, thread } = await session(
        ctx.threadId,
        ctx.signal,
      );
      const routePlan = makePlanRouter(
        askOnHost(environment.hostId, ctx.signal),
      );
      const { plan, jev } = await routePlan(steps, route);
      await bb.storage.kv.set(planKey(ctx.threadId), plan);
      if (thread.providerId === "auto")
        await host
          .call(
            "notePlan",
            { threadId: ctx.threadId, plan },
            { hostId: environment.hostId, signal: ctx.signal },
          )
          .catch((error) =>
            bb.log.warn(
              `Auto plan display failed in ${ctx.threadId}: ${message(error)}`,
            ),
          );
      const at = Date.now();
      await bb.storage.kv.set(`plan-routing:${ctx.threadId}`, {
        jev,
        plan,
        at,
      });
      const previous = z
        .object({ history: z.array(z.unknown()) })
        .safeParse(await bb.storage.kv.get(`plan-history:${ctx.threadId}`));
      await bb.storage.kv.set(`plan-history:${ctx.threadId}`, {
        threadId: ctx.threadId,
        hostId: environment.hostId,
        history: [
          ...(previous.success ? previous.data.history : []),
          { at, entry: { type: "plan", jev } },
        ].slice(-100),
      });
      return planText(plan)
        .replaceAll("step_done", "auto_step_done")
        .replaceAll("delegate tool", "auto_delegate tool");
    },
  });
  bb.agents.registerTool({
    name: "auto_step_done",
    description:
      "Mark your own completed plan steps. Helpers mark their steps when they finish.",
    presentation: {
      label: { pending: "Updating plan", completed: "Plan updated" },
      suppress: true,
    },
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          minItems: 1,
          maxItems: 32,
        },
      },
      required: ["steps"],
    },
    async execute(raw, ctx) {
      const { steps } = z
        .object({ steps: z.array(z.number().int().positive()).min(1).max(32) })
        .parse(raw);
      await session(ctx.threadId, ctx.signal);
      const plan = await updatePlan(ctx.threadId, (plan) => {
        if (
          steps.some(
            (index) =>
              !plan.some(
                (step) => step.index === index && step.owner === "main",
              ),
          )
        ) {
          throw new Error(
            "Only existing main-agent steps can be completed with this tool.",
          );
        }
        return withStepsDone(plan, steps);
      });
      return planText(plan);
    },
  });
  bb.agents.registerTool({
    name: "auto_delegate",
    description:
      "Give a complete task brief to the selected helper, optionally for an assigned plan step.",
    presentation: {
      label: { pending: "Running helper", completed: "Helper finished" },
      icon: { glyph: "Bot" },
      tint: ACCENT,
    },
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1, maxLength: 32000 },
        model: { type: "string" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        step: { type: "integer", minimum: 1 },
      },
      required: ["task"],
    },
    async execute(raw, ctx) {
      const {
        task,
        model,
        effort,
        step: stepIndex,
      } = z
        .object({
          task: z.string().trim().min(1).max(32000),
          model: z.string().optional(),
          effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
          step: z.number().int().positive().optional(),
        })
        .parse(raw);
      const parent = await session(ctx.threadId, ctx.signal);
      let planned = stepForHandOff(
        await readPlan(ctx.threadId),
        stepIndex,
        task,
      );
      if (stepIndex !== undefined && planned === undefined)
        throw new Error("The requested step is not a pending helper step.");
      const selected = planned?.helper ?? parent.delegation?.helper;
      if (!selected)
        throw new Error(
          "The classification model did not assign this task to a helper. Call auto_plan to assign its steps first.",
        );
      if (
        (model && model !== selected.model) ||
        (effort && effort !== selected.effort)
      ) {
        throw new Error(
          `The classification model selected ${selected.model} with ${selected.effort} effort. Use that route.`,
        );
      }
      if (planned) {
        const index = planned.index;
        await updatePlan(ctx.threadId, (plan) => {
          const current = stepForHandOff(plan, index, task);
          if (
            !current ||
            current.after.some(
              (dependency) =>
                plan.find((step) => step.index === dependency)?.status !==
                "done",
            )
          ) {
            throw new Error(
              "This helper step is already started or its dependencies are unfinished.",
            );
          }
          planned = current;
          return withStepStarted(plan, index);
        });
      }
      let childId: string | undefined;
      const background = planned?.background === true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      lifetime.signal.addEventListener("abort", abort, { once: true });
      ctx.signal.addEventListener("abort", abort, { once: true });
      if (lifetime.signal.aborted || ctx.signal.aborted) controller.abort();
      async function work() {
        try {
          controller.signal.throwIfAborted();
          const child = await bb.sdk.threads.spawn({
            projectId: parent.thread.projectId,
            environment: {
              type: "reuse",
              environmentId: parent.environment.id,
            },
            providerId: "auto",
            model: `auto-helper:${selected!.model}:${selected!.effort}:${selected!.window}`,
            reasoningLevel: selected!.effort,
            permissionMode: parent.execution?.permissionMode ?? "accept-edits",
            visibility: "hidden",
            ...(background ? { parentThreadId: ctx.threadId } : {}),
            lifecycleOwnerThreadId: ctx.threadId,
            title: `Auto helper: ${task.slice(0, 80)}`,
            prompt: task,
            pluginMetadata: {
              autoHelper: true,
              route: selected!,
              step: planned?.index ?? null,
            },
          });
          childId = child.id;
          controller.signal.throwIfAborted();
          await bb.sdk.threads.wait({
            threadId: child.id,
            status: "idle",
            timeoutMs: 3_600_000,
            signal: controller.signal,
          });
          const report = await bb.sdk.threads.output({ threadId: child.id });
          if (planned)
            await updatePlan(
              ctx.threadId,
              (plan) => withStepsDone(plan, [planned!.index]),
              parent.revision,
            );
          return `Helper ${child.id} (${selected!.model}, ${selected!.effort}):\n${report.output?.slice(0, 48_000) ?? "No assistant output."}`;
        } catch (error) {
          if (planned)
            await updatePlan(
              ctx.threadId,
              (plan) =>
                plan.map((step) =>
                  step.index === planned!.index && step.status === "started"
                    ? { ...step, status: "pending" }
                    : step,
                ),
              parent.revision,
            );
          throw error;
        } finally {
          lifetime.signal.removeEventListener("abort", abort);
          ctx.signal.removeEventListener("abort", abort);
          if (childId) {
            try {
              await bb.sdk.threads.archive({ threadId: childId });
            } finally {
              await bb.sdk.threads.stop({ threadId: childId });
            }
          }
        }
      }
      const result = work();
      jobs.add(result);
      void result.finally(() => jobs.delete(result)).catch(() => {});
      if (!background) return await result;
      void result.catch((error) =>
        bb.log.warn(`Auto helper failed in ${ctx.threadId}: ${message(error)}`),
      );
      return `Started background helper for step ${planned!.index} on ${selected.model}, ${selected.effort} effort. Continue your independent steps. BB delivers its final report to this thread.`;
    },
  });
  bb.cli.register(
    defineCli({
      name: "auto",
      summary: "Inspect and try Model Pilot.",
      commands: {
        route: cliCommand({
          summary:
            "Ask the classification model to assign a task without running a coding agent.",
          positionals: [
            {
              name: "task",
              description: "Task text, quoted as one argument.",
              required: true,
            },
          ],
          async run(input, ctx) {
            const routePreview = makeThreadRouter({
              ask: askOnHost(await cliHostId(ctx.threadId), ctx.signal),
              record: async (threadId, record) => {
                await bb.storage.kv.set(`preview:${threadId}`, record);
              },
              lastRoute: async () => undefined,
            });
            const result = await routePreview({
              threadId: ctx.threadId ?? "cli",
              prompt: input.positionals.task!,
              turn: "first",
            });
            const classifier = selectedConfiguration(currentSettings);
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                {
                  ...result,
                  classifier,
                  route: result.route
                    ? {
                        ...result.route,
                        source:
                          result.route.source === "fallback"
                            ? "fallback"
                            : classifier.provider,
                        ...(classifier.provider === "jev"
                          ? {}
                          : { confidence: undefined, vote: undefined }),
                      }
                    : null,
                },
                null,
                2,
              ),
            };
          },
        }),
        status: cliCommand({
          summary:
            "Show Auto configuration and the current thread route and plan.",
          options: {
            thread: {
              type: "string",
              description: "BB thread whose route and usage to show.",
            },
          },
          async run(input, ctx) {
            const threadId = input.options.thread ?? ctx.threadId;
            const state = threadId
              ? await session(threadId, ctx.signal).catch((error) => {
                  if (input.options.thread) throw error;
                  return null;
                })
              : null;
            const planRouting = threadId
              ? await bb.storage.kv.get(`plan-routing:${threadId}`)
              : null;
            const planRecord = z
              .object({ at: z.number(), jev: z.unknown() })
              .safeParse(planRouting);
            const history = [
              ...(state?.history ?? []),
              ...(planRecord.success
                ? [
                    {
                      at: planRecord.data.at,
                      entry: { type: "plan", jev: planRecord.data.jev },
                    },
                  ]
                : []),
            ];
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                {
                  provider: "auto",
                  settings: {
                    toolsOnPickedThreads: currentSettings.toolsOnPickedThreads,
                    bbRoot: currentSettings.bbRoot,
                    jevKeyConfigured: Boolean(currentSettings.jevApiKey),
                  },
                  nativeProviderOptions: native,
                  route: state?.route ?? null,
                  delegation: state?.delegation ?? null,
                  history: state?.history ?? [],
                  usage: summarizeRouting(history),
                  plan: threadId ? await readPlan(threadId) : [],
                },
                null,
                2,
              ),
            };
          },
        }),
      },
    }),
  );
}
