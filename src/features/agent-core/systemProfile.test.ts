import { describe, expect, it } from "vitest";
import {
  createFallbackHostProfile,
  createSystemProfileToolOutput,
  isHostSystemProfile,
  isSystemProfileToolOutput
} from "./systemProfile";

describe("system profile contract", () => {
  it("creates a sanitized fallback host profile for browser previews", () => {
    const profile = createFallbackHostProfile("test-static");

    expect(profile).toMatchObject({
      platform: "unknown",
      architecture: "other",
      collectedBy: "renderer-fallback",
      collectedAt: "test-static",
      privacy: {
        hostname: false,
        username: false,
        homeDirectory: false,
        environment: false,
        shellPath: false
      }
    });
    expect(isHostSystemProfile(profile)).toBe(true);
  });

  it("rejects host profiles without the explicit privacy contract", () => {
    expect(isHostSystemProfile({ ...createFallbackHostProfile(), privacy: { hostname: true } })).toBe(false);
  });

  it("wraps host telemetry without changing the locked planning target", () => {
    const output = createSystemProfileToolOutput(createFallbackHostProfile("test-static"));

    expect(isSystemProfileToolOutput(output)).toBe(true);
    expect(output).toMatchObject({
      targetProfile: {
        os: "Windows 11",
        architecture: "x64",
        shell: "PowerShell 7"
      },
      planningProfileSource: "locked-demo-target"
    });
  });
});
