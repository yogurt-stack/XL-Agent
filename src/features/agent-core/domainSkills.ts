import { clarificationQuestions } from "./catalog";
import {
  deriveTaskRequirements,
  inferLocalTaskIntent
} from "./taskRequirements";
import {
  githubFullNameFromUrl,
  inferGitHubSearchIntent
} from "./githubSearch";
import type {
  AgentState,
  ClarificationQuestion,
  ResourceCapability,
  SystemProfile,
  TaskRequirements
} from "./types";

export type UserGoal = {
  text: string;
  links: string[];
};

export type ResourceRequirement = {
  capability: ResourceCapability;
  required: boolean;
};

export type PlanningContext = {
  goal: UserGoal;
  profile: SystemProfile;
  answers: AgentState["answers"];
};

export type WorkspaceContext = {
  goal: UserGoal;
  requirements: TaskRequirements;
};

export type WorkspaceGuide = {
  title: string;
  summary: string;
  nextActions: string[];
};

export interface DomainSkill {
  id: string;
  displayName: string;
  sourceProviderId?: string;
  matches(goal: UserGoal): boolean;
  clarify(goal: UserGoal, profile: SystemProfile): ClarificationQuestion[];
  buildRequirements(context: PlanningContext): ResourceRequirement[];
  generateGuide(context: WorkspaceContext): WorkspaceGuide;
}

export class DomainSkillRegistry {
  private readonly skills = new Map<string, DomainSkill>();

  constructor(skills: DomainSkill[] = []) {
    for (const skill of skills) this.register(skill);
  }

  register(skill: DomainSkill) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(skill.id)) {
      throw new Error(`Domain Skill ID 非法：${skill.id}`);
    }
    if (this.skills.has(skill.id)) {
      throw new Error(`Domain Skill 已注册：${skill.id}`);
    }
    this.skills.set(skill.id, skill);
    return this;
  }

  get(skillId: string) {
    return this.skills.get(skillId) ?? null;
  }

  match(goal: UserGoal) {
    return [...this.skills.values()].find((skill) => skill.matches(goal)) ?? null;
  }

  list() {
    return [...this.skills.values()];
  }
}

function normalizedTask(text: string) {
  return text.normalize("NFKC").trim().toLowerCase();
}

export class GitHubProjectDiscoverySkill implements DomainSkill {
  readonly id = "github-project-discovery";
  readonly displayName = "GitHub 开源项目检索";
  readonly sourceProviderId = "github-api";

  matches(goal: UserGoal) {
    const task = normalizedTask(goal.text);
    const hasGitHubRepositoryLink = goal.links.some(
      (link) => githubFullNameFromUrl(link) !== null
    );
    const hasSpecificRepositoryIntent =
      inferGitHubSearchIntent(goal).mode !== "discovery";
    return hasGitHubRepositoryLink || (
      task.includes("github") && (
        hasSpecificRepositoryIntent ||
        [
          "项目",
          "仓库",
          "开源",
          "热门",
          "最新",
          "repository",
          "repositories",
          "repo",
          "trending"
        ].some((keyword) => task.includes(keyword))
      )
    );
  }

  clarify(goal: UserGoal, _profile: SystemProfile) {
    if (inferGitHubSearchIntent(goal).mode !== "discovery") return [];
    return [
      {
        id: "github-created-window",
        prompt: "要查看多长时间内新建的 GitHub 项目？",
        reason: "“最新”需要明确时间窗口，才能与 Star 热度一起稳定排序。",
        required: true,
        options: ["最近 7 天新建", "最近 30 天新建", "最近 90 天新建"]
      },
      {
        id: "github-sort",
        prompt: "这批项目优先按什么指标排序？",
        reason: "Star、最近更新和 Fork 分别代表不同的热门程度。",
        required: true,
        options: ["按 Star 数", "按最近更新", "按 Fork 数"]
      }
    ];
  }

  buildRequirements(_context: PlanningContext): ResourceRequirement[] {
    return [];
  }

  generateGuide(_context: WorkspaceContext): WorkspaceGuide {
    return {
      title: "GitHub 开源项目检索结果",
      summary:
        "结果来自 GitHub 只读 Repository Search API；选择仓库后可固定 commit 并创建受控下载计划。",
      nextActions: [
        "查看仓库的许可证、更新时间和社区热度。",
        "选择目标仓库并固定默认分支 commit。",
        "审批后下载仓库及可验证的锁文件依赖，并写入 Manifest。"
      ]
    };
  }
}

const aiDevelopmentKeywords = [
  "开发环境",
  "开发工具",
  "工具链",
  "编程",
  "代码",
  "python",
  "node.js",
  "nodejs",
  "react",
  "vite",
  "git",
  "vscode",
  "visual studio code",
  "人工智能",
  "机器学习",
  "深度学习",
  "大模型",
  " llm",
  " ai "
];

const intentClarifications: Record<
  "python-ai" | "fullstack-ai" | "base-development",
  ClarificationQuestion
