import { githubSearchInputFromState } from "./githubSearch";
import type {
  AgentToolName,
  ModelContext,
  TaskPlanProposal,
  TaskPlanStepProposal
} from "./types";

function readStep(
  id: string,
  title: string,
  description: string,
  tool: AgentToolName,
  dependsOn: string[],
  staticInput: Record<string, unknown>,
  expectedOutput: string
): TaskPlanStepProposal {
  return {
    id,
    title,
    description,
    kind: "read_tool",
    tool,
    dependsOn,
    staticInput,
    inputBindings: {},
    expectedOutput,
    risk: "read_only",
    approval: { required: false, reason: null }
  };
}

function passiveStep(
  id: string,
  title: string,
  description: string,
  kind: Extract<TaskPlanStepProposal["kind"], "user_decision" | "resource_plan" | "verification" | "handoff">,
  dependsOn: string[],
  expectedOutput: string,
  staticInput: Record<string, unknown> = {}
): TaskPlanStepProposal {
  return {
    id,
    title,
    description,
    kind,
    tool: null,
    dependsOn,
    staticInput,
    inputBindings: {},
    expectedOutput,
    risk: "read_only",
    approval: { required: false, reason: null }
  };
}

function writeStep(
  id: string,
  title: string,
  description: string,
  tool: Extract<AgentToolName, "controlled_download" | "export_workspace">,
  dependsOn: string[],
  expectedOutput: string,
  reason: string
): TaskPlanStepProposal {
  return {
    id,
    title,
    description,
    kind: "write_tool",
    tool,
    dependsOn,
    staticInput: {},
    inputBindings: {},
    expectedOutput,
    risk: "local_write",
    approval: { required: true, reason }
  };
}

function wantsLocalAcquisition(task: string) {
  return /(下载|保存到|准备到|本地|导入|获取源码|克隆|clone|download)/iu.test(task);
}

