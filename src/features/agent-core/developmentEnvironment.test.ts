import { describe, expect, it } from "vitest";
import {
  validateLocalEnvironmentCompatibilityAssessment
} from "./developmentEnvironment";

const observation = {
  host: { platform: "win32" as const, architecture: "x64" as const },
  tools: [{
    id: "python3" as const,
    name: "Python 3",
    command: "python3.exe",
    status: "available" as const,
    version: "Python 3.12.4",
    detail: null
  }, {
    id: "cuda-compiler" as const,
    name: "CUDA Compiler",
    command: "nvcc.exe",
    status: "not_found" as const,
    version: null,
    detail: null
  }, {
    id: "nvidia-gpu" as const,
    name: "NVIDIA GPU / Driver",
    command: "nvidia-smi.exe",
    status: "error" as const,
    version: null,
    detail: "探测命令执行失败"
  }],
  collectedAt: "2026-08-07T00:00:00.000Z",
  source: "electron-main-fixed-command-allowlist" as const,
  boundary: "read-only-fixed-command-allowlist" as const
};

describe("local environment compatibility assessment validation", () => {
  it("accepts factual lists grounded in the fixed command observation", () => {
    expect(validateLocalEnvironmentCompatibilityAssessment({
      overallCompatibility: "unresolved",
      observedTools: observation.tools.map((tool) => ({
        toolId: tool.id,
        status: tool.status,
        observedVersion: tool.version,
        observedDetail: tool.detail
      })),
      unresolved: [
        "PyTorch 包版本和可导入状态尚未探测"
      ],
      conflicts: [],
      proposedNextActions: ["新增包级只读检查工具后再评估"]
    }, observation)).toEqual({ ok: true });
  });

  it("rejects a real call reference paired with a conclusion opposite to the observation", () => {
    expect(validateLocalEnvironmentCompatibilityAssessment({
      overallCompatibility: "unresolved",
      observedTools: observation.tools.map((tool) => ({
        toolId: tool.id,
        status: tool.id === "python3" ? "not_found" : tool.status,
        observedVersion: tool.version,
        observedDetail: tool.detail
      })),
      unresolved: ["PyTorch 包版本和可导入状态尚未探测"]
    }, observation)).toMatchObject({
      ok: false,
      code: "OBSERVED_TOOL_FACT_MISMATCH"
    });
  });

  it("rejects a fabricated version even when the tool id is real", () => {
    expect(validateLocalEnvironmentCompatibilityAssessment({
      overallCompatibility: "unresolved",
      observedTools: observation.tools.map((tool) => ({
        toolId: tool.id,
        status: tool.status,
        observedVersion: tool.id === "python3" ? "Python 99" : tool.version,
        observedDetail: tool.detail
      })),
      unresolved: ["PyTorch 包版本和可导入状态尚未探测"]
    }, observation)).toMatchObject({
      ok: false,
      code: "OBSERVED_TOOL_FACT_MISMATCH"
    });
  });
});
