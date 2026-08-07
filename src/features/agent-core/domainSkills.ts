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
  matches(goal: UserGoal, state?: AgentState): boolean;
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

  match(goal: UserGoal, state?: AgentState) {
    return [...this.skills.values()].find((skill) => skill.matches(goal, state)) ?? null;
  }

  list() {
    return [...this.skills.values()];
  }
}

function normalizedTask(text: string) {
  return text.normalize("NFKC").trim().toLowerCase();
}

const localInspectionActions = [
  "查询",
  "查看",
  "检查",
  "检测",
  "探测",
  "盘点",
  "列出",
  "显示",
  "版本",
  "是否安装",
  "有没有安装",
  "有无安装",
  "已安装",
  "inspect",
  "check",
  "detect",
  "list",
  "show",
  "version",
  "installed"
];

const localDevelopmentToolKeywords = [
  "本地代码环境",
  "本地开发环境",
  "本机代码环境",
  "本机开发环境",
  "代码环境",
  "开发环境",
  "node.js",
  "nodejs",
  "npm",
  "python",
  " py ",
  "pip",
  "cuda",
  "nvcc",
  "nvidia-smi",
  "git"
];

/** 识别纯只读的本机开发工具版本盘点，且显式排除混合安装/下载请求。 */
export function isLocalDevelopmentEnvironmentInspectionGoal(text: string) {
  const normalized = ` ${normalizedTask(text)} `;
  const hasInspectionAction = localInspectionActions.some((keyword) =>
    normalized.includes(keyword)
  );
  const hasDevelopmentTool = localDevelopmentToolKeywords.some((keyword) =>
    normalized.includes(keyword)
  ) || /(^|[^\p{L}\p{N}_])(node|py)(?:\.exe)?($|[^\p{L}\p{N}_])/iu
    .test(normalized);
  if (!hasInspectionAction || !hasDevelopmentTool) return false;

  const withoutInstallationState = normalized
    .replace(/(是否|有没有|有无|已经|已)安装/gu, "")
    .replace(/installed/gu, "");
  return !/(安装|下载|搭建|部署|配置|准备|克隆|clone|download|setup|install)/iu
    .test(withoutInstallationState);
}

const compatibilityAssessmentSignals = [
  "匹配程度",
  "环境匹配",
  "兼容性",
  "是否兼容",
  "是否满足",
  "能否运行",
  "可以运行",
  "哪些已具备",
  "哪些具备",
  "哪些缺少",
  "还缺什么",
  "环境要求",
  "compatibility",
  "compatible",
  "requirements",
  "ready to run"
];

const compatibilityAssessmentTargets = [
  "pytorch",
  "torch",
  "tensorflow",
  "cuda",
  "机器学习",
  "深度学习",
  "qt",
  "occt",
  "opencascade",
  "cmake"
];

/** 识别“先调查本机，再判断目标技术是否可用”的只读分析任务。 */
export function isLocalEnvironmentCompatibilityAssessmentGoal(text: string) {
  const normalized = normalizedTask(text);
  return compatibilityAssessmentSignals.some((keyword) =>
    normalized.includes(keyword)
  ) && compatibilityAssessmentTargets.some((keyword) =>
    normalized.includes(keyword)
  );
}

export class LocalEnvironmentCompatibilityAssessmentSkill
implements DomainSkill {
  readonly id = "local-environment-compatibility-assessment";
  readonly displayName = "本地环境兼容性评估";
  readonly sourceProviderId = "electron-main";

  matches(goal: UserGoal) {
    return goal.links.length === 0 &&
      isLocalEnvironmentCompatibilityAssessmentGoal(goal.text);
  }

  clarify(_goal: UserGoal, _profile: SystemProfile) {
    return [];
  }

  buildRequirements(_context: PlanningContext): ResourceRequirement[] {
    return [];
  }

  generateGuide(_context: WorkspaceContext): WorkspaceGuide {
    return {
      title: "本地环境兼容性评估",
      summary:
        "Agent 只在已确认的只读能力范围内调查本机环境，并将证据回注模型形成兼容性结论。",
      nextActions: [
        "核对每项结论引用的本机探测证据。",
        "把无法由当前工具确认的条件保留为未知，不推断为已满足。",
        "如需安装或下载缺失项，创建新的 Task Plan revision 并重新审批。"
      ]
    };
  }
}

const localProjectAssessmentSignals = [
  "这个仓库",
  "当前仓库",
  "本地仓库",
  "这个项目",
  "当前项目",
  "项目环境",
  "项目依赖",
  "运行要求",
  "构建要求",
  "能否运行",
  "能不能运行",
  "缺少什么",
  "还缺什么",
  "匹配程度",
  "兼容性",
  "readme",
  "repository requirements",
  "project requirements",
  "build requirements"
];

