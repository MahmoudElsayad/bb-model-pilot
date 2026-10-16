/**
 * The auto-router's pure routing logic: the model tables Jev chooses from, the questions it is
 * asked, and how its answers become a route, a delegation decision or a plan. No I/O here.
 *
 * @module routing/core
 */
import { modelInfo, outputPricePerMillion, type ModelId } from "./models.js";

type Effort = "low" | "medium" | "high" | "xhigh";
type Window = "200k" | "1m";

/** One routing decision: the model a request names, how hard it thinks, and how much context it may use. */
export type Route = {
  model: string;
  effort: Effort;
  window: Window;
  /**
   * 0 to 1: for a model pick, the chance that the model is enough for the task; otherwise the
   * vote share of the deciding pick.
   */
  confidence: number;
  source: "jev" | "fallback";
  /** Jev's model vote as shares of the whole, when it picked the model. */
  vote?: Record<string, number>;
  /** A helper moved from Jev's pick to the thread's own model, which was no dearer and no weaker. */
  priced?: { readonly from: string };
};

/** Jev's delegation answer: whether to hand off, and the helper's route when it said yes. */
export type Delegation = {
  delegate: boolean;
  /** The vote share behind the decision; 0 when Jev gave no usable answer. */
  share: number;
  helper: Route | null;
  /** True when Jev called the message multi-step: the model plans first and each step is routed. */
  plan?: boolean;
};

/** A step as the model lists it in the plan tool. */
export type PlanStepInput = {
  readonly title: string;
  readonly after?: readonly number[] | undefined;
};

/** One step of the main model's plan for a multi-step message, as Jev assigned it. */
export type PlanStep = {
  /** 1-based, as the model listed it. */
  index: number;
  title: string;
  /** The steps this one needs finished first. */
  after: number[];
  owner: "main" | "helper";
  helper: Route | null;
  /** A helper step the main model need not wait for: a later step of its own does not depend on it. */
  background: boolean;
  status: "pending" | "started" | "done";
};

/** The steps of a thread's current message, in the order the model listed them. */
export type Plan = readonly PlanStep[];

export type Choice = { choice: string; confidence: number; probabilities?: Record<string, number> };
export type Question = { type: "choice"; instructions: string; criteria: Record<string, string> };
type Pick = { choice: string; probability: number };

/** Used only when Jev returns no vote probabilities: below this confidence its choice is ignored. */
const MIN_CONFIDENCE = 0.69;

/**
 * A model is enough for a task when the vote for it and every less capable model reaches this
 * share. On twelve sample tasks, close calls that needed more than the cheapest model gave it
 * 58% or less, and tasks it suited gave it 69% to 71%; Jev's votes moved about 2 points between
 * runs. 0.65 sits between the two groups, so that noise does not flip either kind of task.
 * Effort and context use the same share: on the same tasks it raised one open review question
 * from medium to high effort, where the vote gave high 39%, and changed no context window.
 */
const ENOUGH_SHARE = 0.65;

/** Prompt text sent to Jev is cut to this many characters. */
const MAX_STATE_CHARS = 12_000;

/** Main-thread models. Edit the descriptions to change what Jev routes where. */
export const MAIN_MODELS = {
  "claude-sonnet-5-5":
    "Routine work: questions, explanations, small or mechanical edits, a clear bug with a known cause, running commands, writing docs.",
  "claude-opus-5-5":
    "Substantial engineering: a feature across several files, a refactor, debugging with an unclear cause, a code review, a plan for a non-trivial change.",
  "claude-fable-5-1":
    "The hardest work: system architecture and design trade-offs, subtle concurrency, security or data-loss problems, novel algorithms, a long autonomous task with many steps.",
} as const satisfies Partial<Record<ModelId, string>>;

/**
 * Every model a helper can run on, Claude and GPT, cheapest output price first: Jev's pick is the
 * weighted median of this order. GPT descriptions are the Codex CLI's own (`model/list`).
 */