> = {
  "python-ai": {
    id: "python-scope",
    prompt: "Python AI 环境是否需要同时准备前端工具链？",
    reason: "只有需要开发可视化界面时才加入 Node.js，避免增加不必要资源。",
    required: true,
    options: ["仅 Python AI", "同时准备 Node.js"]
  },
  "fullstack-ai": {
    id: "fullstack-scope",
    prompt: "全栈环境是否需要包含可验证的示例项目？",
    reason: "示例项目可以验证工具链，但只准备基础工具时可以省略。",
    required: true,
    options: ["包含可验证示例项目", "只准备全栈工具链"]
  },
  "base-development": {
    id: "base-editor",
    prompt: "基础开发工具是否需要包含 Visual Studio Code？",
    reason: "仅使用 Git 命令行时可以不准备编辑器安装包。",
    required: true,
    options: ["包含 VS Code", "仅 Git 命令行"]
  }
};

function explicitDevelopmentIntent(text: string) {
  const normalized = normalizedTask(text);
  if (
    ["全栈", "前端", "node.js", "nodejs", "react", "vite", "full stack", "fullstack"]
      .some((keyword) => normalized.includes(keyword))
  ) {
    return "fullstack-ai" as const;
  }
  if (
    ["python", "机器学习", "深度学习", "大模型", "llm"]
      .some((keyword) => normalized.includes(keyword))
  ) {
    return "python-ai" as const;
  }
  if (
    ["基础工具", "基础开发", "开发工具", "git", "vscode", "visual studio code"]
      .some((keyword) => normalized.includes(keyword))
  ) {
    return "base-development" as const;
  }
  return null;
}

export class AiDevelopmentEnvironmentSkill implements DomainSkill {
  readonly id = "ai-development-environment";
  readonly displayName = "AI 开发环境";
  readonly sourceProviderId = "trusted-catalog";

  matches(goal: UserGoal) {
    const task = ` ${normalizedTask(goal.text)} `;
    return (
      inferLocalTaskIntent(goal.text) !== "ambiguous" ||
      aiDevelopmentKeywords.some((keyword) => task.includes(keyword))
    );
  }

  clarify(goal: UserGoal, _profile: SystemProfile) {
    const intent = explicitDevelopmentIntent(goal.text);
    const questions = intent
      ? [intentClarifications[intent]]
      : clarificationQuestions.slice(0, 1);
    return questions.map((question) => ({
      ...question,
      options: [...question.options]
    }));
  }

  buildRequirements(context: PlanningContext): ResourceRequirement[] {
    const requirements = deriveTaskRequirements({
      task: context.goal.text,
      answers: context.answers
    });
    return requirements.requiredCapabilities.map((capability) => ({
      capability,
      required: true
    }));
  }

  generateGuide(context: WorkspaceContext): WorkspaceGuide {
    return {
      title: `${context.requirements.label}资源工作区`,
      summary: "已准备经过可信目录校验的 Windows 11 x64 开发资源。",
      nextActions: [
        "先阅读 resource-manifest.json 核对 Manifest revision。",
        "按 README.md 的人工步骤准备环境。",
        "不要自动运行 downloads/ 中的安装包或脚本。"
      ]
    };
  }
}

const researchKeywords = [
  "科研",
  "研究环境",
  "论文复现",
  "数据分析",
  "数据科学",
  "jupyter",
  "notebook",
  "research"
];

export class ResearchDataEnvironmentSkill implements DomainSkill {
  readonly id = "research-data-environment";
  readonly displayName = "科研数据环境";
  readonly sourceProviderId = "trusted-catalog";

  matches(goal: UserGoal) {
    const task = normalizedTask(goal.text);
    return researchKeywords.some((keyword) => task.includes(keyword));
  }

  clarify(_goal: UserGoal, _profile: SystemProfile) {
    return [{
      id: "research-template",
      prompt: "科研数据环境是否需要包含可验证的示例工作区？",
      reason: "示例工作区便于后续 Agent 核对资源交接；只准备基础工具时可以省略。",
      required: true,
      options: ["包含示例工作区", "只准备科研基础工具"]
    }];
  }

  buildRequirements(context: PlanningContext): ResourceRequirement[] {
    const requirements: ResourceRequirement[] = [
      { capability: "python-runtime", required: true },
      { capability: "code-editor", required: true },
      { capability: "source-control", required: true }
    ];
    if (
      context.answers["research-template"] !==
      "只准备科研基础工具"
    ) {
      requirements.push({
        capability: "workspace-template",
        required: true
      });
    }
    return requirements;
  }

  generateGuide(context: WorkspaceContext): WorkspaceGuide {
    return {
      title: "科研数据资源工作区",
      summary:
        "已准备经过可信目录校验的 Python、编辑器与版本管理资源；数据分析包仍需由用户后续人工配置。",
      nextActions: [
        `先核对 ${context.requirements.label} 的 resource-manifest.json。`,
        "按 README.md 人工安装基础工具，再创建隔离的 Python 环境。",
        "不要把资源已准备描述为科研环境已经安装完成。"
      ]
    };
  }
}

export function createDefaultDomainSkillRegistry() {
  return new DomainSkillRegistry([
    new GitHubProjectDiscoverySkill(),
    new ResearchDataEnvironmentSkill(),
    new AiDevelopmentEnvironmentSkill()
  ]);
}
