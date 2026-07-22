import { describe, expect, it } from "vitest";
import { createInitialAgentState } from "./machine";
import { groupedToolResults, overallProgress, requiredMissingResources } from "./selectors";
import type { AgentState, ToolResult, TrustedDownloadMetadata } from "./types";

const testDownload: TrustedDownloadMetadata = {
  url: "https://downloads.xunlei.example/test/resource.bin",
  expectedSha256: "d6f41ccfbdb978330567c70b892518af6bb9d934c264ff4d8ea8f8f7dff9e676",
  maxSizeMb: 2,
  allowedHosts: ["downloads.xunlei.example"]
};

function withToolResults(results: ToolResult[]): AgentState {
  const state = createInitialAgentState();
  return {
    ...state,
    agentRun: { ...state.agentRun, toolResults: results }
  };
}

describe("agent presentation selectors", () => {
  it("groups high-frequency tool results and preserves failure counts", () => {
    const state = withToolResults([
      {
        callId: "profile",
        tool: "read_system_profile",
        status: "success",
        output: {},
        startedAt: "start",
        finishedAt: "finish"
      },
      {
        callId: "download-25",
        tool: "simulate_download",
        status: "success",
        output: { resourceId: "sample-project", progress: 25 },
        startedAt: "start",
        finishedAt: "finish"
      },
      {
        callId: "download-failed",
        tool: "simulate_download",
        status: "error",
        error: { code: "CHECKSUM_MISMATCH", message: "Checksum mismatch", retriable: true },
        startedAt: "start",
        finishedAt: "finish"
      }
    ]);

    expect(groupedToolResults(state)).toEqual([
      expect.objectContaining({
        tool: "read_system_profile",
        successCount: 1,
        errorCount: 0,
        latestStatus: "success"
      }),
      expect.objectContaining({
        tool: "simulate_download",
        successCount: 1,
        errorCount: 1,
        latestStatus: "error",
        results: expect.arrayContaining([
          expect.objectContaining({ callId: "download-25" }),
          expect.objectContaining({ callId: "download-failed" })
        ])
      })
    ]);
  });

  it("calculates progress and missing required resources from selected state", () => {
    const initial = createInitialAgentState();
    const state: AgentState = {
      ...initial,
      resources: [
        {
          id: "required",
          name: "Required",
          version: "1",
          source: "test",
          sizeMb: 1,
          license: "MIT",
          purpose: "test",
          recommendation: "test",
          required: true,
          dependsOn: [],
          provides: ["python-runtime"],
          requiresCapabilities: [],
          supportedOperatingSystems: ["Windows 11"],
          supportedArchitectures: ["x64"],
          sourceTrust: "official",
          download: testDownload,
          selected: true,
          status: "downloading",
          progress: 50,
          attempts: 1
        },
        {
          id: "optional",
          name: "Optional",
          version: "1",
          source: "test",
          sizeMb: 1,
          license: "MIT",
          purpose: "test",
          recommendation: "test",
          required: false,
          dependsOn: [],
          provides: ["code-editor"],
          requiresCapabilities: [],
          supportedOperatingSystems: ["Windows 11"],
          supportedArchitectures: ["x64"],
          sourceTrust: "official",
          download: testDownload,
          selected: false,
          status: "pending",
          progress: 0,
          attempts: 0
        }
      ]
    };

    expect(overallProgress(state)).toBe(50);
    expect(requiredMissingResources(state).map((resource) => resource.id)).toEqual(["required"]);
  });
});