export const HELPER_MODELS = {
  "gpt-6-luna": "Fast and affordable model for easier tasks.",
  "claude-haiku-4-5-20251001":
    "A lookup or sweep with no judgment: find files, grep for a symbol, list or summarize what exists, read and report.",
  "gpt-6.1-sol": "Latest workhorse model for coding and everyday work.",
  "claude-sonnet-5-5": MAIN_MODELS["claude-sonnet-5-5"],
  "claude-opus-5-5": MAIN_MODELS["claude-opus-5-5"],
  "gpt-6-astra": "Frontier intelligence for the most demanding work.",
  "claude-fable-5-1": MAIN_MODELS["claude-fable-5-1"],
} as const satisfies Record<ModelId, string>;

export const isGptModel = (model: string): boolean => model.startsWith("gpt-");

/** The shape of a message's work. Unordered: the pick is the largest share. */
export const SHAPES = {
  main: "The main agent does all of it itself: a question, an explanation, a small change, or work that needs the conversation so far or back-and-forth with the person.",
  helper:
    "One helper does the whole message: a single self-contained piece of work that would pull many files, logs or search results into the main context. Work too small to repay a helper's fresh context stays with the main agent.",
  plan: "Multi-step work: a feature, a refactor, a bug hunt or an investigation with several distinct parts, where a helper could take some parts while the main agent does others.",
} as const;

/** Who does one step of a plan. Ordered main, helper: the median is the majority. */
const STEP_OWNERS = {
  main: "The main agent, which already holds the conversation, does this step itself: it is small, it judges or combines other steps' results, it writes the answer, or it edits files other steps also change.",
  helper:
    "A fresh helper does it: self-contained work with real tool use, such as searching or reading many files, running tests, or a contained change, that a one-paragraph brief can describe and that would otherwise fill the main context. A helper costs a new context, so a step too small to repay that stays with the main agent.",
} as const;

export const EFFORTS: Record<Effort, string> = {
  low: "The answer is direct: a fact, a one-line change, a command to run, a short reply.",
  medium: "Some thought: a contained change or an explanation that needs a few steps of reasoning.",
  high: "Careful reasoning: several interacting parts, edge cases to weigh, or a design choice to make.",
  xhigh:
    "The hardest reasoning: a subtle bug, a proof-like argument, or a decision that is expensive to get wrong.",
};

export const WINDOWS: Record<Window, string> = {
  "200k": "The work stays in a few files or one area and the conversation stays short.",
  "1m": "The work needs a large part of a codebase, many long files, big logs, or a long session.",
};

export const nameOf = (model: string): string => modelInfo(model)?.name ?? model;

const WINDOW_NAMES: Record<Window, string> = { "200k": "200k", "1m": "1M" };

/** What Jev reads: the task and the facts about the thread that change the answer. */
export function buildState(task: string, facts: Record<string, string | number>): string {
  const lines = Object.entries(facts).map(([key, value]) => `${key}: ${value}`);
  const text =
    task.length > MAX_STATE_CHARS
      ? `${task.slice(0, MAX_STATE_CHARS)}\n[cut at ${MAX_STATE_CHARS} characters]`
      : task;
  return `${lines.join("\n")}\n\nTask:\n${text}`;
}

/** The shape of a message's work, and the helper's model, effort and context if one takes part of it. */
export function delegationQuestions(): Record<string, Question> {
  return {
    shape: {
      type: "choice",
      instructions: "What shape is the work in this message?",
      criteria: SHAPES,
    },
    helperModel: {
      type: "choice",
      instructions:
        "If part of it is handed to a helper, which model should the helper use? The options run from cheapest to most expensive. Pick the least capable model that will do that part well.",
      criteria: HELPER_MODELS,
    },
    helperEffort: {
      type: "choice",
      instructions: "If part of it is handed to a helper, how much reasoning does the helper need?",
      criteria: EFFORTS,
    },
    helperContext: {
      type: "choice",
      instructions: "If part of it is handed to a helper, how much context will the helper need?",
      criteria: WINDOWS,
    },
  };
}

/**
 * Jev's pick on an ordered scale (cheapest model or least effort first). With the vote's
 * probabilities it is the weighted median: the first option where the vote reaches half, so a
 * split vote lands in the middle instead of being thrown away. With no probabilities, Jev's own
 * choice counts only above MIN_CONFIDENCE.
 */
