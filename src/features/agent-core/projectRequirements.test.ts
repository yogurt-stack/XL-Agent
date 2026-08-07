import { describe, expect, it } from "vitest";
import {
  analyzeProjectRequirementFiles,
  isProjectEvidencePath
} from "./projectRequirements";
import {
  buildProjectCompatibilityAssessment,
  validateProjectCompatibilityAssessment
} from "./projectCompatibility";
import type {
  LocalDevelopmentEnvironmentOutput,
  ProjectRequirementsOutput
} from "./types";

const repository = {
  repositoryHandleId: "local-repo-fixture",
  displayName: "fixture",
  commitSha: "a".repeat(40)
};

function evidence(relativePath: string, content: string, index: number) {
  return {
    relativePath,
    objectId: String(index).repeat(40),
    content,
    bytesRead: new TextEncoder().encode(content).byteLength,
    truncated: false
  };
}

describe("project requirement extraction", () => {
  it("extracts explicit runtime, CMake, Qt, OCCT and Python package requirements", () => {
    const output = analyzeProjectRequirementFiles({
      repository,
      files: [
        evidence("package.json", JSON.stringify({
          engines: { node: ">=20", npm: ">=10" },
          packageManager: "pnpm@9.1.0"
        }), 1),
        evidence("requirements.txt", "torch==2.6.0\nnumpy>=2\n", 2),
        evidence("CMakeLists.txt", [
          "cmake_minimum_required(VERSION 3.28)",
          "find_package(Qt6 6.7 REQUIRED)",
          "find_package(OpenCASCADE 7.8 REQUIRED)"
        ].join("\n"), 3),
        evidence("README.md", "Requires Python >=3.11 and CUDA >=12.4.", 4)
      ]
    });

    expect(output.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "node", constraint: ">=20", sourcePath: "package.json" }),
      expect.objectContaining({ name: "torch", constraint: "==2.6.0", sourcePath: "requirements.txt" }),
      expect.objectContaining({ name: "CMake", constraint: ">=3.28" }),
      expect.objectContaining({ name: "Qt6", constraint: "6.7" }),
      expect.objectContaining({ name: "OpenCASCADE", constraint: "7.8" }),
      expect.objectContaining({ name: "Python", constraint: ">=3.11" }),
      expect.objectContaining({ name: "CUDA", constraint: ">=12.4" })
    ]));
    expect(output.trust).toBe("untrusted-repository-content");
    expect(isProjectEvidencePath(".env")).toBe(false);
    expect(isProjectEvidencePath("secrets/token.pem")).toBe(false);
  });

  it("builds and validates only the conservative host comparison", () => {
    const project = analyzeProjectRequirementFiles({
      repository,
      files: [
        evidence("package.json", JSON.stringify({ engines: { node: ">=20" } }), 1),
        evidence("requirements.txt", "torch==2.6.0\n", 2)
      ]
    });
    const environment: LocalDevelopmentEnvironmentOutput = {
      host: { platform: "darwin", architecture: "arm64" },
      tools: [{
        id: "node",
        name: "Node.js",
        command: "node",
        status: "available",
        version: "v22.0.0",
        detail: null
      }],
      collectedAt: "2026-08-07T00:00:00.000Z",
      source: "electron-main-fixed-command-allowlist",
      boundary: "read-only-fixed-command-allowlist"
    };
    const assessment = buildProjectCompatibilityAssessment(project, environment);
    expect(assessment.assessment).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "satisfied", localEvidenceToolId: "node" }),
      expect.objectContaining({ status: "unresolved", localEvidenceToolId: null })
    ]));
    expect(validateProjectCompatibilityAssessment(
      assessment,
      project,
      environment
    )).toEqual({ ok: true });
    const altered = structuredClone(assessment);
    altered.assessment[0].status = "missing";
    expect(validateProjectCompatibilityAssessment(
      altered,
      project as ProjectRequirementsOutput,
      environment
    )).toMatchObject({ ok: false, code: "PROJECT_COMPATIBILITY_FACT_MISMATCH" });
  });
});
