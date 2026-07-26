import {
  trustedCatalog,
  trustedCatalogMetadata
} from "./generatedTrustedCatalog";
import type {
  ClarificationQuestion,
  SystemProfile,
  TrustedCatalogStatus
} from "./types";

export { trustedCatalog, trustedCatalogMetadata };

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

export function getTrustedCatalogStatus(now = new Date()): TrustedCatalogStatus {
  const generatedAt = Date.parse(trustedCatalogMetadata.generatedAt);
  const expiresAt = Date.parse(trustedCatalogMetadata.expiresAt);
  const current = now.getTime();
  if (!Number.isFinite(current) || !Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)) {
    return "invalid";
  }
  if (current < generatedAt) return "not-yet-valid";
  if (current >= expiresAt) return "expired";
  return "active";
}

export const catalogById = new Map(trustedCatalog.map((resource) => [resource.id, resource]));