export function pick(answer: Choice | undefined, options: object): Pick | undefined {
  if (answer === undefined) return undefined;
  const order = Object.keys(options);
  const votes = order.map((option) => answer.probabilities?.[option] ?? 0);
  const total = votes.reduce((sum, vote) => sum + vote, 0);

  if (total > 0) {
    let reached = 0;
    for (const [i, option] of order.entries()) {
      reached += votes[i]!;
      if (reached >= total / 2) return { choice: option, probability: votes[i]! / total };
    }
  }

  return answer.confidence >= MIN_CONFIDENCE && order.includes(answer.choice)
    ? { choice: answer.choice, probability: answer.confidence }
    : undefined;
}

/**
 * Jev's effort or context pick: the least option that is enough for the task, on a scale
 * ordered least first. A vote for an option means the task needs at least that much, so the
 * share up to an option is the chance that it is enough. With no probabilities, Jev's own
 * choice counts only above MIN_CONFIDENCE.
 */
export function pickEnough(answer: Choice | undefined, options: object): Pick | undefined {
  if (answer === undefined) return undefined;
  const order = Object.keys(options);
  const votes = order.map((option) => answer.probabilities?.[option] ?? 0);
  const total = votes.reduce((sum, vote) => sum + vote, 0);
  if (total === 0) return pick(answer, options);
  let reached = 0;
  for (const [i, option] of order.entries()) {
    reached += votes[i]!;
    if (reached / total >= ENOUGH_SHARE - 1e-9) return { choice: option, probability: reached / total };
  }
  return { choice: order.at(-1)!, probability: 1 };
}

/**
 * Jev's model pick: the cheapest model that is enough for the task. Each vote names the least
 * capable model that does the task well, so the share at or below a model's tier is the chance
 * that the model is enough. Among models that reach ENOUGH_SHARE, the cheapest wins, then the
 * more capable, then the one with the larger vote. This avoids both a model too weak for the
 * task and a stronger one it does not need. With no probabilities, Jev's own choice counts
 * only above MIN_CONFIDENCE.
 */
export function pickModel(answer: Choice | undefined, options: object): Pick | undefined {
  if (answer === undefined) return undefined;
  // A model the vote leaves out was not offered, as on a blocked account, so it cannot be picked.
  const offered = Object.keys(options).filter(
    (model) => answer.probabilities === undefined || Object.hasOwn(answer.probabilities, model),
  );
  const models = offered.flatMap((model) => {
    const info = modelInfo(model);
    return info === undefined ? [] : [{ model, info, vote: answer.probabilities?.[model] ?? 0 }];
  });
  const total = models.reduce((sum, { vote }) => sum + vote, 0);
  if (total === 0) return pick(answer, options);
  const enough = models
    .map((candidate) => ({
      ...candidate,
      share:
        models
          .filter((other) => other.info.tier <= candidate.info.tier)
          .reduce((sum, { vote }) => sum + vote, 0) / total,
    }))
    .filter(({ share }) => share >= ENOUGH_SHARE - 1e-9)
    .sort(
      (a, b) =>
        outputPricePerMillion(a.info) - outputPricePerMillion(b.info) ||
        b.info.tier - a.info.tier ||
        b.vote - a.vote,
    );
  const best = enough[0]!;
  return { choice: best.model, probability: best.share };
}

/** Jev's pick among unordered options: the largest share of the vote, or its own choice above the floor. */
export function pickMost(answer: Choice | undefined, options: object): Pick | undefined {
  if (answer === undefined) return undefined;
  const order = Object.keys(options);
  const votes = order.map((option) => answer.probabilities?.[option] ?? 0);
  const total = votes.reduce((sum, vote) => sum + vote, 0);
  if (total > 0) {
    const top = votes.indexOf(Math.max(...votes));
    return { choice: order[top]!, probability: votes[top]! / total };
  }
  return answer.confidence >= MIN_CONFIDENCE && order.includes(answer.choice)
    ? { choice: answer.choice, probability: answer.confidence }
    : undefined;
}

/** The model vote as shares of the whole. */
function voteOf(answer: Choice | undefined, options: object): Record<string, number> | undefined {
  const entries = Object.keys(options).map(
    (option) => [option, answer?.probabilities?.[option] ?? 0] as const,
  );
  const total = entries.reduce((sum, [, vote]) => sum + vote, 0);
  return total > 0
    ? Object.fromEntries(entries.map(([option, vote]) => [option, vote / total]))
    : undefined;
}

