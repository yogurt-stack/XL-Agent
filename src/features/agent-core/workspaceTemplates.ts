export type WorkspaceTemplateContext = {
  skillId: string;
  manifestJson: string;
  title: string;
  summary: string;
  nextActions: string[];
};

export interface WorkspaceTemplate {
  id: string;
  supports(skillId: string): boolean;
  renderManifest(context: WorkspaceTemplateContext): string;
  renderReadme(context: WorkspaceTemplateContext): string;
  renderAgents?(context: WorkspaceTemplateContext): string;
}

export class WorkspaceTemplateRegistry {
  private readonly templates = new Map<string, WorkspaceTemplate>();

  constructor(templates: WorkspaceTemplate[] = []) {
    for (const template of templates) this.register(template);
  }

  register(template: WorkspaceTemplate) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(template.id)) {
      throw new Error(`Workspace Template ID 非法：${template.id}`);
    }
    if (this.templates.has(template.id)) {
      throw new Error(`Workspace Template 已注册：${template.id}`);
    }
    this.templates.set(template.id, template);
    return this;
  }

  resolve(skillId: string) {
    return [...this.templates.values()].find((template) =>
      template.supports(skillId)
    ) ?? null;
  }

  list() {
    return [...this.templates.values()];
  }
}

export class AiDevelopmentWorkspaceTemplate implements WorkspaceTemplate {
  readonly id: string = "ai-development-workspace";

  supports(skillId: string): boolean {
    return skillId === "ai-development-environment";
  }

  renderManifest(context: WorkspaceTemplateContext) {
    return context.manifestJson;
  }

  renderReadme(context: WorkspaceTemplateContext) {
    return [
      `# ${context.title}`,
      "",
      context.summary,
      "",
      "## 下一步",
      "",
      ...context.nextActions.map((action) => `- ${action}`),
      ""
    ].join("\n");
  }

  renderAgents(context: WorkspaceTemplateContext) {
    return [
      "# Agent 交接说明",
      "",
      `领域 Skill：\`${context.skillId}\``,
      "",
      "读取 resource-manifest.json 后再判断已准备资源、缺失项和下一步。",
      "禁止把“资源已下载”描述成“软件已安装或部署完成”。",
      ""
    ].join("\n");
  }
}

export class UserProvidedLinksWorkspaceTemplate extends AiDevelopmentWorkspaceTemplate {
  readonly id = "user-provided-links-workspace";

  supports(skillId: string): boolean {
    return skillId === "user-provided-links";
  }
}

export function createDefaultWorkspaceTemplateRegistry() {
  return new WorkspaceTemplateRegistry([
    new AiDevelopmentWorkspaceTemplate(),
    new UserProvidedLinksWorkspaceTemplate()
  ]);
}
