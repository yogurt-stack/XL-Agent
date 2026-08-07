export type AgentToolPermission =
  | "inspect_workspace"
  | "controlled_download"
  | "export_workspace";

export type AgentDefinition = {
  id: string;
  displayName: string;
  mode: "read-only" | "resource-executor";
  allowedTools: AgentToolPermission[];
  maxSteps: number;
};

export class AgentDefinitionRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  constructor(definitions: AgentDefinition[] = []) {
    definitions.forEach((definition) => this.register(definition));
  }

  register(definition: AgentDefinition) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(definition.id)) {
      throw new Error(`Agent ID 非法：${definition.id}`);
    }
    if (this.agents.has(definition.id)) {
      throw new Error(`Agent 已注册：${definition.id}`);
    }
    if (
      !Number.isSafeInteger(definition.maxSteps) ||
      definition.maxSteps < 1 ||
      definition.maxSteps > 20
    ) {
      throw new Error(`Agent ${definition.id} 的 maxSteps 非法。`);
    }
    this.agents.set(definition.id, structuredClone(definition));
    return this;
  }

  get(agentId: string) {
    const definition = this.agents.get(agentId);
    return definition ? structuredClone(definition) : null;
  }

  list() {
    return [...this.agents.values()].map((definition) =>
      structuredClone(definition)
    );
  }
}

export function createDefaultAgentDefinitionRegistry() {
  return new AgentDefinitionRegistry([
    {
      id: "workspace-inspector",
      displayName: "Agent B",
      mode: "read-only",
      allowedTools: ["inspect_workspace"],
      maxSteps: 3
    }
  ]);
}