/** A model with no 1M window always gets 200k, whatever Jev answered. */
const windowOn = (model: string, window: Window): Window =>
  modelInfo(model)?.maxWindow === "200k" ? "200k" : window;

/**
 * Turns Jev's answers into a route. A field Jev gave no usable answer for keeps the `base` value.
 * `confidence` is the vote share of the deciding pick: the model's when Jev picked one, else the effort's.
 */
export function routeFrom(
  answers: Record<string, Choice> | null,
  base: Route,
  models: object,
): Route {
  if (answers === null) return base;

  const model = pickModel(answers.model, models);
  const effort = pickEnough(answers.effort, EFFORTS);
  const window = pickEnough(answers.window, WINDOWS);
  const deciding = model ?? effort ?? window;
  if (deciding === undefined) return base;

  const vote = model === undefined ? undefined : voteOf(answers.model, models);
  const chosenModel = model?.choice ?? base.model;
  return {
    model: chosenModel,
    effort: (effort?.choice as Effort | undefined) ?? base.effort,
    window: windowOn(chosenModel, (window?.choice as Window | undefined) ?? base.window),
    confidence: deciding.probability,
    source: "jev",
    ...(vote === undefined ? {} : { vote }),
  };
}

/** No usable answer means no delegation: the main thread just does the work. */
const NO_DELEGATION: Delegation = { delegate: false, share: 0, helper: null };

const HELPER_BASE: Route = {
  model: "claude-haiku-4-5-20251001",
  effort: "low",
  window: "200k",
  confidence: 0,
  source: "fallback",
};

/** A helper's route from the named answers; Haiku, low effort, 200k where Jev gave none. */
function helperOf(
  answers: Record<string, Choice>,
  model: string,
  effort: string,
  window: string,
): Route {
  return routeFrom(
    {
      ...(answers[model] ? { model: answers[model] } : {}),
      ...(answers[effort] ? { effort: answers[effort] } : {}),
      ...(answers[window] ? { window: answers[window] } : {}),
    },
    HELPER_BASE,
    HELPER_MODELS,
  );
}

/**
 * Jev's helper pick, or the main agent's own model when that is no dearer and no weaker: a helper
 * on a pricier model than the thread's costs more than the work it takes off the thread. A tie in
 * price and tier goes to the main model too, as Sonnet over Sol, both $10 and tier 2. The effort
 * and window stay Jev's. Same provider as the thread, so the delegate tool can run it.
 */
export function pricedHelper(pick: Route, main: Route): Route {
  const own = modelInfo(main.model);
  const picked = modelInfo(pick.model);
  if (pick.model === main.model || own === undefined || picked === undefined) return pick;
  const isNoDearer = outputPricePerMillion(own) <= outputPricePerMillion(picked);
  if (!isNoDearer || own.tier < picked.tier) return pick;
  return { ...pick, model: main.model, priced: { from: pick.model } };
}

const TIER_WORDS = {
  1: "the cheapest tier",
  2: "the second of four tiers",
  3: "the third of four tiers",
  4: "the most capable tier",
} as const;

/** What Jev reads about the main agent, so it weighs a helper's fresh context against the thread's own price. */
export function mainAgentFact(main: Route): string {
  const info = modelInfo(main.model);
  const setup = `${nameOf(main.model)}, ${main.effort} effort`;
  if (info === undefined) return setup;
  return (
    `${setup}, output price $${outputPricePerMillion(info).toFixed(2)} per million tokens, ${TIER_WORDS[info.tier]}; ` +
    "a helper starts a fresh context, so it saves money only when it keeps bulk out of this conversation"
  );
}

export function delegationFrom(answers: Record<string, Choice> | null, main: Route): Delegation {
  const shape = pickMost(answers?.shape, SHAPES);
  if (answers === null || shape === undefined) return NO_DELEGATION;
  if (shape.choice === "plan") {
    return { delegate: false, share: shape.probability, helper: null, plan: true };
  }
  if (shape.choice === "main") return { delegate: false, share: shape.probability, helper: null };
  return {
    delegate: true,
    share: shape.probability,
    helper: pricedHelper(helperOf(answers, "helperModel", "helperEffort", "helperContext"), main),
  };
}

