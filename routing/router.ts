import { buildState, delegationFrom, delegationQuestions, EFFORTS, HELPER_MODELS, mainAgentFact, routeFrom, routingNote, WINDOWS, type Choice, type Delegation, type Question, type Route } from "./core.js";
import type { ModelId } from "./models.js";
import type { JevAsk, JevCall } from "./jev.js";
import { z } from "zod";

export const routeSchema = z.object({
  model: z.string(), effort: z.enum(["low", "medium", "high", "xhigh"]),
  window: z.enum(["200k", "1m"]), confidence: z.number(),
  source: z.enum(["jev", "fallback"]), vote: z.record(z.string(), z.number()).optional(),
  priced: z.object({ from: z.string() }).optional(),
});
export const planSchema = z.array(z.object({
  index: z.number().int().positive(), title: z.string(), after: z.array(z.number().int().positive()),
  owner: z.enum(["main", "helper"]), helper: routeSchema.nullable(), background: z.boolean(),
  status: z.enum(["pending", "started", "done"]),
}));
export const routingSettingsSchema = z.object({ toolsOnPickedThreads: z.boolean().default(false) });
export type RoutingSettings = z.infer<typeof routingSettingsSchema>;

export const THREAD_MODELS = {
  "gpt-6-luna": HELPER_MODELS["gpt-6-luna"],
  "gpt-6.1-sol": HELPER_MODELS["gpt-6.1-sol"],
  "claude-sonnet-5-5": HELPER_MODELS["claude-sonnet-5-5"],
  "claude-opus-5-5": HELPER_MODELS["claude-opus-5-5"],
  "gpt-6-astra": HELPER_MODELS["gpt-6-astra"],
  "claude-fable-5-1": HELPER_MODELS["claude-fable-5-1"],
} as const satisfies Partial<Record<ModelId, string>>;

/** When Jev gives no usable answer, the thread goes to Claude. */
export const FALLBACK_THREAD: Route = {
  model: "claude-opus-5-5",
  effort: "medium",
  window: "200k",
  confidence: 0,
  source: "fallback",
};

export function threadQuestions(): Record<string, Question> {
  return {
    model: {
      type: "choice",
      instructions:
        "Which model should a coding agent use for this whole conversation? The options run from cheapest to most expensive. Pick the least capable model that will do the task well.",
      criteria: THREAD_MODELS,
    },
    effort: {
      type: "choice",
      instructions: "How much reasoning does the coding agent need for this task?",
      criteria: EFFORTS,
    },
    window: {
      type: "choice",
      instructions: "How much context will the coding agent need for this conversation?",
      criteria: WINDOWS,
    },
  };
}

export const routeThread = (answers: Record<string, Choice> | null): Route =>
  routeFrom(answers, FALLBACK_THREAD, THREAD_MODELS);


export type RouteRequest =
  | { threadId: string; prompt: string; turn: "first" }
  | { threadId: string; prompt: string; turn: "later"; currentModel: string };
export type RouteReply = {
  route: Route | null;
  decision: "first" | "unmanaged" | "changed" | "routed";
  delegation: Delegation | null;
  note: string | null;
  /** The models subscription usage left out of this decision, and why. */
  limits: string | null;
};
export type RouteRecord = {
  type: "route"; scope: "main" | "helper"; isFirstPrompt: boolean; description: "Auto provider";
  route: Route; jev: JevCall; delegation: Delegation;
};
export type ThreadRouterDeps = {
  ask: JevAsk;
  record: (threadId: string, entry: RouteRecord) => Promise<void>;
  lastRoute: (threadId: string) => Promise<Route | undefined>;
};
export function makeThreadRouter(deps: ThreadRouterDeps) {
  return async (request: RouteRequest): Promise<RouteReply> => {
    if (request.turn === "first") {
      const reply = await deps.ask(buildState(request.prompt, { "Conversation turn": "first prompt" }), {
        ...threadQuestions(), ...delegationQuestions(),
      });
      const route = routeThread(reply.answers);
      const delegation = delegationFrom(reply.answers, route);
      await deps.record(request.threadId, { type: "route", scope: "main", isFirstPrompt: true,
        description: "Auto provider", route, jev: reply.jev, delegation });
      return { route, decision: "first", delegation, note: routingNote(delegation), limits: reply.jev.limits ?? null };
    }
    const last = await deps.lastRoute(request.threadId);
    if (last === undefined || last.model !== request.currentModel) {
      return { route: null, decision: last === undefined ? "unmanaged" : "changed", delegation: null, note: null, limits: null };
    }
    const reply = await deps.ask(buildState(request.prompt, {
      "Conversation turn": "a later message", "main agent": mainAgentFact(last),
    }), delegationQuestions());
    const delegation = delegationFrom(reply.answers, last);
    await deps.record(request.threadId, { type: "route", scope: "main", isFirstPrompt: false,
      description: "Auto provider", route: last, jev: reply.jev, delegation });
    return { route: last, decision: "routed", delegation, note: routingNote(delegation), limits: reply.jev.limits ?? null };
  };
}