function createGitHubTaskPlan(context: ModelContext): TaskPlanProposal {
  const { state } = context;
  const input = githubSearchInputFromState(state);
  const acquisition = wantsLocalAcquisition(state.task);
  const canDownload = context.availableTools.includes("controlled_download");
  const steps: TaskPlanStepProposal[] = [];
  let previousStepId: string | null = null;
  state.routeDecision?.clarifications.forEach((question, index) => {
    const stepId = `clarify-github-${index + 1}`;
    steps.push(
      passiveStep(
        stepId,
        question.prompt,
        question.reason,
        "user_decision",
        previousStepId ? [previousStepId] : [],
        `已确认的用户选择：${question.options.join(" / ")}`,
        { questionId: question.id, required: question.required }
      )
    );
    previousStepId = stepId;
  });
  steps.push(
    readStep(
      "search-github",
      "按用户意图查询 GitHub",
      "使用 GitHub API 执行一次受控只读查询，并保留搜索条件与额度信息。",
      "search_github_repositories",
      previousStepId ? [previousStepId] : [],
      input,
      "带许可证、Star、更新时间和来源链接的仓库结果"
    )
  );

  if (acquisition && canDownload) {
    steps.push(
      passiveStep(
        "select-repository",
        "确认目标仓库",
        "让用户从候选结果中选择唯一仓库，避免 Agent 猜测目标。",
        "user_decision",
        ["search-github"],
        "唯一的 owner/repo 选择",
        { interaction: "repository_selection" }
      ),
      passiveStep(
        "pin-repository",
        "固定不可变版本",
        "读取仓库详情并固定 commit SHA 或 Release，生成新的资源计划 revision。",
        "resource_plan",
        ["select-repository"],
        "含来源、许可证、固定提交与校验策略的资源计划"
      ),
      writeStep(
        "download-repository",
        "受控下载到本地",
        "仅在资源计划另行审批后，由 Main 下载固定版本的仓库归档。",
        "controlled_download",
        ["pin-repository"],
        "写入受控目录的仓库归档",
        "该步骤会从固定来源下载文件并写入用户选择的本地目录。"
      ),
      passiveStep(
        "verify-repository",
        "验证来源与完整性",
        "复核 SHA256、来源、许可证和固定提交信息。",
        "verification",
        ["download-repository"],
        "可审计的仓库验证结论"
      ),
      writeStep(
        "export-repository-workspace",
        "导出工作区",
        "在验证通过且获得独立审批后，原子写入工作区与 Manifest。",
        "export_workspace",
        ["verify-repository"],
        "包含 Manifest 的本地工作区",
        "该步骤会在用户指定位置创建或更新工作区文件。"
      ),
      passiveStep(
        "handoff-repository",
        "交接检查结果",
        "展示本地路径和验证摘要，并允许 Agent B 只读检查 Manifest。",
        "handoff",
        ["export-repository-workspace"],
        "可供用户或 Agent B 检查的交接结果"
      )
    );
  } else if (acquisition) {
    steps.push(
      passiveStep(
        "select-repository",
        "确认目标仓库",
        "让用户从候选结果中选择唯一仓库，避免 Agent 猜测目标。",
        "user_decision",
        ["search-github"],
        "唯一的 owner/repo 选择",
        { interaction: "repository_selection" }
      ),
      passiveStep(
        "pin-repository",
        "固定不可变版本",
        "读取仓库详情并固定 commit SHA 或 Release，生成新的资源计划 revision。",
        "resource_plan",
        ["select-repository"],
        "含来源、许可证、固定提交与校验策略的资源计划"
      ),
      passiveStep(
        "handoff-repository-plan",
        "交接待下载计划",
        "当前 Runtime 未注册真实下载工具，因此只交接固定版本的资源计划，不伪装成本地下载。",
        "handoff",
        ["pin-repository"],
        "等待具备受控下载能力的宿主继续执行的资源计划"
      )
    );
  } else {
    steps.push(
      passiveStep(
        "present-github-results",
        "展示匹配结果",
        "按用户要求展示仓库候选与排序依据，不自动选择或下载。",
        "handoff",
        ["search-github"],
        "可继续选择并准备到本地的 GitHub 仓库列表"
      )
    );
  }

  return {
    objective: state.task,
    deliverables: acquisition && canDownload
      ? ["符合查询条件的仓库候选", "固定版本并通过验证的本地工作区"]
      : acquisition
        ? ["符合查询条件的仓库候选", "固定版本、等待受控下载的资源计划"]
      : ["符合查询条件且带明确开源许可证的 GitHub 仓库结果"],
    assumptions: [
      input.mode === "name"
        ? "用户给出的是仓库名称，不把它改写成热门榜查询。"
        : input.mode === "exact"
          ? "用户给出了明确的 owner/repo，不扩展为模糊搜索。"
          : "近期热门榜按用户指定或路由解析出的时间窗口与排序执行。"
    ],
    constraints: [
      "GitHub 查询阶段只读且最多执行一次。",
      "任何本地写入都需要独立的资源计划审批。",
      "不会执行仓库代码、安装依赖或运行脚本。"
    ],
    steps,
    confirmation: {
      required: true,
      reason: "先确认 Agent 对目标、查询方式和后续写入边界的理解，再开始调用工具。"
    }
  };
}

