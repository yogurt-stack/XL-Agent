import { describe, expect, it } from "vitest";
import { trustedCatalog, windows11Profile } from "./catalog";
import { validatePlanResourceIds, validatePlannedResources } from "./planValidation";
import { deriveTaskRequirements } from "./taskRequirements";

const pythonRequirements = deriveTaskRequirements({
  task: "准备 Python 机器学习环境",
  answers: { "python-scope": "仅 Python AI" }
});

const validationContext = {
  requirements: pythonRequirements,
  systemProfile: windows11Profile,
  revision: 1
};

describe("strict plan validation", () => {
  it("accepts a complete trusted Python plan", () => {
    const result = validatePlanResourceIds(
      ["python-312", "vscode", "git", "sample-project"],
      validationContext
    );

    expect(result).toMatchObject({ valid: true, issues: [] });
  });

  it("reports unknown and duplicate resource IDs", () => {
    const result = validatePlanResourceIds(
      ["python-312", "vscode", "git", "git", "sample-project", "unknown-package"],
      validationContext
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["UNKNOWN_RESOURCE", "DUPLICATE_RESOURCE"])
    );
  });

  it("rejects resource metadata that differs from the trusted catalog", () => {
    const pythonResource = trustedCatalog.find((resource) => resource.id === "python-312");
    expect(pythonResource).toBeDefined();

    const result = validatePlannedResources(
      [{
        ...pythonResource!,
        source: "Untrusted Override",
        selected: true,
        status: "pending",
        progress: 0,
        attempts: 0
      }],
      {
        ...validationContext,
        requirements: {
          intent: "python-ai",
          label: "元数据验证场景",
          requiredCapabilities: ["python-runtime"]
        }
      }
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("RESOURCE_METADATA_MISMATCH");
  });

  it("rejects trusted download metadata tampering before approval", () => {
    const pythonResource = trustedCatalog.find((resource) => resource.id === "python-312");
    expect(pythonResource).toBeDefined();

    const result = validatePlannedResources(
      [{
        ...pythonResource!,
        download: {
          ...pythonResource!.download,
          url: "https://evil.example/python.exe"
        },
        selected: true,
        status: "pending",
        progress: 0,
        attempts: 0
      }],
      {
        ...validationContext,
        requirements: {
          intent: "python-ai",
          label: "下载元数据验证场景",
          requiredCapabilities: ["python-runtime"]
        }
      }
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("RESOURCE_METADATA_MISMATCH");
  });
});
