import type { ClarificationQuestion, SystemProfile, TrustedDownloadMetadata, TrustedResource } from "./types";

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
const trustedDownloadHost = "downloads.xunlei.example";

function trustedDownload(
  fileName: string,
  maxSizeMb: number,
  expectedSha256: string
): TrustedDownloadMetadata {
  return {
    url: `https://${trustedDownloadHost}/windows-ai-dev/${fileName}`,
    expectedSha256,
    maxSizeMb,
    allowedHosts: [trustedDownloadHost]
  };
}

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
    download: trustedDownload(
      "python-3.12.4-amd64.exe",
      32,
      "7b16d7f7610a4c9ebdb31d2b2ed7b0e0c3c9f681d7b9f2d4545cbf88d07a8c3a"
    ),
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
    download: trustedDownload(
      "vscode-stable-1.91-x64.exe",
      128,
      "59e5dd4db0c2dfaa6c03f4a9f98e1c8f0e16e0c2d2c0993c88f0ab622c91f4f2"
    ),
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
    download: trustedDownload(
      "git-2.45.2-64-bit.exe",
      80,
      "c2d4519d06c2d6d0fb8a44d9d93e6b95c51ef4e9871d5ceaf3c11ac4e0db0c4b"
    ),
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
    sourceTrust: "official",
    download: trustedDownload(
      "node-v20.15.1-x64.msi",
      48,
      "47edcfa2f4cbf7778c4f3a301d11f65ab6d4a64fe4a5afec4dd6e2a55da2bf85"
    )
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
    download: trustedDownload(
      "ai-dev-starter-0.3.0.zip",
      24,
      "b4a0f36f2cc8f5c7d09ea6d0f9f0de58b79b631aa6a5a8b09f9f0a8e2a4c7d1b"
    ),
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
    sourceTrust: "trusted-mirror",
    download: trustedDownload(
      "miniforge-py312-24.5.0-x64.exe",
      96,
      "2fd3da4aee476efb1a77241a1e64f45ebee191d01fe3f4c0dfcd03b152971a3a"
    )
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
    sourceTrust: "trusted-mirror",
    download: trustedDownload(
      "vscode-stable-1.91-x64.zip",
      128,
      "1f25efb79b46f023a7b285616436765f78f2e2de7d75b0fd5e8f9dd2d5e7c1fd"
    )
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
    sourceTrust: "trusted-mirror",
    download: trustedDownload(
      "git-portable-2.45.2-x64.7z.exe",
      80,
      "edb9b3e1b6cb31d91e2ef6dc84fd65e6111d3dc7a6e4a7128d7c0b2d7c16e37c"
    )
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
    sourceTrust: "trusted-mirror",
    download: trustedDownload(
      "ai-dev-starter-0.3.0-verified.zip",
      24,
      "a8d2c1d8ddcdd5bb3e0a9e51ed179aa7e4dbe6fb1d3d63a77312644ec6d35148"
    )
  }
];

export const catalogById = new Map(trustedCatalog.map((resource) => [resource.id, resource]));
