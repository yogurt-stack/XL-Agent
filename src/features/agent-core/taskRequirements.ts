import type { AgentState, LocalTaskIntent, ResourceCapability, TaskRequirements } from "./types";

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
