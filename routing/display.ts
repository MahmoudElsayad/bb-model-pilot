/**
 * How routing decisions read in a BB thread: one row per routed message, a plan row that names
 * who does each step, and a helper row that names the helper's model. Pure: no I/O here.
 *
 * @module routing/display
 */
import type { DeltaPresentation } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { isGptModel, nameOf, type Delegation, type Plan, type PlanStep, type Route } from "./core.js";
import { routeSchema } from "./router.js";

/** The extension item kind of a route row: `<pluginId>/<name>`. */
export const ROUTE_ROW_KIND = "auto-router/route" as const;

export const routeRowSchema = z.object({
  turn: z.enum(["first", "later"]),
  main: routeSchema,
  mode: z.enum(["direct", "helper", "plan"]),
  helper: routeSchema.nullable(),
  /** The models subscription usage left out, and why. */
  limits: z.string().nullable().default(null),
});
export type RouteRow = z.infer<typeof routeRowSchema>;

/** BB rejects a presentation detail longer than this. */
const DETAIL_MAX = 280;
const WINDOW_NAMES = { "200k": "200k", "1m": "1M" } as const;
/** The Warm Charcoal theme's orange `--primary`, darkened in light mode for contrast. */
export const ACCENT = { light: "#c8641f", dark: "#ec8743" };

export function routeRow(
  route: Route,
  delegation: Delegation | null,
  turn: RouteRow["turn"],
  limits: string | null = null,
): RouteRow {
  if (delegation?.plan === true) return { turn, main: route, mode: "plan", helper: null, limits };
  if (delegation?.delegate === true && delegation.helper !== null)
    return { turn, main: route, mode: "helper", helper: delegation.helper, limits };
  return { turn, main: route, mode: "direct", helper: null, limits };
}

/** "high effort · 1M context": Codex has no window setting, so its routes show none. */
function setup(route: Route): string {
  const effort = `${route.effort} effort`;
  return isGptModel(route.model) ? effort : `${effort} · ${WINDOW_NAMES[route.window]} context`;
}

/** "Opus 5.5 with high effort and a 1M context window". */
function setupSentence(route: Route): string {
  const window = isGptModel(route.model) ? "" : ` and a ${WINDOW_NAMES[route.window]} context window`;
  return `${nameOf(route.model)} with ${route.effort} effort${window}`;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function routeRowPresentation(row: RouteRow): DeltaPresentation {
  const name = nameOf(row.main.model);
  const mode =
    row.mode === "plan"
      ? "plan"
      : row.mode === "helper" && row.helper !== null
        ? `helper ${nameOf(row.helper.model)} ${row.helper.effort}`
        : null;
  const opening =
    row.turn === "first"
      ? `Model Pilot chose ${setupSentence(row.main)} for this conversation.`
      : `This message stays on ${setupSentence(row.main)}.`;
  const work =
    row.mode === "plan"
      ? "The main agent writes a plan, and Model Pilot assigns each step to the main agent or a helper."
      : row.mode === "helper" && row.helper !== null
        ? `A helper on ${setupSentence(row.helper)} does this message, and the main agent uses its report.${
            row.helper.priced === undefined
              ? ""
              : ` The classifier picked ${nameOf(row.helper.priced.from)}, but the main model costs no more.`
          }`
        : "The main agent does this message itself.";
  const confidence =
    row.main.source === "jev" && row.main.confidence > 0
      ? ` Classifier confidence: ${Math.round(row.main.confidence * 100)}%.`
      : "";
  return {
    label: {
      pending: "Routing message",
      completed: row.turn === "first" ? `Routed to ${name}` : `Continued on ${name}`,
    },
    icon: { glyph: "Workflow" },
    tint: ACCENT,
    title: [setup(row.main), mode].filter((part) => part !== null).join(" · "),
    detail: clamp(`${opening} ${work}${row.limits === null ? "" : ` ${row.limits}`}${confidence}`, DETAIL_MAX),
    ...(row.main.source === "fallback"
      ? {
          badge: {
            glyph: "AlertTriangle",
            label: "Fallback route",
            hint: "Classification was unavailable, so Model Pilot used its default route.",
            tone: "neutral" as const,
          },
        }
      : row.limits !== null
        ? {
            badge: {
              glyph: "Gauge",
              label: "Usage limit",
              hint: clamp(row.limits, DETAIL_MAX),
              tone: "neutral" as const,
            },
          }
        : {}),
  };
}

function assignee(step: PlanStep): string {
  if (step.owner === "main" || step.helper === null) return "main agent";
  return `${nameOf(step.helper.model)} ${step.helper.effort}${step.background ? ", background" : ""}`;
}

/** "3 steps · 2 helpers on Haiku 4.5, Sonnet 5.5", or "· all on the main agent". */
function planTitle(plan: Plan): string {
  const steps = `${plan.length} ${plan.length === 1 ? "step" : "steps"}`;
  const helpers = plan.filter((step) => step.owner === "helper" && step.helper !== null);
  if (helpers.length === 0) return `${steps} · all on the main agent`;
  const models = [...new Set(helpers.map((step) => nameOf(step.helper!.model)))];
  return `${steps} · ${helpers.length} ${helpers.length === 1 ? "helper" : "helpers"} on ${models.join(", ")}`;
}

/** One Markdown line per step, cut with "…and N more" to fit BB's detail limit. */
function planDetail(plan: Plan): string {
  const lines: string[] = [];
  for (const [i, step] of plan.entries()) {
    const line = `${step.index}. ${clamp(step.title, 60)} → ${assignee(step)}`;
    const more = plan.length - i - 1;
    const tail = more > 0 ? `\n…and ${more} more` : "";
    if ([...lines, line].join("\n").length + tail.length > DETAIL_MAX) {
      lines.push(`…and ${plan.length - i} more`);
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Before the plan is routed, or when its routing is unknown, the row has no title or detail. */
export function planRowPresentation(plan: Plan | undefined): DeltaPresentation {
  const base = {
    label: { pending: "Routing plan steps", completed: "Routed plan" },
    icon: { glyph: "ListTodo" },
    tint: ACCENT,
  };
  if (plan === undefined || plan.length === 0) return base;
  return { ...base, title: planTitle(plan), detail: planDetail(plan) };
}

/** A helper hand-off: the helper's model and effort, and the plan step it does. */
export function helperRowPresentation(helper: Route, step: PlanStep | undefined): DeltaPresentation {
  const background = step?.background === true;
  return {
    label: background
      ? { pending: "Starting background helper", completed: "Started background helper" }
      : { pending: "Running helper", completed: "Helper finished" },
    icon: { glyph: "Bot" },
    tint: ACCENT,
    title: [nameOf(helper.model), setup(helper), step === undefined ? null : `step ${step.index}`]
      .filter((part) => part !== null)
      .join(" · "),
    ...(step === undefined ? {} : { detail: clamp(`Step ${step.index}: ${step.title}`, DETAIL_MAX) }),
  };
}
