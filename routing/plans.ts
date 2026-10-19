import { helperModelsFor, planFrom, planQuestions, planState, type Plan, type PlanStepInput, type Route } from "./core.js";
import type { JevAsk } from "./jev.js";

export function makePlanStore() {
  const plans = new Map<string, Plan>();
  const handBacks = new Map<string, Set<string>>();
  return {
    get: (threadId: string) => plans.get(threadId),
    set: (threadId: string, plan: Plan) => { plans.set(threadId, plan); },
    update: (threadId: string, change: (plan: Plan) => Plan): Plan | undefined => {
      const plan = plans.get(threadId);
      if (plan === undefined) return undefined;
      const next = change(plan);
      plans.set(threadId, next);
      return next;
    },
    clear: (threadId: string) => { plans.delete(threadId); },
    markHandBack: (threadId: string, messageId: string) => {
      const ids = handBacks.get(threadId) ?? new Set<string>();
      ids.add(messageId);
      handBacks.set(threadId, ids);
    },
    isHandBack: (threadId: string, messageId: string) => handBacks.get(threadId)?.has(messageId) === true,
    forgetHandBack: (threadId: string, messageId: string) => {
      const ids = handBacks.get(threadId);
      ids?.delete(messageId);
      if (ids?.size === 0) handBacks.delete(threadId);
    },
  };
}
export type PlanStore = ReturnType<typeof makePlanStore>;
export function makePlanRouter(ask: JevAsk) {
  return async (steps: readonly PlanStepInput[], main: Route, permissionMode?: string) => {
    const helperModels = helperModelsFor(permissionMode);
    const reply = await ask(planState(steps, main), planQuestions(steps, helperModels));
    return { plan: planFrom(steps, reply.answers, main, helperModels), jev: reply.jev };
  };
}
