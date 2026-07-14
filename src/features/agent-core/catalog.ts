import type { ClarificationQuestion, SystemProfile, TrustedResource } from "./types";

export const windows11Profile: SystemProfile = {
  os: "Windows 11",
  architecture: "x64",
  shell: "PowerShell 7",
  workspaceRoot: "C:\\XunleiAgent\\ai-dev-env-windows"
};

export const clarificationQuestions: ClarificationQuestion[] = [
  {
    id: "primary-workload",
    prompt: "这个环境的主要工作负载是什么？",
    reason: "用于确定是否把 Node.js 前端工具链作为默认可选资源保留在计划中。",
    required: true,
    options: ["Python AI 开发", "全栈 AI 应用", "仅准备基础环境"]
  },
  {
    id: "mirror-policy",
    prompt: "是否允许在可信目录内使用备用镜像？",
    reason: "当官方包校验或版本验证失败时，备用镜像可生成新的待确认替代计划。",
    required: false,
    options: ["允许备用镜像", "仅使用主来源"]
  }
];

const windows11 = ["Windows 11"] as const;
const x64 = ["x64"] as const;

export const trustedCatalog: TrustedResource[] = [
  {
    id: "python-312",
    name: "Python",
    version: "3.12.4 x64",
    source: "python.org",
    sizeMb: 25.8,
    license: "PSF License",
    purpose: "AI 运行时与脚本环境",
    recommendation: "Windows 11 x64 官方安装包，支持当前示例项目。",
    required: true,
    dependsOn: [],
    provides: ["python-runtime"],
    requiresCapabilities: [],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "official",
    fallbackId: "miniforge-py312"
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    version: "Stable 1.91 x64",
    source: "Microsoft",
    sizeMb: 96.4,
    license: "Microsoft Software License Terms",
    purpose: "代码编辑、终端与扩展管理",
    recommendation: "官方稳定版，适合作为 Windows 开发入口。",
    required: true,
    dependsOn: [],
    provides: ["code-editor"],
    requiresCapabilities: [],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "official",
    fallbackId: "vscode-zip"
  },
  {
    id: "git",
    name: "Git for Windows",
    version: "2.45.2 x64",
    source: "Git SCM",
    sizeMb: 63.1,
    license: "GPL-2.0-only",
    purpose: "源码管理与依赖拉取",
    recommendation: "官方发行版，保留默认 PATH 策略。",
    required: true,
    dependsOn: [],
    provides: ["source-control"],
    requiresCapabilities: [],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "official",
    fallbackId: "git-portable"
  },
  {
    id: "node-lts",
    name: "Node.js LTS",
    version: "20.15.1 LTS x64",
    source: "nodejs.org",
    sizeMb: 31.6,
    license: "MIT",
    purpose: "Vite、npm 与前端工具链",
    recommendation: "当任务包含全栈或前端启动需求时推荐保留。",
    required: false,
    dependsOn: [],
    provides: ["node-runtime"],
    requiresCapabilities: [],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "official"
  },
  {
    id: "sample-project",
    name: "AI Dev Starter",
    version: "0.3.0",
    source: "Xunlei Trusted Catalog",
    sizeMb: 18.7,
    license: "MIT",
    purpose: "环境验证、README 与最小示例代码",
    recommendation: "包含 Windows 初始化和验证脚本。",
    required: true,
    dependsOn: ["python-312", "git"],
    provides: ["workspace-template"],
    requiresCapabilities: ["python-runtime", "source-control"],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "trusted-catalog",
    fallbackId: "sample-project-mirror"
  },
  {
    id: "miniforge-py312",
    name: "Miniforge Python Runtime",
    version: "24.5.0 / Python 3.12 x64",
    source: "Conda Forge Trusted Mirror",
    sizeMb: 84.2,
    license: "BSD-3-Clause",
    purpose: "Python 官方安装包的可信替代运行时",
    recommendation: "仅在主 Python 包不可用或版本不匹配时启用。",
    required: true,
    dependsOn: [],
    provides: ["python-runtime"],
    requiresCapabilities: [],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "trusted-mirror"
  },
  {
    id: "vscode-zip",
    name: "Visual Studio Code ZIP",
    version: "Stable 1.91 x64",
    source: "Microsoft Archive",
    sizeMb: 112.8,
    license: "Microsoft Software License Terms",
    purpose: "VS Code 安装包的免安装替代交付",
    recommendation: "主安装包被取消或不可用时启用。",
    required: true,
    dependsOn: [],
    provides: ["code-editor"],
    requiresCapabilities: [],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "trusted-mirror"
  },
  {
    id: "git-portable",
    name: "Git Portable",
    version: "2.45.2 x64",
    source: "Git SCM Archive",
    sizeMb: 64.7,
    license: "GPL-2.0-only",
    purpose: "Git 安装包的可信替代交付",
    recommendation: "主 Git 包被取消或不可用时启用。",
    required: true,
    dependsOn: [],
    provides: ["source-control"],
    requiresCapabilities: [],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "trusted-mirror"
  },
  {
    id: "sample-project-mirror",
    name: "AI Dev Starter Mirror",
    version: "0.3.0 verified",
    source: "Xunlei Verified Mirror",
    sizeMb: 18.9,
    license: "MIT",
    purpose: "示例项目代码包的可信备用源",
    recommendation: "主包校验失败后使用已验证镜像。",
    required: true,
    dependsOn: ["python-312", "git"],
    provides: ["workspace-template"],
    requiresCapabilities: ["python-runtime", "source-control"],
    supportedOperatingSystems: [...windows11],
    supportedArchitectures: [...x64],
    sourceTrust: "trusted-mirror"
  }
];

export const catalogById = new Map(trustedCatalog.map((resource) => [resource.id, resource]));
