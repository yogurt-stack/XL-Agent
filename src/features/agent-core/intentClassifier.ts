import { parseRouteIntentDecision } from "./intentSchemas";
import type {
  CandidateSelectionDecision,
  RouteIntentDecision
} from "./intentSchemas";
import type { SystemProfile } from "./types";

export type IntentClassifierContext = {
  task: string;
  links: string[];
  profile: SystemProfile;
  skills: Array<{
    id: string;
    displayName: string;
    description: string;
  }>;
};

export interface IntentClassifier {
  classify(
    context: IntentClassifierContext,
    signal?: AbortSignal
  ): Promise<RouteIntentDecision>;
}

export type IntentClassificationRequest = (
  context: IntentClassifierContext,
  signal?: AbortSignal
) => Promise<unknown>;

/**
 * 将模型传输与路由器隔离，并在模型输出进入路由决策前执行严格协议校验。
 */
export class LlmIntentClassifier implements IntentClassifier {
  constructor(private readonly request: IntentClassificationRequest) {}

  async classify(
    context: IntentClassifierContext,
    signal?: AbortSignal
  ) {
    return parseRouteIntentDecision(await this.request(context, signal));
  }
}

export type CandidateSelectorInput = {
  task: string;
  candidates: Array<{
    fullName: string;
    description: string | null;
    stars: number;
    language: string | null;
    topics: string[];
  }>;
};

export interface CandidateSelector {
  select(
    input: CandidateSelectorInput,
    signal?: AbortSignal
  ): Promise<CandidateSelectionDecision>;
}

export class LlmCandidateSelector implements CandidateSelector {
  constructor(
    private readonly request: (
      input: CandidateSelectorInput,
      signal?: AbortSignal
    ) => Promise<CandidateSelectionDecision>
  ) {}

  select(input: CandidateSelectorInput, signal?: AbortSignal) {
    return this.request(input, signal);
  }
}
