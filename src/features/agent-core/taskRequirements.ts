import { trustedCatalog } from "./catalog";
import type { AgentState, LocalTaskIntent, ResourceCapability, TaskRequirements } from "./types";

type SupportedLocalIntent = Exclude<LocalTaskIntent, "ambiguous">;

const resourceIdsByIntent: Record<SupportedLocalIntent, string[]> = {
  "python-ai": ["python-312", "vscode", "git", "sample-project"],
  "fullstack-ai": ["python-312", "vscode", "git", "node-lts", "sample-project"],
  "base-development": ["vscode", "git"]
};

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

/** 使用任务文本和主要工作负载答案识别当前垂直 Agent 支持的任务类型。 */
export function inferLocalTaskIntent(task: string, workloadAnswer?: string): LocalTaskIntent {
  if (workloadAnswer === "全栈 AI 应用") return "fullstack-ai";
  if (workloadAnswer === "Python AI 开发") return "python-ai";
  if (workloadAnswer === "仅准备基础环境") return "base-development";

  const normalized = task.trim().toLowerCase();
  if (
    includesAny(normalized, ["全栈", "前端", "node.js", "nodejs", "react", "vite", "full stack", "fullstack"])
  ) {
    return "fullstack-ai";
  }
  if (
    includesAny(normalized, ["python", "人工智能", "机器学习", "深度学习", "大模型", "llm", "ai 开发", "ai环境", "ai 环境"])
  ) {
    return "python-ai";
  }
  if (includesAny(normalized, ["基础工具", "基础开发", "开发工具", "git", "vscode", "visual studio code", "basic tools"])) {
    return "base-development";
  }
  return "ambiguous";
}

/**
 * 将已识别的任务意图转换为可信目录中的主来源资源候选。
 * 该映射同时供本地模型和目录搜索使用，避免两条规划路径产生不同资源组合。
 */
export function resourceIdsForTaskIntent(
  intent: LocalTaskIntent,
  answers: AgentState["answers"]
) {
  if (intent === "ambiguous") return [];
  const resourceIds = [...resourceIdsByIntent[intent]];
  if (intent === "python-ai" && answers["python-scope"] === "同时准备 Node.js") {
    resourceIds.splice(3, 0, "node-lts");
  }
  if (intent === "fullstack-ai" && answers["fullstack-scope"] === "只准备全栈工具链") {
    return resourceIds.filter((resourceId) => resourceId !== "sample-project");
  }
  if (intent === "base-development" && answers["base-editor"] === "仅 Git 命令行") {
    return ["git"];
  }
  return resourceIds;
}

export function resourceIdsForTask(
  state: Pick<AgentState, "task" | "answers">
) {
  const workloadAnswer = state.answers["primary-workload"];
  const intent = inferLocalTaskIntent(
    state.task,
    workloadAnswer === "skipped" ? undefined : workloadAnswer
  );
  return resourceIdsForTaskIntent(intent, state.answers);
}

/**
 * 为扩展 Domain Skill 的能力需求选择可信目录主来源，并闭包补齐资源依赖能力。
 * 显式的领域规则仍可通过任务意图给出更精确组合；该函数是新增 Skill 的安全本地兜底。
 */
export function resourceIdsForCapabilities(
  requiredCapabilities: ResourceCapability[]
) {
  const fallbackIds = new Set(
    trustedCatalog.flatMap((resource) =>
      resource.fallbackId ? [resource.fallbackId] : []
    )
  );
  const selectedIds: string[] = [];
  const covered = new Set<ResourceCapability>();
  const pending = [...new Set(requiredCapabilities)];

  while (pending.length > 0) {
    const capability = pending.shift()!;
    if (covered.has(capability)) continue;
    const resource =
      trustedCatalog.find(
        (candidate) =>
          candidate.catalogStatus === "active" &&
          !fallbackIds.has(candidate.id) &&
          candidate.provides.includes(capability)
      ) ??
      trustedCatalog.find(
        (candidate) =>
          candidate.catalogStatus === "active" &&
          candidate.provides.includes(capability)
      );
    if (!resource) continue;
    if (!selectedIds.includes(resource.id)) selectedIds.push(resource.id);
    resource.provides.forEach((provided) => covered.add(provided));
    resource.requiresCapabilities.forEach((required) => {
      if (!covered.has(required)) pending.push(required);
    });
  }

  return selectedIds;
}

function uniqueCapabilities(capabilities: ResourceCapability[]) {
  return [...new Set(capabilities)];
}

/**
 * 将自然语言意图和澄清答案转换为确定性的能力需求。
 * 模型可以选择不同可信资源，但不能省略这些能力。
 */
export function deriveTaskRequirements(
  state: Pick<AgentState, "task" | "answers">
): TaskRequirements {
  const workloadAnswer = state.answers["primary-workload"];
  const intent = inferLocalTaskIntent(
    state.task,
    workloadAnswer === "skipped" ? undefined : workloadAnswer
  );
  const requiredCapabilities: ResourceCapability[] = [];

  if (intent === "python-ai") {
    requiredCapabilities.push("python-runtime", "code-editor", "source-control", "workspace-template");
    if (state.answers["python-scope"] === "同时准备 Node.js") {
      requiredCapabilities.push("node-runtime");
    }
  } else if (intent === "fullstack-ai") {
    requiredCapabilities.push("python-runtime", "code-editor", "source-control", "node-runtime");
    if (state.answers["fullstack-scope"] !== "只准备全栈工具链") {
      requiredCapabilities.push("workspace-template");
    }
  } else if (intent === "base-development") {
    requiredCapabilities.push("source-control");
    if (state.answers["base-editor"] !== "仅 Git 命令行") {
      requiredCapabilities.push("code-editor");
    }
  }

  const labels: Record<LocalTaskIntent, string> = {
    "python-ai": "Python AI 开发环境",
    "fullstack-ai": "全栈 AI 应用环境",
    "base-development": "基础开发工具环境",
    ambiguous: "尚未明确的开发环境"
  };

  return {
    intent,
    label: labels[intent],
    requiredCapabilities: uniqueCapabilities(requiredCapabilities)
  };
}
