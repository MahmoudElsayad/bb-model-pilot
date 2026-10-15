import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { retainedSessionSchema } from "./dashboard.js";
import { planSchema, routeSchema } from "./routing/router.js";
import {
  classifierConfigSchema,
  classifierSetupInputSchema,
  classifierResultSchema,
} from "./routing/classifier.js";

export const delegationSchema = z.object({
  delegate: z.boolean(),
  share: z.number(),
  helper: routeSchema.nullable(),
  plan: z.boolean().optional(),
});
export const hostContract = defineRpcContract({
  listSessions: {
    input: z.object({}).strict(),
    output: z.object({
      sessions: z.array(retainedSessionSchema).max(500),
      limited: z.boolean(),
    }),
  },
  configureClassifier: {
    input: z
      .object({
        configuration: classifierConfigSchema,
        bbRoot: z.string().optional(),
        nativeProviderOptions: z.record(z.string(), z.unknown()).optional(),
        key: z.string().max(8192).nullable(),
        onePasswordReference: z.string().max(2048).default(""),
      })
      .strict(),
    output: z.object({ configured: z.boolean() }),
  },
  testClassifier: {
    input: z
      .object({
        candidate: classifierSetupInputSchema,
        bbRoot: z.string().optional(),
        nativeProviderOptions: z.record(z.string(), z.unknown()).optional(),
        onePasswordReference: z.string().max(2048).default(""),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  configureJevKey: {
    input: z
      .object({
        key: z.string().max(8192).nullable(),
        onePasswordReference: z.string().max(2048).default(""),
      })
      .strict(),
    output: z.object({ configured: z.boolean() }),
  },
  keyStatus: {
    input: z.object({}).strict(),
    output: z.object({ configured: z.boolean() }),
  },
  validateKey: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  evaluate: {
    input: z
      .object({
        state: z.string().max(16000),
        questions: z.record(
          z.string(),
          z.object({
            type: z.literal("choice"),
            instructions: z.string(),
            criteria: z.record(z.string(), z.string()),
          }),
        ),
      })
      .strict(),
    output: classifierResultSchema,
  },
  notePlan: {
    input: z
      .object({ threadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), plan: planSchema })
      .strict(),
    output: z.object({}),
  },
  getSession: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      route: routeSchema.nullable(),
      delegation: delegationSchema.nullable().optional(),
      revision: z.string().nullable().optional(),
      history: z.array(z.unknown()).max(100).optional(),
    }),
  },
});