/** What Jev reads for a plan: the thread's model, and the steps. Each question names its step. */
export function planState(steps: readonly PlanStepInput[], main: Route): string {
  const list = steps
    .map(
      (step, i) =>
        `${i + 1}. ${step.title}${step.after?.length ? ` (after ${step.after.join(", ")})` : ""}`,
    )
    .join("\n");
  return buildState(`Plan:\n${list}`, { "main agent": mainAgentFact(main) });
}

/** One Jev call for the whole plan: for each step, who does it, and the helper's model, effort and context. */
export function planQuestions(steps: readonly PlanStepInput[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  steps.forEach((step, i) => {
    const n = i + 1;
    questions[`owner_${n}`] = {
      type: "choice",
      instructions: `Step ${n}, "${step.title}": who does it?`,
      criteria: STEP_OWNERS,
    };
    questions[`model_${n}`] = {
      type: "choice",
      instructions: `If step ${n} goes to a helper, which model? The options run from cheapest to most expensive. Pick the least capable model that will do it well.`,
      criteria: HELPER_MODELS,
    };
    questions[`effort_${n}`] = {
      type: "choice",
      instructions: `If step ${n} goes to a helper, how much reasoning does it need?`,
      criteria: EFFORTS,
    };
    questions[`context_${n}`] = {
      type: "choice",
      instructions: `If step ${n} goes to a helper, how much context will it need?`,
      criteria: WINDOWS,
    };
  });
  return questions;
}

/** Whether `step` needs `target` finished first, directly or through other steps. */
function dependsOn(
  steps: readonly { index: number; after: number[] }[],
  step: { after: number[] },
  target: number,
): boolean {
  const seen = new Set<number>();
  const queue = [...step.after];
  while (queue.length > 0) {
    const index = queue.shift()!;
    if (index === target) return true;
    if (seen.has(index)) continue;
    seen.add(index);
    queue.push(...(steps.find((other) => other.index === index)?.after ?? []));
  }
  return false;
}

/**
 * Jev's answers as a plan. With no usable answer for a step, the main model does it. A helper
 * step runs in the background when a later step of the main model's own does not depend on it,
 * so the main model has work to do meanwhile, or when another helper step is independent of it,
 * so the two helpers run at once.
 */
export function planFrom(
  steps: readonly PlanStepInput[],
  answers: Record<string, Choice> | null,
  main: Route,
): PlanStep[] {
  const owned = steps.map((step, i): PlanStep => {
    const n = i + 1;
    const owner =
      pick(answers?.[`owner_${n}`], STEP_OWNERS)?.choice === "helper" ? "helper" : "main";
    return {
      index: n,
      title: step.title,
      after: (step.after ?? []).filter(
        (index) => Number.isInteger(index) && index >= 1 && index <= steps.length && index !== n,
      ),
      owner,
      helper:
        owner === "helper" && answers !== null
          ? pricedHelper(helperOf(answers, `model_${n}`, `effort_${n}`, `context_${n}`), main)
          : null,
      background: false,
      status: "pending",
    };
  });
  return owned.map((step) =>
    step.owner === "main"
      ? step
      : {
          ...step,
          background: owned.some(
            (other) =>
              (other.owner === "main"
                ? other.index > step.index
                : other.index !== step.index && !dependsOn(owned, step, other.index)) &&
              !dependsOn(owned, other, step.index),
          ),
        },
  );
}

/** How the model hands one helper step off. */
function handOffText(step: PlanStep): string {
  const helper = step.helper!;
  const setup = `${nameOf(helper.model)}, ${helper.effort} effort, ${WINDOW_NAMES[helper.window]} context`;
  const where = step.background ? ", in the background" : "";
  return `helper on ${setup}${where}: the delegate tool with step ${step.index}`;
}

/** The plan tool's answer: who does each step, and how to hand helper steps off. */
export function planText(steps: readonly PlanStep[]): string {
  const lines = steps.map((step) => {
    const status = step.status === "pending" ? "" : ` (${step.status})`;
    return `Step ${step.index} "${step.title}" → ${step.owner === "main" ? "you" : handOffText(step)}${status}.`;
  });
  const background = steps.some((step) => step.background)
    ? " For a step in the background, the delegate tool returns at once and the helper's report arrives later in this thread as a message, so go on with your own steps meanwhile. Start every background helper step before you wait on any helper's report."
    : "";
  return (
    `${lines.join("\n")}\n\n` +
    `Hand each helper step off before you start a step that needs it.${background} ` +
    "Give each helper a complete brief, because it sees nothing of this conversation. Call step_done with each step of your own as you finish it."
  );
}

/** "Plan routed: 1 main · 2 Haiku 4.5 low, background · 3 main": a routed plan as the thread shows it. */
export function planLine(steps: Plan, isJevAnswered: boolean): string {
  const parts = steps.map((step) =>
    step.owner === "main" || step.helper === null
      ? `${step.index} main`
      : `${step.index} ${nameOf(step.helper.model)} ${step.helper.effort}${step.background ? ", background" : ""}`,
  );
  const line = `Plan routed: ${parts.join(" · ")}`;
  return isJevAnswered
    ? line
    : `${line}: Jev did not answer, so every step stays with the main model`;
}

/**
 * The plan step a delegate call carries out: the one `step` names, else the one the task names
 * with a leading "Step N:". Only a pending helper step counts; anything else is not a plan step.
 */
export function stepForHandOff(
  steps: Plan,
  step: number | undefined,
  task: string,
): PlanStep | undefined {
  const index = step ?? Number(/^\s*step\s+(\d+)\s*:/i.exec(task)?.[1]);
  const found = steps.find((candidate) => candidate.index === index);
  return found?.owner === "helper" && found.helper !== null && found.status === "pending"
    ? found
    : undefined;
}

/** The plan after a step is handed off: that step started, and every main step before it done. */
export const withStepStarted = (steps: Plan, index: number): Plan =>
  steps.map((step) => {
    if (step.index === index) return { ...step, status: "started" };
    if (step.index < index && step.owner === "main" && step.status === "pending") {
      return { ...step, status: "done" };
    }
    return step;
  });

export const withStepsDone = (steps: Plan, done: readonly number[]): Plan =>
  steps.map((step) => (done.includes(step.index) ? { ...step, status: "done" } : step));

/** Whether every step is done or handed off. */
export const isPlanFinished = (steps: Plan): boolean =>
  steps.every((step) => step.status !== "pending");

/**
 * What the main model reads after the person's prompt when Jev says to delegate. It goes in at the
 * end of the conversation, so the cached part never changes. No note when Jev says no.
 */
export function routingNote(delegation: Delegation): string | null {
  if (delegation.plan === true) {
    return (
      "Routing instruction from the auto-router (the person does not see it): this message is multi-step work. " +
      "Before anything else, write your plan with the plan tool: one line per step, in order, each with the steps it needs finished first. " +
      "Its answer says who does each step. Then follow it: hand helper steps off with the delegate tool as it says, do your own steps, and call step_done as you finish each."
    );
  }
  if (!delegation.delegate || delegation.helper === null) return null;
  const helper = delegation.helper;
  const setup = `${nameOf(helper.model)}, ${helper.effort} effort, ${WINDOW_NAMES[helper.window]} context`;
  return (
    `Routing instruction from the auto-router (the person does not see it): this message is assigned to a helper on ${setup}. ` +
    `Before anything else, hand the work to it with the delegate tool, passing model "${helper.model}" and effort "${helper.effort}", with a brief that has every path and fact the helper needs. ` +
    "Do this even if the work looks small. Then use the helper's report to answer."
  );
}

/**
 * "auto → Opus 5.5 · high · 1M · helper Haiku 4.5 low 200k", or "... · plan" for multi-step work:
 * one routing decision as the thread shows it. Codex has no window setting, so its route shows none.
 */
export function routedSummary(route: Route, delegation: Delegation | null): string {
  const window = isGptModel(route.model) ? "" : ` · ${WINDOW_NAMES[route.window]}`;
  const main = `auto → ${nameOf(route.model)} · ${route.effort}${window}`;
  if (delegation?.plan === true) return `${main} · plan`;
  const helper = delegation?.delegate === true ? delegation.helper : null;
  if (helper === null) return main;
  const priced = helper.priced === undefined ? "" : " (priced)";
  return `${main} · helper ${nameOf(helper.model)} ${helper.effort} ${WINDOW_NAMES[helper.window]}${priced}`;
}
