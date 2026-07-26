import os from "node:os";
import path from "node:path";
import type {
  HostArchitecture,
  HostPlatform,
  HostSystemProfile
} from "../src/features/agent-core/types";

function normalizePlatform(value: NodeJS.Platform): HostPlatform {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  return "unknown";
}

function normalizeArchitecture(value: string): HostArchitecture {
  if (value === "x64" || value === "arm64") return value;
  return "other";
}

function platformLabel(platform: HostPlatform) {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "win32") return "Windows";
  return "未知系统";
}

function shellBasename(rawShell: string | undefined) {
  if (!rawShell) return "unknown";
  return path.basename(rawShell).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown";
}

export function readHostSystemProfile(): HostSystemProfile {
  const platform = normalizePlatform(process.platform);
  return {
    platform,
    platformLabel: platformLabel(platform),
    architecture: normalizeArchitecture(process.arch),
    release: os.release().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown",
    cpuCount: os.cpus().length,
    totalMemoryGb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    defaultShell: shellBasename(process.env.SHELL ?? process.env.ComSpec),
    collectedBy: "electron-main",
    collectedAt: new Date().toISOString(),
    privacy: {
      hostname: false,
      username: false,
      homeDirectory: false,
      environment: false,
      shellPath: false
    }
  };
}
