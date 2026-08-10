import { z } from "zod";

const decisionIdSchema = z.string().trim().min(1).max(160);
const modelIdSchema = z.string().trim().min(1).max(160);
const skillIdSchema = z.string().trim().min(1).max(80)
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/iu);
const reasonSchema = z.string().trim().min(1).max(4000);
const repositoryNameSchema = z.string().trim().min(1).max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u);

export const githubSemanticSearchHintSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("name"),
    query: repositoryNameSchema
  }).strict(),
  z.object({
    mode: z.literal("discovery"),
    query: z.string().trim().min(1).max(200).optional()
  }).strict()
]);

export const routeIntentToolArgumentsSchema = z.object({
  skillId: skillIdSchema.nullable(),
  githubSearch: githubSemanticSearchHintSchema.optional(),
  reason: reasonSchema
}).strict().superRefine((value, context) => {
  if (
    value.githubSearch &&
    value.skillId !== "github-project-discovery"
  ) {
    context.addIssue({
      code: "custom",
      path: ["githubSearch"],
      message: "githubSearch 只能用于 github-project-discovery。"
    });
  }
});

export const routeIntentDecisionSchema = routeIntentToolArgumentsSchema
  .safeExtend({
    decisionId: decisionIdSchema,
    provider: z.literal("remote-llm"),
    model: modelIdSchema
  })
  .strict();

export type GitHubSemanticSearchHint = z.infer<
  typeof githubSemanticSearchHintSchema
>;
export type RouteIntentToolArguments = z.infer<
  typeof routeIntentToolArgumentsSchema
>;
export type RouteIntentDecision = z.infer<
  typeof routeIntentDecisionSchema
>;

export function parseRouteIntentToolArguments(
  value: unknown
): RouteIntentToolArguments {
  return routeIntentToolArgumentsSchema.parse(value);
}

export function parseRouteIntentDecision(value: unknown): RouteIntentDecision {
  return routeIntentDecisionSchema.parse(value);
}

export const candidateSelectionToolArgumentsSchema = z.object({
  selectedFullNames: z.array(
    z.string().trim().regex(
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u
    )
  ).min(1).max(3),
  reason: z.string().trim().min(1).max(2000)
}).strict();

export const candidateSelectionDecisionSchema =
  candidateSelectionToolArgumentsSchema.safeExtend({
    decisionId: decisionIdSchema,
    provider: z.literal("remote-llm"),
    model: modelIdSchema
  }).strict();

export type CandidateSelectionDecision = z.infer<
  typeof candidateSelectionDecisionSchema
>;

export function parseCandidateSelectionToolArguments(value: unknown) {
  return candidateSelectionToolArgumentsSchema.parse(value);
}

export function parseCandidateSelectionDecision(
  value: unknown
): CandidateSelectionDecision {
  return candidateSelectionDecisionSchema.parse(value);
}