/** 识别针对当前已导入固定 HEAD 的项目要求与本机环境对比任务。 */
export function isLocalProjectEnvironmentCompatibilityGoal(text: string) {
  const normalized = normalizedTask(text);
  return localProjectAssessmentSignals.some((keyword) =>
    normalized.includes(keyword)
  );
}

export class LocalProjectEnvironmentCompatibilitySkill
implements DomainSkill {
  readonly id = "local-project-environment-compatibility";
  readonly displayName = "本地项目环境兼容性分析";
  readonly sourceProviderId = "local-git";

  matches(goal: UserGoal, state?: AgentState) {
    return goal.links.length === 0 &&
      Boolean(state?.localRepository) &&
      isLocalProjectEnvironmentCompatibilityGoal(goal.text);
  }

  clarify(_goal: UserGoal, _profile: SystemProfile) {
    return [];
  }

  buildRequirements(_context: PlanningContext): ResourceRequirement[] {
    return [];
  }

  generateGuide(_context: WorkspaceContext): WorkspaceGuide {
    return {
      title: "本地项目环境兼容性报告",
      summary:
        "结论来自仓库固定 HEAD 的白名单项目文件与本机固定命令探测；仓库内容按不可信数据处理。",
      nextActions: [
        "核对每项要求的仓库相对路径与固定 commit。",
        "把未被本机探测覆盖的库或包保留为无法确认。",
        "需要安装、下载或执行项目时，另建需要审批的 Task Plan revision。"
      ]
    };
  }
}

const githubProjectAssessmentSignals = [
  "运行与构建要求",
  "项目环境",
  "项目依赖",
  "运行要求",
  "构建要求",
  "环境兼容",
  "匹配本机",
  "缺少和无法确认",
  "repository requirements",
  "project requirements",
  "build requirements",
  "environment compatibility"
];

/** 识别针对当前已固定 GitHub commit 的项目要求与本机环境对比任务。 */
export function isGitHubProjectEnvironmentCompatibilityGoal(text: string) {
  const normalized = normalizedTask(text);
  return githubProjectAssessmentSignals.some((keyword) =>
    normalized.includes(keyword)
  );
}

export class GitHubProjectEnvironmentCompatibilitySkill
implements DomainSkill {
  readonly id = "github-project-environment-compatibility";
  readonly displayName = "GitHub 项目环境兼容性分析";
  readonly sourceProviderId = "github-api";

  matches(goal: UserGoal, state?: AgentState) {
    return goal.links.length === 0 &&
      Boolean(state?.githubRepository) &&
      isGitHubProjectEnvironmentCompatibilityGoal(goal.text);
  }

  clarify(_goal: UserGoal, _profile: SystemProfile) {
    return [];
  }

  buildRequirements(_context: PlanningContext): ResourceRequirement[] {
    return [];
  }

  generateGuide(_context: WorkspaceContext): WorkspaceGuide {
    return {
      title: "GitHub 项目环境兼容性报告",
      summary:
        "结论来自固定 commit/tree 的 GitHub 白名单文本证据与本机固定命令探测；不下载或执行仓库内容。",
      nextActions: [
        "核对仓库 fullName、commitSha、treeSha 与每项要求的来源文件。",
        "把未被本机探测覆盖的包、库或平台条件保留为无法确认。",
        "需要下载源码、安装依赖或执行项目时，另建需要审批的 Task Plan revision。"
      ]
    };
  }
}

export class LocalDevelopmentEnvironmentInspectionSkill implements DomainSkill {
  readonly id = "local-development-environment-inspection";
  readonly displayName = "本地开发环境只读盘点";
  readonly sourceProviderId = "electron-main";

  matches(goal: UserGoal) {
    return goal.links.length === 0 &&
      isLocalDevelopmentEnvironmentInspectionGoal(goal.text);
  }

  clarify(_goal: UserGoal, _profile: SystemProfile) {
    return [];
  }

  buildRequirements(_context: PlanningContext): ResourceRequirement[] {
    return [];
  }

  generateGuide(_context: WorkspaceContext): WorkspaceGuide {
    return {
      title: "本地开发环境版本清单",
      summary: "结果来自 Electron Main 固定命令白名单，只读且不会下载、安装或修改本机环境。",
      nextActions: [
        "核对已检测工具的版本与命令入口。",
        "将未找到与不适用区分处理。",
        "只有用户后续明确提出安装需求时，才创建独立资源计划。"
      ]
    };
  }
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
    new GitHubProjectEnvironmentCompatibilitySkill(),
    new LocalProjectEnvironmentCompatibilitySkill(),
    new LocalEnvironmentCompatibilityAssessmentSkill(),
    new LocalDevelopmentEnvironmentInspectionSkill(),
    new GitHubProjectDiscoverySkill(),
    new ResearchDataEnvironmentSkill(),
    new AiDevelopmentEnvironmentSkill()
  ]);
}
