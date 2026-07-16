import { windows11Profile } from "./catalog";
import type {
  HostArchitecture,
  HostPlatform,
  HostSystemProfile,
  SystemProfile,
  SystemProfileToolOutput
} from "./types";

const profileBoundary =
  "Host profile is read-only telemetry; plan validation still uses the locked Windows target profile." as const;

const profilePrivacy = {
  hostname: false,
  username: false,
  homeDirectory: false,
  environment: false,
  shellPath: false
} as const;

export function createFallbackHostProfile(collectedAt = "renderer-fallback-static"): HostSystemProfile {
  return {
    platform: "unknown",
    platformLabel: "浏览器预览环境",
    architecture: "other",
    release: "unknown",
    cpuCount: 0,
    totalMemoryGb: 0,
    defaultShell: "unknown",
    collectedBy: "renderer-fallback",
    collectedAt,
    privacy: profilePrivacy
  };
}

export function createSystemProfileToolOutput(
  hostProfile: HostSystemProfile = createFallbackHostProfile(),
  targetProfile: SystemProfile = windows11Profile
): SystemProfileToolOutput {
  return {
    targetProfile,
    hostProfile,
    planningProfileSource: "locked-demo-target",
    boundary: profileBoundary
  };
}

export function isHostSystemProfile(value: unknown): value is HostSystemProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<Record<keyof HostSystemProfile, unknown>>;
  return (
    isHostPlatform(profile.platform) &&
    typeof profile.platformLabel === "string" &&
    isHostArchitecture(profile.architecture) &&
    typeof profile.release === "string" &&
    typeof profile.cpuCount === "number" &&
    Number.isInteger(profile.cpuCount) &&
    profile.cpuCount >= 0 &&
    typeof profile.totalMemoryGb === "number" &&
    profile.totalMemoryGb >= 0 &&
    typeof profile.defaultShell === "string" &&
    (profile.collectedBy === "electron-main" || profile.collectedBy === "renderer-fallback") &&
    typeof profile.collectedAt === "string" &&
    isProfilePrivacy(profile.privacy)
  );
}

export function isSystemProfileToolOutput(value: unknown): value is SystemProfileToolOutput {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Partial<Record<keyof SystemProfileToolOutput, unknown>>;
  return (
    isTargetSystemProfile(output.targetProfile) &&
    isHostSystemProfile(output.hostProfile) &&
    output.planningProfileSource === "locked-demo-target" &&
    output.boundary === profileBoundary
  );
}

function isHostPlatform(value: unknown): value is HostPlatform {
  return value === "darwin" || value === "linux" || value === "win32" || value === "unknown";
}

function isHostArchitecture(value: unknown): value is HostArchitecture {
  return value === "x64" || value === "arm64" || value === "other";
}

function isTargetSystemProfile(value: unknown): value is SystemProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<SystemProfile>;
  return (
    profile.os === "Windows 11" &&
    profile.architecture === "x64" &&
    profile.shell === "PowerShell 7" &&
    profile.workspaceRoot === "C:\\XunleiAgent\\ai-dev-env-windows"
  );
}

function isProfilePrivacy(value: unknown): value is HostSystemProfile["privacy"] {
  if (typeof value !== "object" || value === null) return false;
  const privacy = value as Partial<HostSystemProfile["privacy"]>;
  return (
    privacy.hostname === false &&
    privacy.username === false &&
    privacy.homeDirectory === false &&
    privacy.environment === false &&
    privacy.shellPath === false
  );
}
