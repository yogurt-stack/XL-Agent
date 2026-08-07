import { describe, expect, it } from "vitest";
import {
  AgentDefinitionRegistry,
  createDefaultAgentDefinitionRegistry
} from "./agentRegistry";

describe("AgentDefinitionRegistry", () => {
  it("registers Agent B as a bounded read-only workspace inspector", () => {
    const registry = createDefaultAgentDefinitionRegistry();

    expect(registry.get("workspace-inspector")).toEqual({
      id: "workspace-inspector",
      displayName: "Agent B",
      mode: "read-only",
      allowedTools: ["inspect_workspace"],
      maxSteps: 3
    });
  });

  it("rejects duplicate or over-broad definitions", () => {
    const registry = new AgentDefinitionRegistry();
    registry.register({
      id: "workspace-inspector",
      displayName: "Agent B",
      mode: "read-only",
      allowedTools: ["inspect_workspace"],
      maxSteps: 3
    });

    expect(() =>
      registry.register({
        id: "workspace-inspector",
        displayName: "Duplicate",
        mode: "resource-executor",
        allowedTools: ["controlled_download"],
        maxSteps: 1
      })
    ).toThrow("Agent 已注册");
    expect(() =>
      registry.register({
        id: "invalid agent",
        displayName: "Invalid",
        mode: "read-only",
        allowedTools: ["inspect_workspace"],
        maxSteps: 3
      })
    ).toThrow("Agent ID 非法");
  });

  it("returns defensive copies of registered definitions", () => {
    const registry = createDefaultAgentDefinitionRegistry();
    const definition = registry.get("workspace-inspector");
    expect(definition).not.toBeNull();
    definition!.allowedTools.push("controlled_download");

    expect(
      registry.get("workspace-inspector")?.allowedTools
    ).toEqual(["inspect_workspace"]);
  });
});