function createResourceTaskPlan(context: ModelContext): TaskPlanProposal {
  const { state } = context;
  const steps: TaskPlanStepProposal[] = [];
  let previousId: string | null = null;

  state.routeDecision?.clarifications.forEach((question, index) => {
    const id = `clarify-${index + 1}`;
    steps.push(
      passiveStep(
        id,
        question.prompt,
        question.reason,
        "user_decision",
        previousId ? [previousId] : [],
        `已确认的用户选择：${question.options.join(" / ")}`,
        { questionId: question.id, required: question.required }
      )
    );
    previousId = id;
  });

  steps.push(
    readStep(
      "read-system-profile",
      "读取安全裁剪的系统画像",
      "读取宿主与固定 Windows 11 x64 目标画像，用于兼容性验证。",
      "read_system_profile",
      previousId ? [previousId] : [],
      {},
      "不含敏感路径和凭据的系统画像"
    ),
    readStep(
      "search-trusted-catalog",
      "查询可信资源目录",
      "按确认后的任务需求查询已注册 Provider，不接受模型编造的下载地址。",
      "search_trusted_catalog",
      ["read-system-profile"],
      { query: state.task },
      "带来源、许可证、版本和校验策略的候选资源"
    ),
    passiveStep(
      "create-resource-plan",
      "生成资源计划 revision",
      "匹配必需能力、依赖关系和目标系统，生成可严格验证的资源组合。",
      "resource_plan",
      ["search-trusted-catalog"],
      "等待用户独立审批的资源计划"
    )
  );

  const downloadTool = context.availableTools.includes("controlled_download")
    ? "controlled_download" as const
    : context.availableTools.includes("simulate_download")
      ? "simulate_download" as const
      : null;
  if (downloadTool) {
    const downloadStepId = downloadTool === "controlled_download"
      ? "download-approved-resources"
      : "simulate-approved-downloads";
    steps.push(
      downloadTool === "controlled_download"
        ? writeStep(
            downloadStepId,
            "下载已审批资源",
            "只下载当前审批 revision 中被选中的资源。",
            downloadTool,
            ["create-resource-plan"],
            "写入受控临时目录的资源文件",
            "下载会访问可信来源并向本地临时目录写入文件。"
          )
        : {
            id: "simulate-approved-downloads",
            title: "模拟已审批资源下载",
            description: "在测试 Runtime 中按资源计划执行无本地写入的模拟传输。",
            kind: "verification",
            tool: downloadTool,
            dependsOn: ["create-resource-plan"],
            staticInput: {},
            inputBindings: {},
            expectedOutput: "每项资源的模拟传输结果",
            risk: "read_only",
            approval: { required: false, reason: null }
          },
      passiveStep(
        "verify-resources",
        "验证下载结果",
        "校验摘要、来源、许可证、签名策略和资源元数据。",
        "verification",
        [downloadStepId],
        "每项资源的可审计验证记录"
      ),
      writeStep(
        "export-workspace",
        "导出工作区与 Manifest",
        "仅在全部选中资源验证通过后原子导出工作区。",
        "export_workspace",
        ["verify-resources"],
        "包含 Manifest 和验证脚本的本地工作区",
        "该步骤会在用户选择的保存目录中创建工作区文件。"
      ),
      passiveStep(
        "handoff-workspace",
        "交接工作区",
        "展示落盘路径、资源状态和下一步，并允许 Agent B 只读检查。",
        "handoff",
        ["export-workspace"],
        "可供用户继续使用的工作区交接结果"
      )
    );
  } else {
    steps.push(
      passiveStep(
        "handoff-resource-plan",
        "交接资源计划",
        "展示已验证的资源计划，不执行本地写入。",
        "handoff",
        ["create-resource-plan"],
        "可审阅的资源计划"
      )
    );
  }

  return {
    objective: state.task,
    deliverables: ["经严格验证的资源计划", "经校验的本地工作区与资源 Manifest"],
    assumptions: state.routeDecision?.requirements
      ? [`按 ${state.routeDecision.requirements.label} 的能力要求规划。`]
      : ["若关键需求不足，将在计划确认后逐项向用户澄清。"],
    constraints: [
      "工具只能使用已注册能力与可信来源。",
      "Task Plan 确认不等于资源下载审批。",
      "不会执行下载资源或仓库中的代码。"
    ],
    steps,
    confirmation: {
      required: true,
      reason: "先让用户确认任务拆解与权限边界，再进入澄清和资源规划。"
    }
  };
}

/** 为本地规则模型生成与路由语义一致、可严格校验的首轮任务计划。 */
export function createLocalTaskPlanProposal(
  context: ModelContext
): TaskPlanProposal {
  return context.state.routeDecision?.skillId === "github-project-discovery"
    ? createGitHubTaskPlan(context)
    : createResourceTaskPlan(context);
}
