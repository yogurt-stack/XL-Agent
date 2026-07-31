import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Clock3,
  FileCode2,
  FileJson2,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  Github,
  GitFork,
  ExternalLink,
  ListChecks,
  Loader2,
  PackageCheck,
  Play,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  TerminalSquare,
  Wifi,
  WifiOff,
  Wrench,
  XCircle
} from "lucide-react";
import {
  catalogById,
  trustedCatalogMetadata
} from "../features/agent-core/catalog";
import { createResourceManifest } from "../features/agent-core/manifest";
import type { ModelConnectionState } from "../features/agent-core/modelConnection";
import type { PlatformCapabilitySummary } from "../features/agent-core/runtimeBridge";
import type { PersistenceViewState } from "../features/agent-core/useAgentCore";
import {
  estimatedMinutes,
  groupedToolResults,
  overallProgress,
  phaseLabel,
  requiredMissingResources,
  totalDownloadSizeMb
} from "../features/agent-core/selectors";
import type { ToolResultGroup } from "../features/agent-core/selectors";
import { getActiveClarification } from "../features/agent-core/machine";
import {
  isGitHubRepositorySearchOutput,
  latestGitHubRepositorySearchResult
} from "../features/agent-core/githubSearch";
import type { AgentState, AgentUserEvent, ResourceCapability, ResourceStatus } from "../features/agent-core/types";

type Dispatch = (event: AgentUserEvent) => Promise<AgentState>;
type RuntimeMutationResult =
  | { ok: true; snapshot: { state: AgentState } }
  | {
      ok: false;
      error: { code: string; message: string; retriable: boolean };
    };
type Navigate = (
  view:
    | "home"
    | "clarification"
    | "plan"
    | "execution"
    | "workspace"
    | "history"
    | "settings"
) => void;

const statusMeta: Record<ResourceStatus, { label: string; className: string }> = {
  pending: { label: "待确认", className: "status-muted" },
  queued: { label: "等待下载", className: "status-queued" },
  downloading: { label: "下载中", className: "status-active" },
  paused: { label: "已暂停", className: "status-warning" },
  downloaded: { label: "待验证", className: "status-info" },
  verified: { label: "已验证", className: "status-success" },
  failed: { label: "需处理", className: "status-danger" },
  skipped: { label: "已跳过", className: "status-warning" },
  replaced: { label: "已替代", className: "status-queued" }
};

function formatMb(value: number) {
  return `${value.toFixed(1)} MB`;
}

function formatHostProfile(state: AgentState) {
  const profile = state.hostProfile;
  if (!profile) return "尚未读取";
  return `${profile.platformLabel} ${profile.release} · ${profile.architecture}`;
}

const capabilityLabels: Record<ResourceCapability, string> = {
  "python-runtime": "Python 运行时",
  "code-editor": "代码编辑器",
  "source-control": "源码管理",
  "node-runtime": "Node.js 运行时",
  "powershell-runtime": "PowerShell 运行时",
  "project-source": "固定提交源码快照",
  "offline-node-package": "锁文件固定的 npm 离线包",
  "workspace-template": "可验证示例项目"
};

function ResourceStatusBadge({ status }: { status: ResourceStatus }) {
  const meta = statusMeta[status];
  return <span className={`resource-status ${meta.className}`}>{meta.label}</span>;
}

function ToolResultGroupView({ group }: { group: ToolResultGroup }) {
  const [open, setOpen] = useState(group.errorCount > 0);

  useEffect(() => {
    if (group.errorCount > 0) setOpen(true);
  }, [group.errorCount]);

  return (
    <details className="agent-tool-result-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="agent-trace-icon"><Wrench size={14} /></span>
        <span className="agent-tool-result-copy">
          <strong>{group.tool}</strong>
          <small>{group.results.length} 次调用 · {group.successCount} 成功{group.errorCount ? ` · ${group.errorCount} 失败` : ""}{group.cancelledCount ? ` · ${group.cancelledCount} 取消` : ""}</small>
        </span>
        <em className={group.errorCount ? "trace-error" : `trace-${group.latestStatus}`}>{group.errorCount ? "需关注" : group.latestStatus}</em>
      </summary>
      <div className="agent-tool-result-details">
        {group.results.map((result) => <div className="agent-trace-row" key={result.callId}><span className="agent-trace-icon"><Wrench size={14} /></span><div><strong>{result.callId}</strong><small>{result.status === "success" ? "受控工具执行成功" : result.error?.message ?? "工具已取消"}</small></div><em className={`trace-${result.status}`}>{result.status}</em></div>)}
      </div>
    </details>
  );
}

const modelConnectionMeta: Record<
  ModelConnectionState["status"],
  { label: string; className: string }
> = {
  unconfigured: { label: "本地模式", className: "status-muted" },
  configured: { label: "远程已配置", className: "status-info" },
  checking: { label: "检测模型", className: "status-active" },
  remote_available: { label: "远程可用", className: "status-success" },
  fallback_local: { label: "已回退本地", className: "status-warning" },
  connection_failed: { label: "连接失败", className: "status-danger" }
};

export function AgentTopBar({
  state,
  modelConnection
}: {
  state: AgentState;
  modelConnection: ModelConnectionState;
}) {
  const active = state.phase === "routing" || state.phase === "task_planning" || state.phase === "planning" || state.phase === "replanning";
  const connectionMeta = modelConnectionMeta[modelConnection.status];
  const statusClass = state.phase === "handoff"
    ? state.workspace.ready ? "status-success" : "status-warning"
    : active ? "status-active" : "status-info";
  return (
    <header className="topbar">
      <div className="title-block">
        <div className="app-title-row">
          <span className="app-title">迅雷 AI Task Agent</span>
          <span className={`status-pill ${statusClass}`}>
            {active ? <Loader2 className="spin" size={14} /> : <Bot size={14} />}
            {phaseLabel(state.phase)}
          </span>
        </div>
        <span className="app-subtitle">Agent Core r{state.revision} · {state.systemProfile.os} {state.systemProfile.architecture} 目标 · {modelConnection.activeProvider === "remote-llm" ? "远程模型" : "本地规则模型"}</span>
      </div>
      <div className="topbar-meta">
        <span className="meta-chip"><ShieldCheck size={15} />可信目录</span>
        <span className="meta-chip"><TerminalSquare size={15} />{state.systemProfile.shell}</span>
        <span className="meta-chip" title={state.hostProfile ? `主机画像：${formatHostProfile(state)}` : "系统画像将在任务路由前由只读工具采集"}><Server size={15} />{state.hostProfile ? state.hostProfile.platformLabel : "主机画像待读取"}</span>
        <span className={`meta-chip ${connectionMeta.className}`} title={modelConnection.error?.message}>
          {modelConnection.status === "checking" ? <Loader2 className="spin" size={15} /> : modelConnection.activeProvider === "remote-llm" ? <Wifi size={15} /> : <WifiOff size={15} />}
          {connectionMeta.label}
        </span>
        <span className="meta-chip meta-chip-ok"><CircleDot size={15} />状态机已启用</span>
      </div>
    </header>
  );
}

export function AgentHomeView({
  capabilities,
  state,
  dispatch,
  onNavigate,
  onSelectLocalRepository
}: {
  capabilities: PlatformCapabilitySummary;
  state: AgentState;
  dispatch: Dispatch;
  onNavigate: Navigate;
  onSelectLocalRepository?: () => Promise<
    | {
        ok: true;
        snapshot: { state: AgentState };
        imported: boolean;
      }
    | {
        ok: false;
        error: { code: string; message: string; retriable: boolean };
      }
  >;
}) {
  const [importingRepository, setImportingRepository] = useState(false);
  const [repositoryImportError, setRepositoryImportError] = useState<
    string | null
  >(null);
  const recentTasks = [
    "帮我准备一个 Windows 下的 AI 开发环境",
    "为全栈 AI 原型准备 Windows 工具链",
    "准备一个科研数据分析工作区"
  ];
  const downloadCount = state.resources.filter((resource) => resource.status === "downloading").length;
  const taskSubmissionLocked =
    state.phase === "downloading" ||
    state.phase === "verifying" ||
    state.phase === "exporting" ||
    state.githubPublish.status === "publishing";

  return (
    <section className="agent-view agent-home-view">
      <div className="agent-page-heading">
        <div><span>任务入口</span><h1>准备一个可交接的开发工作区</h1></div>
        <p>Agent 会先路由、逐项澄清，再生成可再次确认的可信资源计划。</p>
      </div>
      <form
        className="agent-task-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const task = String(formData.get("task") ?? "");
          const nextState = await dispatch({ type: "SUBMIT_TASK", task });
          if (nextState.phase === "routing" && nextState.task === task.trim()) onNavigate("clarification");
        }}
      >
        <label className="sr-only" htmlFor="agent-task-input">任务描述</label>
        <textarea id="agent-task-input" disabled={taskSubmissionLocked} name="task" defaultValue={state.task || "帮我准备一个 Windows 下的 AI 开发环境"} />
        <button className="btn btn-primary" disabled={taskSubmissionLocked} title={taskSubmissionLocked ? "当前资源执行完成后才能开始新任务" : undefined} type="submit"><Sparkles size={17} />开始任务</button>
      </form>
      <section className="agent-panel agent-local-repository-entry">
        <div className="agent-panel-heading">
          <GitBranch size={17} />
          <h2>本地仓库导入 Agent</h2>
        </div>
        <div>
          <p>
            选择本地 Git 仓库后，Main 只读取 HEAD、分支、工作区状态和项目清单。
            不执行代码、不安装依赖，也不会自动获得 GitHub 写权限。
          </p>
          <button
            className="btn btn-ghost"
            data-testid="import-local-repository"
            disabled={
              taskSubmissionLocked ||
              importingRepository ||
              !onSelectLocalRepository
            }
            type="button"
            onClick={async () => {
              if (!onSelectLocalRepository) return;
              setRepositoryImportError(null);
              setImportingRepository(true);
              try {
                const result = await onSelectLocalRepository();
                if (!result.ok) {
                  setRepositoryImportError(
                    `${result.error.code}: ${result.error.message}`
                  );
                  return;
                }
                if (
                  result.imported &&
                  result.snapshot.state.route === "local-repository-import"
                ) {
                  onNavigate("workspace");
                }
              } finally {
                setImportingRepository(false);
              }
            }}
          >
            {importingRepository ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <FolderOpen size={16} />
            )}
            {importingRepository ? "正在只读检查" : "选择本地 Git 仓库"}
          </button>
        </div>
        {repositoryImportError ? (
          <div className="agent-alert" role="alert">
            <AlertTriangle size={17} />
            {repositoryImportError}
          </div>
        ) : null}
      </section>
      <div className="agent-home-grid">
        <section className="agent-panel">
          <div className="agent-panel-heading"><Clock3 size={17} /><h2>最近任务</h2></div>
          <div className="recent-task-list">
            {recentTasks.map((task) => (
              <button disabled={taskSubmissionLocked} key={task} type="button" onClick={async () => { const nextState = await dispatch({ type: "SUBMIT_TASK", task }); if (nextState.phase === "routing" && nextState.task === task) onNavigate("clarification"); }}>
                <span>{task}</span><ChevronRight size={16} />
              </button>
            ))}
          </div>
        </section>
        <section className="agent-panel">
          <div className="agent-panel-heading"><Route size={17} /><h2>支持的领域 Skill</h2></div>
          <div className="skill-list">
            {capabilities.domainSkills.length
              ? capabilities.domainSkills.map((skill) => (
                  <span key={skill.id}><Bot size={16} />{skill.displayName}</span>
                ))
              : <span><Bot size={16} />等待 Main 进程能力清单</span>}
            <span><GitBranch size={16} />{capabilities.sourceProviders.length} 个 Provider · {capabilities.workspaceTemplates.length} 个模板</span>
          </div>
        </section>
        <section className="agent-panel agent-download-summary">
          <div className="agent-panel-heading"><Gauge size={17} /><h2>当前下载状态</h2></div>
          <strong>{state.resources.length === 0 ? "尚未创建下载任务" : `${overallProgress(state)}%`}</strong>
          <span>{downloadCount > 0 ? `${downloadCount} 项正在模拟传输` : phaseLabel(state.phase)}</span>
        </section>
      </div>
    </section>
  );
}

function formatRepositoryDate(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "short",
        day: "numeric"
      }).format(timestamp);
}

function GitHubRepositoryResults({
  state,
  dispatch,
  onNavigate
}: {
  state: AgentState;
  dispatch: Dispatch;
  onNavigate: Navigate;
}) {
  const [preparingRepository, setPreparingRepository] = useState<string | null>(
    null
  );
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const result = latestGitHubRepositorySearchResult(state);
  const output =
    result?.status === "success" &&
    isGitHubRepositorySearchOutput(result.output)
      ? result.output
      : null;

  if (!output) {
    return (
      <section className="agent-view clarification-view">
        <section className="failure-resolution-panel" role="alert">
          <div className="failure-resolution-heading">
            <span><AlertTriangle size={19} /></span>
            <div>
              <small>GitHub API Tool</small>
              <h2>仓库检索未完成</h2>
            </div>
          </div>
          <p>{result?.error?.message ?? "没有收到可展示的 GitHub API 结果。"}</p>
          <div className="failure-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                void dispatch({ type: "RESET" });
                onNavigate("home");
              }}
            >
              返回任务入口
            </button>
          </div>
        </section>
      </section>
    );
  }

  const criteria = output.criteria;
  let resultHeading: string;
  let resultDescription: string;
  let primaryCriteria: { label: string; value: string };
  let emptySuggestion: string;
  if (criteria.mode === "name") {
    resultHeading = `名称匹配“${criteria.query}”的开源项目`;
    resultDescription =
      `${output.repositories.length} 个结果 · 仓库名精确匹配优先`;
    primaryCriteria = { label: "搜索方式", value: "按仓库名称" };
    emptySuggestion =
      "请检查仓库名称拼写；结果只展示带明确开源许可证的公开仓库。";
  } else if (criteria.mode === "exact") {
    resultHeading = `GitHub 仓库 ${criteria.fullName}`;
    resultDescription =
      `${output.repositories.length} 个结果 · 按 owner/repo 精确定位`;
    primaryCriteria = { label: "目标仓库", value: criteria.fullName };
    emptySuggestion =
      "请检查 owner/repo 是否正确，以及仓库是否公开并带有明确开源许可证。";
  } else {
    const sortLabel = {
      stars: "Star 数",
      updated: "最近更新",
      forks: "Fork 数"
    }[criteria.sort];
    resultHeading = "最近热门的开源项目";
    resultDescription =
      `${output.repositories.length} 个结果 · 按${sortLabel}降序`;
    primaryCriteria = {
      label: "新建于",
      value: `${criteria.createdAfter} 之后`
    };
    emptySuggestion = "可以返回后扩大新建时间窗口或更换排序指标。";
  }

  return (
    <section className="agent-view github-results-view">
      <div className="agent-page-heading">
        <div>
          <span>GitHub API 查询结果</span>
          <h1>{resultHeading}</h1>
        </div>
        <p>{resultDescription}</p>
      </div>
      <section className="github-results-summary" aria-label="查询条件">
        <span>{primaryCriteria.label}<strong>{primaryCriteria.value}</strong></span>
        <span>许可证<strong>明确开源许可</strong></span>
        <span>鉴权<strong>{output.authenticated ? "Token" : "公开访问"}</strong></span>
        <span>剩余额度<strong>{output.rateLimit.remaining ?? "未知"}</strong></span>
      </section>
      {preparationError ? (
        <div className="agent-alert" role="alert">
          <AlertTriangle size={17} />
          {preparationError}
        </div>
      ) : null}
      {output.repositories.length === 0 ? (
        <section className="agent-panel github-empty-result">
          <Github size={24} />
          <strong>当前条件下没有找到带明确许可证的仓库</strong>
          <span>{emptySuggestion}</span>
        </section>
      ) : (
        <ol className="github-repository-list">
          {output.repositories.map((repository, index) => (
            <li className="github-repository-card" key={repository.id}>
              <span className="github-rank" aria-label={`第 ${index + 1} 名`}>
                {index + 1}
              </span>
              <div className="github-repository-content">
                <div className="github-repository-heading">
                  <div>
                    <a
                      href={repository.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <Github size={18} />
                      {repository.fullName}
                      <ExternalLink size={14} />
                    </a>
                    <p>{repository.description ?? "该仓库没有提供描述。"}</p>
                  </div>
                  <span className="github-license">{repository.license.spdxId}</span>
                </div>
                <div className="github-repository-meta">
                  <span><Star size={14} />{repository.stars.toLocaleString()}</span>
                  <span><GitFork size={14} />{repository.forks.toLocaleString()}</span>
                  {repository.language && <span>{repository.language}</span>}
                  <span>更新于 {formatRepositoryDate(repository.updatedAt)}</span>
                </div>
                {repository.topics.length > 0 && (
                  <div className="github-topic-list">
                    {repository.topics.slice(0, 6).map((topic) => (
                      <span key={topic}>{topic}</span>
                    ))}
                  </div>
                )}
                <div className="github-repository-actions">
                  <span>将先固定默认分支 commit，再进入目录选择与下载审批。</span>
                  <button
                    className="btn btn-primary btn-small"
                    disabled={preparingRepository !== null}
                    type="button"
                    onClick={async () => {
                      setPreparationError(null);
                      setPreparingRepository(repository.fullName);
                      try {
                        const nextState = await dispatch({
                          type: "PREPARE_GITHUB_REPOSITORY",
                          fullName: repository.fullName
                        });
                        const prepared = nextState.resources.some(
                          (resource) =>
                            resource.github?.fullName === repository.fullName
                        );
                        if (
                          nextState.phase === "waiting_approval" &&
                          prepared
                        ) {
                          onNavigate("plan");
                        } else {
                          setPreparationError(
                            `未能为 ${repository.fullName} 生成可审批的固定提交计划，请检查操作日志后重试。`
                          );
                        }
                      } catch (error) {
                        setPreparationError(
                          error instanceof Error
                            ? error.message
                            : `读取 ${repository.fullName} 仓库详情失败。`
                        );
                      } finally {
                        setPreparingRepository(null);
                      }
                    }}
                  >
                    {preparingRepository === repository.fullName ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <PackageCheck size={14} />
                    )}
                    {preparingRepository === repository.fullName
                      ? "固定提交中"
                      : "准备到本地"}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <footer className="github-results-footer">
        <span>
          GitHub 共匹配 {output.totalCount.toLocaleString()} 个仓库
          {output.incompleteResults ? "（API 标记结果不完整）" : ""}
          · 获取于 {formatRepositoryDate(output.fetchedAt)}
        </span>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => {
            void dispatch({ type: "RESET" });
            onNavigate("home");
          }}
        >
          开始新任务
        </button>
      </footer>
    </section>
  );
}

function TaskPlanConfirmationCard({
  state,
  dispatch
}: {
  state: AgentState;
  dispatch: Dispatch;
}) {
  const [confirming, setConfirming] = useState(false);
  const plan = state.taskPlan;
  if (!plan) {
    return <WaitingPanel title="正在生成任务计划" copy="Agent 正在拆解目标、依赖关系与权限边界。" />;
  }
  const valid =
    state.taskPlanValidation?.valid === true &&
    state.taskPlanValidation.checkedRevision === plan.revision;
  const riskLabels = {
    read_only: "只读",
    local_write: "本地写入",
    external_write: "外部写入",
    code_execution: "代码执行"
  } as const;
  return (
    <section className="agent-view task-plan-confirmation-view">
      <div className="agent-page-heading">
        <div>
          <span>Task Plan r{plan.revision}</span>
          <h1>先确认 Agent 对任务的理解</h1>
        </div>
        <p>{plan.steps.length} 个步骤 · {plan.createdBy === "remote-llm" ? "远程模型" : "本地模型"}</p>
      </div>
      <section className="task-plan-summary-card">
        <div className="task-plan-objective">
          <BrainCircuit size={19} />
          <div><small>任务目标</small><h2>{plan.objective}</h2></div>
        </div>
        <div className="task-plan-boundary" role="note">
          <ShieldCheck size={17} />
          <span><strong>确认的是处理流程，不是执行权限。</strong>下载、导出与其他写入步骤仍会在执行前单独审批。</span>
        </div>
        <div className="task-plan-columns">
          <div><strong>交付物</strong><ul>{plan.deliverables.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div><strong>约束</strong><ul>{plan.constraints.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </div>
      </section>
      <ol className="task-plan-steps">
        {plan.steps.map((step, index) => (
          <li key={step.id}>
            <span className="task-plan-step-index">{index + 1}</span>
            <div>
              <div className="task-plan-step-heading">
                <strong>{step.title}</strong>
                <span className={`task-plan-risk task-plan-risk-${step.risk}`}>{riskLabels[step.risk]}</span>
                {step.approval.required ? <span className="task-plan-approval">执行前审批</span> : null}
              </div>
              <p>{step.description}</p>
              <small>{step.tool ? `工具：${step.tool}` : `步骤类型：${step.kind}`} · 产出：{step.expectedOutput}</small>
            </div>
          </li>
        ))}
      </ol>
      <section className={`task-plan-validation ${valid ? "task-plan-validation-valid" : "task-plan-validation-invalid"}`} role="status">
        {valid ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <div>
          <strong>{valid ? "结构、依赖与权限策略校验通过" : "任务计划尚不能确认"}</strong>
          {state.taskPlanValidation?.issues.length
            ? <ul>{state.taskPlanValidation.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>
            : <span>首轮确认门已启用；确认后才会进入澄清或调用只读工具。</span>}
        </div>
      </section>
      <div className="task-plan-actions">
        <button
          className="btn btn-primary"
          disabled={!valid || confirming}
          type="button"
          onClick={async () => {
            setConfirming(true);
            const nextState = await dispatch({
              type: "CONFIRM_TASK_PLAN",
              revision: plan.revision
            });
            if (nextState.phase === "waiting_task_plan_confirmation") {
              setConfirming(false);
            }
          }}
        >
          {confirming ? <Loader2 className="spin" size={16} /> : <ClipboardCheck size={16} />}
          {confirming ? "正在确认" : "确认流程并继续"}
        </button>
        <button className="btn btn-ghost" disabled={confirming} type="button" onClick={() => void dispatch({ type: "CANCEL_TASK" })}>
          <XCircle size={16} />取消任务
        </button>
      </div>
    </section>
  );
}

export function ClarificationView({
  state,
  dispatch,
  onNavigate,
  onRetryLocally
}: {
  state: AgentState;
  dispatch: Dispatch;
  onNavigate: Navigate;
  onRetryLocally: () => Promise<AgentState>;
}) {
  const question = getActiveClarification(state);
  if (!question) {
    if (state.phase === "waiting_task_plan_confirmation") {
      return <TaskPlanConfirmationCard dispatch={dispatch} state={state} />;
    }
    if (state.phase === "result") {
      return (
        <GitHubRepositoryResults
          dispatch={dispatch}
          onNavigate={onNavigate}
          state={state}
        />
      );
    }
    if (state.phase === "unsupported") {
      return (
        <section className="agent-view clarification-view">
          <section className="failure-resolution-panel" role="status">
            <div className="failure-resolution-heading">
              <span><Route size={19} /></span>
              <div>
                <small>路由结果：unsupported</small>
                <h2>当前任务不会创建下载计划</h2>
              </div>
            </div>
            <p>{state.routeDecision?.reason ?? "当前任务不属于已安装的资源准备能力。"}</p>
            <div className="failure-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => {
                  void dispatch({ type: "RESET" });
                  onNavigate("home");
                }}
              >
                返回任务入口
              </button>
            </div>
          </section>
        </section>
      );
    }
    if (state.phase === "cancelled") {
      const failureMessage =
        [...state.logs].reverse().find((entry) => entry.level === "error")
          ?.message ?? "模型规划已停止，请选择恢复方式。";
      return (
        <section className="agent-view clarification-view">
          <section className="failure-resolution-panel" role="alert">
            <div className="failure-resolution-heading">
              <span><AlertTriangle size={19} /></span>
              <div>
                <small>模型规划已停止</small>
                <h2>资源计划未能在安全步数内生成</h2>
              </div>
            </div>
            <p>{failureMessage}</p>
            <div className="failure-resolution-meta">
              <span>当前阶段<strong>已停止</strong></span>
              <span>模型步骤<strong>{state.agentRun.step}/{state.agentRun.maxSteps}</strong></span>
              <span>计划 revision<strong>r{state.revision}</strong></span>
            </div>
            <div className="failure-actions">
              <button className="btn btn-primary" type="button" onClick={() => void onRetryLocally()}>
                <RefreshCw size={16} />使用本地模型重新开始
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  dispatch({ type: "RESET" });
                  onNavigate("home");
                }}
              >
                返回首页
              </button>
            </div>
            <small className="failure-resolution-note">
              本地重试仍会重新生成计划并要求你确认，不会自动下载资源。
            </small>
          </section>
        </section>
      );
    }
    if (state.phase === "waiting_approval") {
      return (
        <section className="agent-view">
          <div className="agent-waiting">
            <CheckCircle2 size={25} />
            <strong>澄清完成，资源计划已生成</strong>
            <span>模型已完成可信目录查询，计划仍需用户确认。</span>
            <button className="btn btn-primary" type="button" onClick={() => onNavigate("plan")}>
              <ListChecks size={16} />查看资源计划
            </button>
          </div>
        </section>
      );
    }
    return <WaitingPanel title={state.phase === "task_planning" ? "正在生成任务计划" : state.phase === "planning" ? "正在生成资源计划" : "正在路由任务"} copy={state.phase === "task_planning" ? "Agent 正在拆解目标、步骤依赖与权限边界；确认前不会调用工具。" : "Agent 正在读取系统画像并决定下一项动作。"} />;
  }
  return (
    <section className="agent-view clarification-view">
      <div className="agent-page-heading"><div><span>需求澄清</span><h1>一次确认一个关键问题</h1></div><p>第 {state.clarificationIndex + 1}/{state.clarifications.length} 项</p></div>
      <section className="clarification-card">
        <div className="clarification-reason"><ClipboardCheck size={17} /><span>询问原因：{question.reason}</span></div>
        <h2>{question.prompt}</h2>
        <div className="clarification-options">
          {question.options.map((option) => <button key={option} className="option-button" type="button" onClick={() => dispatch({ type: "ANSWER_CLARIFICATION", questionId: question.id, answer: option })}>{option}<ChevronRight size={16} /></button>)}
        </div>
        {!question.required && <button className="btn btn-ghost" type="button" onClick={() => dispatch({ type: "SKIP_CLARIFICATION", questionId: question.id })}>跳过此非必填问题</button>}
      </section>
    </section>
  );
}

export function ResourcePlanView({
  state,
  dispatch,
  onNavigate,
  onSelectLocalResources,
  onSelectWorkspaceRoot
}: {
  state: AgentState;
  dispatch: Dispatch;
  onNavigate: Navigate;
  onSelectLocalResources?: () => Promise<unknown>;
  onSelectWorkspaceRoot?: () => Promise<unknown>;
}) {
  if (state.phase === "task_planning" || state.phase === "waiting_task_plan_confirmation" || state.phase === "planning" || state.phase === "routing" || state.phase === "clarifying") return <WaitingPanel title="正在生成计划" copy="先确认 Task Plan，再由系统画像和澄清答案生成资源计划。" />;
  if (state.resources.length === 0) return <WaitingPanel title="尚无资源计划" copy="请先在首页提交任务并完成澄清。" />;
  const waitingApproval = state.phase === "waiting_approval";
  const validationCurrent = state.planValidation?.checkedRevision === state.revision;
  const canApprove = waitingApproval && validationCurrent && state.planValidation?.valid === true;
  const npmResources = state.resources.filter((resource) => resource.npm);
  const selectedNpmResources = npmResources.filter(
    (resource) => resource.selected
  );
  const githubAnalysis = state.resources.find(
    (resource) => resource.github
  )?.github?.analysis;
  const dependencyStageActive =
    state.agentB.status === "completed" &&
    state.agentB.answer?.integrity === "valid" &&
    state.agentB.answer.planRevision < state.revision;
  return (
    <section className="agent-view plan-view">
      <div className="agent-page-heading"><div><span>资源计划 r{state.revision}</span><h1>{state.replanReason ? "替代计划等待再次确认" : "可信资源准备计划"}</h1></div><p>总量 {formatMb(totalDownloadSizeMb(state))} · 预计 {estimatedMinutes(state)} 分钟</p></div>
      {state.planExplanation && !state.replanReason && <div className="agent-plan-rationale"><BrainCircuit size={17} /><span><strong>模型建议</strong>{state.planExplanation}</span></div>}
      {state.replanReason && <div className="agent-alert"><AlertTriangle size={17} />{state.replanReason === "download_failed" ? "下载失败后已生成备用来源。" : state.replanReason === "version_mismatch" ? "版本验证不匹配，已生成替代版本。" : "必需资源被取消，已生成替代交付方案。"}</div>}
      <section className={`plan-validation-card ${canApprove ? "plan-validation-valid" : "plan-validation-invalid"}`} role="status" aria-live="polite">
        {canApprove ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}
        <div>
          <strong>{canApprove ? `计划 r${state.revision} 已通过严格验证` : `计划 r${state.revision} 尚不能审批`}</strong>
          <span>
            必需能力：{state.taskRequirements?.requiredCapabilities.length
              ? state.taskRequirements.requiredCapabilities.map((capability) => capabilityLabels[capability]).join("、")
              : "等待任务需求识别"}
          </span>
          {state.planValidation?.issues.length ? (
            <ul>
              {state.planValidation.issues.map((item, index) => (
                <li key={`${item.code}-${item.resourceId ?? item.capability ?? index}`}>{item.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
      {githubAnalysis ? (
        <section className="agent-panel npm-offline-plan">
          <div className="agent-panel-heading">
            <PackageCheck size={17} />
            <h2>Node 离线依赖准备</h2>
          </div>
          {npmResources.length > 0 && dependencyStageActive ? (
            <>
              <p>
                根 package-lock v2/v3 已固定到同一 commit，可准备 {npmResources.length} 个
                registry.npmjs.org tarball。每个包都会复核锁文件 SHA512；不会执行
                npm install、postinstall 或其他脚本。
              </p>
              <div className="npm-offline-actions">
                <span>
                  已纳入审批 {selectedNpmResources.length}/{npmResources.length} 个包
                </span>
                <button
                  className="btn btn-ghost btn-small"
                  disabled={!waitingApproval}
                  type="button"
                  onClick={() =>
                    void dispatch({
                      type: "TOGGLE_NODE_DEPENDENCIES",
                      selected:
                        selectedNpmResources.length !== npmResources.length
                    })
                  }
                >
                  <PackageCheck size={14} />
                  {selectedNpmResources.length === npmResources.length
                    ? "仅准备源码"
                    : "包含全部离线依赖"}
                </button>
              </div>
              <details>
                <summary>查看 {npmResources.length} 个锁定依赖</summary>
                <div className="npm-package-list">
                  {npmResources.map((resource) => (
                    <label key={resource.id}>
                      <input
                        checked={resource.selected}
                        disabled={!waitingApproval}
                        type="checkbox"
                        onChange={(event) =>
                          void dispatch({
                            type: "TOGGLE_RESOURCE",
                            resourceId: resource.id,
                            selected: event.target.checked
                          })
                        }
                      />
                      <span>
                        <strong>{resource.npm?.packageName}</strong>
                        {resource.version} · {resource.license} · {resource.npm?.dependencyKind}
                      </span>
                    </label>
                  ))}
                </div>
              </details>
            </>
          ) : npmResources.length > 0 ? (
            <p>
              已识别 {npmResources.length} 个满足固定 registry 地址、SHA512 和明确许可证要求的 tarball。
              请先完成源码审批、下载与 Agent B 只读检查；依赖将生成独立 revision 并再次请求审批。
            </p>
          ) : (
            <div className="agent-alert">
              <AlertTriangle size={17} />
              <span>
                当前不能生成完整 npm 离线计划。
                {githubAnalysis.nodeOfflineBlockers.join("；") ||
                  (githubAnalysis.nodeOfflinePreparation === "not-node"
                    ? "该仓库不是 Node 项目。"
                    : "未找到受支持且完整的根 package-lock v2/v3。")}
              </span>
            </div>
          )}
        </section>
      ) : null}
      <div className="agent-resource-list">
        {state.resources.filter((resource) => !resource.npm).map((resource) => (
          <article className={`agent-resource-row ${resource.required ? "agent-resource-required" : ""}`} key={resource.id}>
            <label className="resource-selection"><input aria-label={`${resource.selected ? "取消选择" : "选择"} ${resource.name}`} checked={resource.selected} disabled={!waitingApproval} type="checkbox" onChange={(event) => dispatch({ type: "TOGGLE_RESOURCE", resourceId: resource.id, selected: event.target.checked })} /><span /></label>
            <div className="resource-plan-main"><div><h3>{resource.name}</h3><span>{resource.version} {resource.replacedFrom ? `· 替代 ${resource.replacedFrom}` : ""}</span></div><ResourceStatusBadge status={resource.status} /></div>
            <div className="resource-plan-details"><span><strong>来源</strong>{resource.source}</span><span><strong>用途</strong>{resource.purpose}</span><span><strong>大小</strong>{formatMb(resource.sizeMb)}</span><span><strong>授权</strong>{resource.license}</span></div>
            {resource.github ? (
              <div className="github-plan-inspection">
                <span>
                  <strong>固定提交</strong>
                  {resource.github.commitSha}
                </span>
                <span>
                  <strong>项目类型</strong>
                  {resource.github.analysis.ecosystems.join("、")}
                </span>
                <span>
                  <strong>清单文件</strong>
                  {resource.github.analysis.manifests.join("、") || "未识别"}
                </span>
                <span>
                  <strong>锁文件</strong>
                  {resource.github.analysis.lockfiles.join("、") || "未识别"}
                </span>
                <span>
                  <strong>归档校验</strong>
                  下载完成后计算 SHA256 并写入 Manifest
                </span>
              </div>
            ) : null}
            <p>{resource.recommendation}</p>
            <div className="resource-plan-footer"><span>{resource.required ? "必需项" : "可选项"}</span><span>{resource.dependsOn.length ? `依赖：${resource.dependsOn.join("、")}` : "无前置依赖"}</span></div>
          </article>
        ))}
      </div>
      {state.localArtifacts.length ? (
        <section className="agent-panel">
          <div className="agent-panel-heading"><FolderOpen size={17} /><h2>已接入本地资源</h2></div>
          {state.localArtifacts.map((artifact) => (
            <div className="agent-trace-row" key={artifact.artifactId}>
              <span className="agent-trace-icon"><FileCode2 size={14} /></span>
              <div>
                <strong>{artifact.fileName}</strong>
                <small>{artifact.displayPath} · {(artifact.bytesWritten / 1024 / 1024).toFixed(2)} MB</small>
              </div>
              <em className={artifact.matchedResourceId ? "trace-success" : "trace-cancelled"}>
                {artifact.matchedResourceId ? `匹配 ${artifact.matchedResourceId}` : "附加资源"}
              </em>
            </div>
          ))}
        </section>
      ) : null}
      <div className="plan-footer">
        <span title={state.workspace.targetRootPath}>已选择 {state.resources.filter((resource) => resource.selected).length} 项资源 · {state.workspace.targetRootPath ? "自定义目录" : "默认目录"}</span>
        <button className="btn btn-ghost" disabled={!waitingApproval || !onSelectLocalResources} type="button" onClick={() => void onSelectLocalResources?.()}><FolderOpen size={16} />接入本地文件或目录</button>
        <button className="btn btn-ghost" disabled={!waitingApproval || !onSelectWorkspaceRoot} type="button" onClick={() => void onSelectWorkspaceRoot?.()}><FolderOpen size={16} />选择工作区目录</button>
        <button className="btn btn-primary" disabled={!canApprove} title={canApprove ? `批准计划 r${state.revision}` : "请先解决计划验证问题"} type="button" onClick={async () => { const nextState = await dispatch({ type: "APPROVE_PLAN", revision: state.revision }); if ((nextState.phase === "downloading" || nextState.phase === "exporting") && nextState.approvedRevision === state.revision) onNavigate("execution"); }}><ShieldCheck size={16} />确认下载计划 r{state.revision}</button>
      </div>
    </section>
  );
}

export function ExecutionView({ state, dispatch, onNavigate, modelConnection }: { state: AgentState; dispatch: Dispatch; onNavigate: Navigate; modelConnection: ModelConnectionState }) {
  const isWorking = ["downloading", "awaiting_failure_action", "verifying", "exporting", "replanning"].includes(state.phase);
  const failedResource = state.resources.find((resource) => resource.status === "failed");
  const fallbackResource = failedResource?.fallbackId ? catalogById.get(failedResource.fallbackId) : undefined;
  const failedToolResult = [...state.agentRun.toolResults]
    .reverse()
    .find(
      (result) =>
        (result.tool === "simulate_download" || result.tool === "controlled_download") &&
        result.status === "error"
    );
  const toolResultGroups = groupedToolResults(state);
  return (
    <section className="agent-view execution-view">
      <div className="agent-page-heading"><div><span>执行监控</span><h1>Agent 正在{phaseLabel(state.phase)}</h1></div><button className="btn btn-ghost" disabled={!isWorking} type="button" onClick={() => dispatch({ type: "CANCEL_TASK" })}><XCircle size={16} />取消任务</button></div>
      <div className="execution-summary"><div><span>总体进度</span><strong>{overallProgress(state)}%</strong></div><div><span>本轮模型步骤</span><strong>{state.agentRun.step}/{state.agentRun.maxSteps}</strong></div><div><span>模型来源</span><strong>{modelConnection.activeProvider === "remote-llm" ? "远程 LLM" : "本地规则"}</strong></div><div><span>计划修订</span><strong>r{state.revision}</strong></div></div>
      {modelConnection.status === "fallback_local" && modelConnection.error ? <section className="model-fallback-notice" role="status" aria-live="polite"><WifiOff size={17} /><div><strong>远程模型不可用，任务已切换到本地规则模型</strong><span>{modelConnection.error.message}</span></div><button className="btn btn-ghost" type="button" onClick={() => onNavigate("settings")}>查看连接</button></section> : null}
      {state.phase === "awaiting_failure_action" && failedResource ? (
        <section className="failure-resolution-panel" role="alert" aria-live="assertive">
          <div className="failure-resolution-heading"><span><AlertTriangle size={19} /></span><div><small>受控工具执行失败</small><h2>{failedResource.name} 需要人工决策</h2></div></div>
          <p>{failedResource.failureReason ?? "资源下载失败，请选择恢复方式。"}</p>
          <div className="failure-resolution-meta"><span>错误码<strong>{failedToolResult?.error?.code ?? "DOWNLOAD_FAILED"}</strong></span><span>来源<strong>{failedResource.source}</strong></span><span>已尝试<strong>{failedResource.attempts} 次</strong></span></div>
          <div className="failure-actions">
            <button className="btn btn-secondary" type="button" onClick={() => dispatch({ type: "RESOLVE_DOWNLOAD_FAILURE", action: "primary-retry" })}><RefreshCw size={16} />重试原来源</button>
            <button className="btn btn-primary" disabled={!fallbackResource} type="button" title={fallbackResource ? `切换到 ${fallbackResource.source}` : "可信目录中没有可用替代来源"} onClick={() => dispatch({ type: "RESOLVE_DOWNLOAD_FAILURE", action: "trusted-mirror" })}><GitBranch size={16} />使用可信替代来源</button>
            <button className="btn btn-ghost" type="button" onClick={async () => { const nextState = await dispatch({ type: "RESOLVE_DOWNLOAD_FAILURE", action: "delegate-agent-b" }); if (nextState.phase === "handoff" && nextState.agentRun.status === "delegated") onNavigate("workspace"); }}><Bot size={16} />交给 Agent B</button>
          </div>
          <small className="failure-resolution-note">重试或替代来源都会生成新的资源计划，并等待再次确认后执行。</small>
        </section>
      ) : null}
      {state.phase === "replanning" && state.replanReason ? <section className="replan-status-band"><Loader2 className="spin" size={17} /><div><strong>Agent 正在分析失败上下文</strong><span>模型将按用户选择生成新的可信资源计划。</span></div></section> : null}
      {state.phase === "waiting_approval" && state.replanReason ? <section className="replan-status-band replan-ready"><ClipboardCheck size={17} /><div><strong>替代计划 r{state.revision} 已生成</strong><span>该 revision 尚未获得执行权限。</span></div><button className="btn btn-primary" type="button" onClick={() => onNavigate("plan")}><ShieldCheck size={16} />查看并确认</button></section> : null}
      {state.phase === "waiting_approval" && !state.replanReason ? <section className="replan-status-band replan-ready"><ShieldCheck size={17} /><div><strong>当前审批已失效</strong><span>必须重新确认计划 r{state.revision} 后才能继续受控执行。</span></div><button className="btn btn-primary" type="button" onClick={() => onNavigate("plan")}>重新确认</button></section> : null}
      {state.phase === "exporting" ? <section className="replan-status-band"><Loader2 className="spin" size={17} /><div><strong>正在原子生成工作区交接包</strong><span>只有目录完整写入后才会标记为可交接。</span></div></section> : null}
      {state.phase === "awaiting_export_retry" ? <section className="failure-resolution-panel" role="alert"><div className="failure-resolution-heading"><span><AlertTriangle size={19} /></span><div><small>工作区导出失败</small><h2>交接包需要重新写入</h2></div></div><p>{state.workspace.exportError}</p><div className="failure-actions"><button className="btn btn-primary" type="button" onClick={() => dispatch({ type: "RETRY_WORKSPACE_EXPORT" })}><RefreshCw size={16} />重试导出</button><button className="btn btn-ghost" type="button" onClick={() => onNavigate("workspace")}><FileCode2 size={16} />查看状态</button></div></section> : null}
      <div className="execution-grid">
        <section className="agent-panel">
          <div className="agent-panel-heading"><PackageCheck size={17} /><h2>下载任务</h2></div>
          {state.resources.some((resource) => resource.selected) ? state.resources.filter((resource) => resource.selected).map((resource) => (
            <div className="execution-resource" key={resource.id}>
              <div>
                <strong>{resource.name}</strong>
                <ResourceStatusBadge status={resource.status} />
              </div>
              <div aria-label={`${resource.name} 下载进度`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={resource.progress} className="progress-track" role="progressbar">
                <span style={{ width: `${resource.progress}%` }} />
              </div>
              <small>
                {resource.progress}%
                {(resource.status === "downloading" ||
                  resource.status === "paused") &&
                resource.speedBytesPerSecond
                  ? ` · ${(resource.speedBytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
                  : ""}
                {(resource.status === "downloading" ||
                  resource.status === "paused") &&
                resource.etaSeconds !== undefined
                  ? ` · 剩余约 ${resource.etaSeconds}s`
                  : ""}
                {resource.failureReason ? ` · ${resource.failureReason}` : ""}
              </small>
              {state.activeResourceId === resource.id &&
              (resource.status === "downloading" || resource.status === "paused") ? (
                <button
                  className="btn btn-ghost btn-small"
                  type="button"
                  onClick={() =>
                    dispatch({
                      type:
                        resource.status === "paused"
                          ? "RESUME_DOWNLOAD"
                          : "PAUSE_DOWNLOAD",
                      resourceId: resource.id
                    })
                  }
                >
                  {resource.status === "paused" ? <Play size={14} /> : <Clock3 size={14} />}
                  {resource.status === "paused" ? "恢复下载" : "暂停下载"}
                </button>
              ) : null}
            </div>
          )) : <span className="agent-empty-copy">等待模型生成资源计划。</span>}
        </section>
        <section className="agent-panel agent-trace-panel">
          <div className="agent-panel-heading"><BrainCircuit size={17} /><h2>Agent 决策轨迹</h2></div>
          <div className="agent-trace-group">
            <h3>模型决策</h3>
            {state.agentRun.decisions.length ? state.agentRun.decisions.map((decision, index) => <div className="agent-trace-row" key={decision.decisionId}><span className="agent-trace-icon"><Bot size={14} /></span><div><strong>步骤 {index + 1} · {decision.action.type}</strong><small>{decision.explanation}</small></div><em>{decision.provider === "remote-llm" ? "LLM" : "本地"}</em></div>) : <span className="agent-empty-copy">等待模型决策。</span>}
          </div>
          <div className="agent-trace-group">
            <h3>工具结果</h3>
            {toolResultGroups.length ? toolResultGroups.map((group) => <ToolResultGroupView group={group} key={group.tool} />) : <span className="agent-empty-copy">尚未调用工具。</span>}
          </div>
          <div className="agent-trace-group">
            <h3>权限与审批</h3>
            {state.agentRun.policyAudit.length ? state.agentRun.policyAudit.map((entry) => <div className="agent-trace-row" key={entry.actionId}><span className="agent-trace-icon"><ShieldCheck size={14} /></span><div><strong>{entry.decision.risk.toUpperCase()} 风险</strong><small>{entry.decision.reason}</small></div><em className={`trace-${entry.decision.outcome}`}>{entry.decision.outcome}</em></div>) : <span className="agent-empty-copy">尚无策略判定。</span>}
          </div>
        </section>
        <section className="agent-panel agent-log-panel"><div className="agent-panel-heading"><FileText size={17} /><h2>操作日志</h2></div>{state.logs.length ? <div aria-label="操作日志列表" className="agent-log-list" tabIndex={0}>{state.logs.map((log) => <span className={`agent-log-${log.level}`} key={log.id}><small>{log.at}</small>{log.message}</span>)}</div> : <span className="agent-empty-copy">等待 Agent 事件。</span>}</section>
      </div>
    </section>
  );
}

export function SettingsView({
  capabilities,
  modelConnection,
  onResetDemoData,
  onTestConnection,
  persistence,
  state
}: {
  capabilities: PlatformCapabilitySummary;
  modelConnection: ModelConnectionState;
  onResetDemoData: () => Promise<
    | {
        ok: true;
        reset: {
          resetAt: string;
          removedRecords: number;
          cleanupWarning: string | null;
        };
      }
    | {
        ok: false;
        error: { code: string; message: string; retriable: boolean };
      }
  >;
  onTestConnection: () => Promise<ModelConnectionState>;
  persistence: PersistenceViewState;
  state: AgentState;
}) {
  const meta = modelConnectionMeta[modelConnection.status];
  const testing = modelConnection.status === "checking";
  const canTest = modelConnection.configured && !testing;
  const [resetArmed, setResetArmed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const resetBlocked =
    state.phase === "downloading" ||
    state.phase === "verifying" ||
    state.phase === "exporting" ||
    state.agentB.status === "running" ||
    state.githubPublish.status === "publishing";

  const confirmReset = async () => {
    setResetting(true);
    setResetMessage(null);
    const result = await onResetDemoData();
    setResetting(false);
    setResetArmed(false);
    setResetMessage(
      result.ok
        ? result.reset.cleanupWarning
          ? `SQLite 已重置，但文件清理需要人工检查：${result.reset.cleanupWarning}`
          : `Demo 数据已重置，共清除 ${result.reset.removedRecords} 条运行记录。`
        : `${result.error.code}: ${result.error.message}`
    );
  };

  return (
    <section className="agent-view settings-center">
      <div className="settings-header">
        <div><span className="eyebrow"><Server size={15} />模型设置</span><h1>远程模型连接</h1><p>配置保存在 Electron 主进程环境中；renderer 只接收端点主机、模型 ID 和脱敏错误。</p></div>
        <button className="btn btn-primary" disabled={!canTest} type="button" onClick={() => void onTestConnection()}>
          {testing ? <Loader2 className="spin" size={16} /> : <Wifi size={16} />}
          {testing ? "正在测试" : "测试连接"}
        </button>
      </div>
      <div className="settings-grid">
        <section className="settings-section settings-session-section" aria-live="polite">
          <div className="settings-section-heading"><Wifi size={17} /><div><h2>连接状态</h2><span>状态由模型连接控制器维护，不根据 UI 或最后一条日志推断。</span></div></div>
          <div className="model-connection-state-card">
            <span className={`status-pill ${meta.className}`}>{testing ? <Loader2 className="spin" size={14} /> : modelConnection.activeProvider === "remote-llm" ? <Wifi size={14} /> : <WifiOff size={14} />}{meta.label}</span>
            <strong>{modelConnection.activeProvider === "remote-llm" ? "当前任务将优先使用远程 LLM" : "当前任务使用本地规则模型"}</strong>
            <small>{modelConnection.lastCheckedAt ? `最近检测：${new Date(modelConnection.lastCheckedAt).toLocaleString("zh-CN")}` : "尚未执行远程连接测试"}</small>
          </div>
          {modelConnection.error ? <div className="model-connection-error"><AlertTriangle size={16} /><div><strong>{modelConnection.error.code}</strong><span>{modelConnection.error.message}</span></div></div> : null}
        </section>
        <section className="settings-section">
          <div className="settings-section-heading"><ShieldCheck size={17} /><div><h2>安全配置摘要</h2><span>API Key 不会通过 contextBridge 暴露给 renderer。</span></div></div>
          <div className="settings-row"><div><strong>端点主机</strong><span>仅显示 hostname，不展示完整请求路径。</span></div><code>{modelConnection.endpointHost ?? "未配置"}</code></div>
          <div className="settings-row"><div><strong>模型 ID</strong><span>由 XL_AGENT_LLM_MODEL 提供。</span></div><code>{modelConnection.model ?? "未配置"}</code></div>
          <div className="settings-row"><div><strong>Provider</strong><span>只加载 Main 进程注册的模型协议适配器。</span></div><code>{modelConnection.providerId ?? "未配置"}</code></div>
          <div className="settings-row"><div><strong>端点模式</strong><span>Base URL 会在 Main 进程规范化为 Chat Completions 路径。</span></div><code>{modelConnection.endpointMode ?? "未配置"}</code></div>
          <div className="settings-row"><div><strong>配置方式</strong><span>修改项目根目录 .env 后需要重启 Electron 主进程。</span></div><code>主进程环境变量</code></div>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading"><Route size={17} /><div><h2>平台扩展能力</h2><span>清单由 Main 进程注册表生成；Renderer 不自行声明已安装能力。</span></div></div>
          <div className="settings-row"><div><strong>Domain Skills</strong><span>{capabilities.domainSkills.map((skill) => skill.displayName).join("、") || "尚未加载"}</span></div><code>{capabilities.domainSkills.length}</code></div>
          <div className="settings-row"><div><strong>Source Providers</strong><span>{capabilities.sourceProviders.map((provider) => provider.id).join("、") || "尚未加载"}</span></div><code>{capabilities.sourceProviders.length}</code></div>
          <div className="settings-row"><div><strong>Workspace Templates</strong><span>{capabilities.workspaceTemplates.map((template) => template.id).join("、") || "尚未加载"}</span></div><code>{capabilities.workspaceTemplates.length}</code></div>
          <div className="settings-row"><div><strong>GitHub 发布</strong><span>使用独立写 Token；只创建新仓库，不复用只读搜索凭证。</span></div><code>{capabilities.githubPublish?.configured ? "已配置 · create-only" : "未配置"}</code></div>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading"><PackageCheck size={17} /><div><h2>可信目录与制品校验</h2><span>审批固定目录版本；Windows 制品在 SHA256 后继续校验系统 Authenticode 与发布者。</span></div></div>
          <div className="settings-row"><div><strong>目录版本</strong><span>非 active 条目不会进入新计划。</span></div><code>{trustedCatalogMetadata.catalogVersion}</code></div>
          <div className="settings-row"><div><strong>目录来源哈希</strong><span>执行时必须与审批记录逐字一致。</span></div><code>{trustedCatalogMetadata.sourceSha256.slice(0, 16)}…</code></div>
          <div className="settings-row"><div><strong>签名边界</strong><span>不向 Agent 暴露 PowerShell、Shell 或任意命令能力。</span></div><code>fail closed</code></div>
          <div className="settings-row"><div><strong>恢复边界</strong><span>受控临时文件和服务端 Range 验证通过后才能跨重启续传。</span></div><code>HTTP Range</code></div>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading"><TerminalSquare size={17} /><div><h2>系统画像边界</h2><span>只读主机画像用于审计；资源计划仍使用当前 Windows 目标画像。</span></div></div>
          <div className="settings-row"><div><strong>计划目标</strong><span>用于可信目录兼容性校验。</span></div><code>{state.systemProfile.os} {state.systemProfile.architecture}</code></div>
          <div className="settings-row"><div><strong>主机画像</strong><span>由 Electron 主进程采集，renderer 只接收脱敏摘要。</span></div><code>{formatHostProfile(state)}</code></div>
          <div className="settings-row"><div><strong>Shell 摘要</strong><span>只显示 shell 文件名，不显示完整路径。</span></div><code>{state.hostProfile?.defaultShell ?? "pending"}</code></div>
          <div className="settings-row"><div><strong>脱敏策略</strong><span>不采集用户名、主机名、Home 路径、环境变量或完整 shell 路径。</span></div><code>PII blocked</code></div>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading"><ListChecks size={17} /><div><h2>任务恢复与审计</h2><span>Electron 主进程使用 SQLite 保存任务、ToolResult、Policy 和审批记录。</span></div></div>
          <div className="settings-row"><div><strong>持久化状态</strong><span>{persistence.error ?? "任务状态在每次状态转换后保存。"}</span></div><code>{persistence.status}</code></div>
          <div className="settings-row"><div><strong>最近保存</strong><span>保存内容包含恢复上下文和当前 revision。</span></div><code>{persistence.lastSavedAt ? new Date(persistence.lastSavedAt).toLocaleString("zh-CN") : "尚未保存"}</code></div>
          <div className="settings-row"><div><strong>最近恢复</strong><span>只自动恢复未完成任务；已交接或取消任务不会自动恢复。</span></div><code>{persistence.restoredAt ? new Date(persistence.restoredAt).toLocaleString("zh-CN") : "本次未恢复"}</code></div>
          <div className="settings-row"><div><strong>最近 Demo 重置</strong><span>维护审计会保留，但任务、审批、下载和工作区记录会清空。</span></div><code>{persistence.lastResetAt ? `${new Date(persistence.lastResetAt).toLocaleString("zh-CN")} · ${persistence.lastResetRemovedRecords} 条` : "尚未重置"}</code></div>
          {!resetArmed ? (
            <button className="btn btn-ghost" disabled={resetBlocked || resetting} type="button" onClick={() => setResetArmed(true)}>
              <RefreshCw size={16} />重置 Demo 数据
            </button>
          ) : (
            <div className="failure-resolution-panel" role="alert">
              <p>这会永久清除 SQLite 中的任务、审批、下载、Manifest、Agent B 和工作区记录，并删除应用管理的 Demo 文件；不会删除用户自选目录。</p>
              <div className="failure-actions">
                <button className="btn btn-primary" disabled={resetting} type="button" onClick={() => void confirmReset()}>
                  {resetting ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  {resetting ? "正在重置" : "确认永久清除"}
                </button>
                <button className="btn btn-ghost" disabled={resetting} type="button" onClick={() => setResetArmed(false)}>取消</button>
              </div>
            </div>
          )}
          {resetMessage ? <p aria-live="polite" className="agent-empty-copy">{resetMessage}</p> : null}
        </section>
      </div>
    </section>
  );
}

export function WorkspaceView({
  dispatch,
  onApproveGitHubPublish,
  onNavigate,
  onOpenWorkspace,
  onPrepareGitHubPublish,
  onReadFile,
  onSelectWorkspaceRoot,
  state
}: {
  dispatch: Dispatch;
  onApproveGitHubPublish: (input: {
    publishId: string;
    planSha256: string;
  }) => Promise<RuntimeMutationResult>;
  onNavigate: Navigate;
  onOpenWorkspace: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onPrepareGitHubPublish: (input: {
    repositoryName: string;
    visibility: "private" | "public";
    branch?: string;
    commitMessage?: string;
  }) => Promise<RuntimeMutationResult>;
  onReadFile: (relativePath: string) => Promise<
    | { ok: true; content: string }
    | { ok: false; error: { code: string; message: string; retriable: boolean } }
  >;
  onSelectWorkspaceRoot: () => Promise<unknown>;
  state: AgentState;
}) {
  const [previewFile, setPreviewFile] = useState("resource-manifest.json");
  const [publishRequestRunning, setPublishRequestRunning] = useState(false);
  const [publishUiError, setPublishUiError] = useState<string | null>(null);
  const manifest = useMemo(() => JSON.stringify(createResourceManifest(state), null, 2), [state]);
  const missing = requiredMissingResources(state);
  const [preview, setPreview] = useState(manifest);

  useEffect(() => {
    let active = true;
    if (!state.workspace.ready) {
      setPreview(
        previewFile === "resource-manifest.json"
          ? manifest
          : "该文件尚未真实导出；当前仅显示任务交接预览。"
      );
      return () => {
        active = false;
      };
    }
    if (
      previewFile.startsWith("downloads/") ||
      previewFile.startsWith("sources/") ||
      previewFile.startsWith("dependencies/")
    ) {
      setPreview("该条目是已校验下载物。为避免把二进制内容送入 Renderer，请使用“打开本地工作目录”查看。");
      return () => {
        active = false;
      };
    }
    setPreview("正在读取真实工作区文件…");
    void onReadFile(previewFile).then((result) => {
      if (!active) return;
      setPreview(result.ok ? result.content : `${result.error.code}: ${result.error.message}`);
    });
    return () => {
      active = false;
    };
  }, [manifest, onReadFile, previewFile, state.workspace.generatedAt, state.workspace.ready]);

  const selectedFileRecord = state.workspace.fileRecords.find(
    (file) => file.relativePath === previewFile
  );
  const canPrepareNodeDependencies =
    state.phase === "handoff" &&
    state.workspace.ready &&
    state.agentB.status === "completed" &&
    state.agentB.answer?.integrity === "valid" &&
    state.agentB.answer.projectReadiness?.dependencyPreparation ===
      "package-lock-supported" &&
    state.resources.some((resource) => resource.npm) &&
    !state.resources.some((resource) => resource.npm?.repositoryCommitSha &&
      resource.selected && resource.status === "verified");
  return (
    <section className="agent-view workspace-view">
      <div className="agent-page-heading"><div><span>工作区交接</span><h1>{state.workspace.ready ? "交接包已就绪" : state.workspace.exportStatus === "failed" ? "交接包导出失败" : "等待资源准备完成"}</h1></div><div><p>{state.workspace.rootPath ?? state.workspace.targetRootPath ?? state.systemProfile.workspaceRoot}</p><button className="btn btn-ghost btn-small" disabled={state.phase !== "waiting_approval"} title={state.phase === "waiting_approval" ? "选择当前待审批计划的工作区保存目录" : "工作区目录只能在计划审批前修改"} type="button" onClick={() => void onSelectWorkspaceRoot()}><FolderOpen size={14} />选择保存目录</button></div></div>
      {state.agentRun.status === "delegated" ? <section className="agent-b-handoff-notice"><Bot size={19} /><div><strong>已交给 Agent B 处理未完成资源</strong><span>当前 Agent 已保留任务目标、失败原因、资源状态和计划 revision；工作区尚未标记为可用。</span></div></section> : null}
      {state.localRepository ? (
        <section className="agent-panel" data-testid="local-repository-summary">
          <div className="agent-panel-heading">
            <GitBranch size={17} />
            <h2>本地仓库只读摘要</h2>
          </div>
          <div className="handoff-list">
            <span>
              <strong>仓库</strong>
              {state.localRepository.displayName}
            </span>
            <span>
              <strong>固定 HEAD</strong>
              {state.localRepository.commitSha.slice(0, 12)}
            </span>
            <span>
              <strong>分支</strong>
              {state.localRepository.branch ?? "detached HEAD"}
            </span>
            <span>
              <strong>工作区</strong>
              {state.localRepository.clean
                ? "clean"
                : `${state.localRepository.status.modified} 修改 · ${state.localRepository.status.deleted} 删除 · ${state.localRepository.status.untracked} 未跟踪 · ${state.localRepository.status.conflicted} 冲突`}
            </span>
            <span>
              <strong>文件</strong>
              {state.localRepository.trackedFileCount} 个已跟踪 /{" "}
              {state.localRepository.fileCount} 个可见
            </span>
            <span>
              <strong>项目类型</strong>
              {state.localRepository.analysis.ecosystems.join("、")}
            </span>
            <span>
              <strong>权限边界</strong>
              源目录路径不进入 Renderer、SQLite 或 Manifest；本次只读会话不含发布权限
            </span>
          </div>
        </section>
      ) : null}
      {state.localRepository ? (
        <section className="agent-panel github-publish-panel">
          <div className="agent-panel-heading">
            <Github size={17} />
            <h2>审批后发布到 GitHub</h2>
          </div>
          <p className="agent-empty-copy">
            这是独立写权限流程。只创建新仓库，不覆盖已有仓库、不强推；发布前会重新检查
            clean HEAD、文件范围和计划哈希。首版发布 HEAD 内容快照，不复制原 Git 历史。
          </p>
          {state.githubPublish.status === "idle" ||
          state.githubPublish.status === "failed" ? (
            <form
              className="github-publish-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setPublishUiError(null);
                setPublishRequestRunning(true);
                try {
                  const formData = new FormData(event.currentTarget);
                  const result = await onPrepareGitHubPublish({
                    repositoryName: String(
                      formData.get("repositoryName") ?? ""
                    ),
                    visibility:
                      formData.get("visibility") === "public"
                        ? "public"
                        : "private",
                    branch:
                      String(formData.get("branch") ?? "").trim() || undefined,
                    commitMessage:
                      String(formData.get("commitMessage") ?? "").trim() ||
                      undefined
                  });
                  if (!result.ok) {
                    setPublishUiError(
                      `${result.error.code}: ${result.error.message}`
                    );
                  }
                } catch (error) {
                  setPublishUiError(
                    error instanceof Error
                      ? error.message
                      : "GitHub 发布计划创建失败。"
                  );
                } finally {
                  setPublishRequestRunning(false);
                }
              }}
            >
              <label>
                <span>新仓库名称</span>
                <input
                  defaultValue={state.localRepository.displayName
                    .replace(/[^A-Za-z0-9_.-]/gu, "-")
                    .slice(0, 100)}
                  disabled={publishRequestRunning}
                  maxLength={100}
                  name="repositoryName"
                  required
                />
              </label>
              <label>
                <span>可见性</span>
                <select
                  defaultValue="private"
                  disabled={publishRequestRunning}
                  name="visibility"
                >
                  <option value="private">Private（推荐）</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <label>
                <span>目标分支</span>
                <input
                  defaultValue={state.localRepository.branch ?? "main"}
                  disabled={publishRequestRunning}
                  maxLength={100}
                  name="branch"
                />
              </label>
              <label className="github-publish-message">
                <span>提交说明</span>
                <input
                  defaultValue={`Publish ${state.localRepository.displayName}@${state.localRepository.commitSha.slice(0, 12)}`}
                  disabled={publishRequestRunning}
                  maxLength={200}
                  name="commitMessage"
                />
              </label>
              <button
                className="btn btn-ghost"
                disabled={
                  publishRequestRunning || !state.localRepository.clean
                }
                type="submit"
              >
                {publishRequestRunning ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <ListChecks size={16} />
                )}
                {publishRequestRunning ? "正在检查目标" : "生成发布计划"}
              </button>
              {!state.localRepository.clean ? (
                <span className="agent-empty-copy">
                  本地工作区不是 clean 状态，当前不能创建发布计划。
                </span>
              ) : null}
            </form>
          ) : null}
          {state.githubPublish.plan &&
          (state.githubPublish.status === "waiting_approval" ||
            state.githubPublish.status === "publishing") ? (
            <div
              className="failure-resolution-panel"
              data-testid="github-publish-approval"
              role="status"
            >
              <p>
                将创建{" "}
                <strong>
                  {state.githubPublish.plan.targetOwner}/
                  {state.githubPublish.plan.targetRepository}
                </strong>
                （{state.githubPublish.plan.targetVisibility}），发布{" "}
                {state.githubPublish.plan.fileCount} 个文件 /{" "}
                {state.githubPublish.plan.totalBytes.toLocaleString()} B 到{" "}
                {state.githubPublish.plan.targetBranch}。不强推。
              </p>
              <small className="agent-empty-copy">
                计划 SHA256{" "}
                {state.githubPublish.plan.planSha256.slice(0, 16)}… · 审批于{" "}
                {new Date(
                  state.githubPublish.plan.expiresAt
                ).toLocaleTimeString("zh-CN")}{" "}
                前有效
              </small>
              <div className="failure-actions">
                <button
                  className="btn btn-primary"
                  data-testid="approve-github-publish"
                  disabled={
                    publishRequestRunning ||
                    state.githubPublish.status === "publishing"
                  }
                  type="button"
                  onClick={async () => {
                    const plan = state.githubPublish.plan;
                    if (!plan) return;
                    setPublishUiError(null);
                    setPublishRequestRunning(true);
                    try {
                      const result = await onApproveGitHubPublish({
                        publishId: plan.publishId,
                        planSha256: plan.planSha256
                      });
                      if (!result.ok) {
                        setPublishUiError(
                          `${result.error.code}: ${result.error.message}`
                        );
                      }
                    } catch (error) {
                      setPublishUiError(
                        error instanceof Error
                          ? error.message
                          : "GitHub 发布执行失败。"
                      );
                    } finally {
                      setPublishRequestRunning(false);
                    }
                  }}
                >
                  {state.githubPublish.status === "publishing" ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <ShieldCheck size={16} />
                  )}
                  {state.githubPublish.status === "publishing"
                    ? "正在发布"
                    : "批准并创建 GitHub 仓库"}
                </button>
              </div>
            </div>
          ) : null}
          {state.githubPublish.status === "published" &&
          state.githubPublish.result ? (
            <div className="agent-alert agent-alert-success" role="status">
              <CheckCircle2 size={17} />
              已发布{" "}
              <a
                href={state.githubPublish.result.repositoryUrl}
                rel="noreferrer"
                target="_blank"
              >
                {state.githubPublish.result.fullName}
              </a>
              @{state.githubPublish.result.commitSha.slice(0, 12)}
            </div>
          ) : null}
          {state.githubPublish.error ? (
            <div className="agent-alert" role="alert">
              <AlertTriangle size={17} />
              {state.githubPublish.error}
              {state.githubPublish.partialRepositoryUrl ? (
                <a
                  href={state.githubPublish.partialRepositoryUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  查看已创建的未完成仓库
                </a>
              ) : null}
            </div>
          ) : null}
          {publishUiError ? (
            <div className="agent-alert" role="alert">
              <AlertTriangle size={17} />
              {publishUiError}
            </div>
          ) : null}
        </section>
      ) : null}
      {state.agentB.status === "running" ? <section className="replan-status-band" role="status"><Loader2 className="spin" size={17} /><div><strong>Agent B 正在调用 inspect_workspace</strong><span>只读权限仅绑定当前 task 与 plan revision。</span></div></section> : null}
      {state.agentB.answer ? (
        <section className="agent-panel" data-testid="agent-b-answer">
          <div className="agent-panel-heading"><Bot size={17} /><h2>Agent B 检查结果 · Manifest r{state.agentB.answer.manifestRevision}</h2></div>
          <div className="handoff-list">
            <span><strong>完整性</strong>{state.agentB.answer.integrity === "valid" ? "校验通过" : "校验失败"}</span>
            <span><strong>已准备必需资源</strong>{state.agentB.answer.preparedRequiredResources.join("、") || "无"}</span>
            <span><strong>缺失或失败</strong>{state.agentB.answer.missingOrFailedResources.join("、") || "无"}</span>
            <span><strong>允许动作</strong>{state.agentB.answer.allowedActions.join("；")}</span>
            <span><strong>禁止动作</strong>{state.agentB.answer.forbiddenActions.join("；")}</span>
            {state.agentB.answer.projectReadiness ? (
              <>
                <span><strong>固定提交</strong>{state.agentB.answer.projectReadiness.fullName}@{state.agentB.answer.projectReadiness.commitSha.slice(0, 12)}</span>
                <span><strong>来源</strong>{state.agentB.answer.projectReadiness.source === "local" ? "本地 Git 仓库（只读）" : "GitHub 固定提交"}</span>
                <span><strong>分支</strong>{state.agentB.answer.projectReadiness.branch ?? "detached HEAD"}</span>
                <span><strong>项目类型</strong>{state.agentB.answer.projectReadiness.ecosystems.join("、")}</span>
                <span><strong>项目清单</strong>{state.agentB.answer.projectReadiness.manifests.join("、") || "未识别"}</span>
                <span><strong>锁文件</strong>{state.agentB.answer.projectReadiness.lockfiles.join("、") || "未识别"}</span>
                <span><strong>运行时提示</strong>{state.agentB.answer.projectReadiness.runtimeHints.join("；")}</span>
                <span><strong>离线包</strong>{state.agentB.answer.projectReadiness.selectedOfflinePackages}/{state.agentB.answer.projectReadiness.offlinePackageCount} 个已纳入并验证</span>
                {state.agentB.answer.projectReadiness.offlineBlockers.length ? (
                  <span><strong>离线依赖限制</strong>{state.agentB.answer.projectReadiness.offlineBlockers.join("；")}</span>
                ) : null}
                <span>
                  <strong>依赖准备</strong>
                  {state.agentB.answer.projectReadiness.dependencyPreparation === "package-lock-supported"
                    ? "可生成 npm 离线依赖计划"
                    : state.agentB.answer.projectReadiness.dependencyPreparation === "lockfile-unsupported"
                      ? "当前锁文件不受支持"
                      : "不适用 npm 离线依赖"}
                </span>
              </>
            ) : null}
            <span><strong>结论</strong>{state.agentB.answer.summary}</span>
          </div>
        </section>
      ) : null}
      {state.agentB.status === "failed" ? <section className="failure-resolution-panel" role="alert"><p>{state.agentB.error}</p></section> : null}
      {state.workspace.exportStatus === "failed" ? <section className="failure-resolution-panel" role="alert"><p>{state.workspace.exportError}</p><button className="btn btn-primary" type="button" onClick={() => dispatch({ type: "RETRY_WORKSPACE_EXPORT" })}><RefreshCw size={16} />重试导出</button></section> : null}
      <div className="workspace-agent-grid"><section className="agent-panel"><div className="agent-panel-heading"><FileCode2 size={17} /><h2>文件清单</h2></div><div className="workspace-file-buttons">{state.workspace.files.map((file) => { const record = state.workspace.fileRecords.find((item) => item.relativePath === file); return <button className={previewFile === file ? "file-selected" : ""} key={file} type="button" onClick={() => setPreviewFile(file)}>{file === "resource-manifest.json" ? <FileJson2 size={15} /> : <FileText size={15} />}{file}{record ? <small>{record.bytesWritten} B</small> : null}</button>; })}</div></section><section className="agent-panel"><div className="agent-panel-heading"><FileText size={17} /><h2>{previewFile} {state.workspace.ready ? "真实文件" : "预览"}</h2></div>{selectedFileRecord ? <small className="agent-empty-copy">SHA256 {selectedFileRecord.sha256}</small> : null}<pre aria-label={`${previewFile} 内容`} className="workspace-code-preview" tabIndex={0}>{preview}</pre></section><section className="agent-panel"><div className="agent-panel-heading"><Bot size={17} /><h2>Agent 交接面板</h2></div><div className="handoff-list"><span><strong>目标</strong>{state.task || "尚未输入任务"}</span><span><strong>资源状态</strong>{state.workspace.ready ? "已验证并真实落盘" : "仍有资源或导出未完成"}</span><span><strong>缺失项</strong>{missing.length ? missing.map((resource) => resource.name).join("、") : "无"}</span><span><strong>下一步</strong>{state.workspace.nextAction}</span></div><div className="failure-actions"><button className="btn btn-ghost" disabled={!state.workspace.ready} type="button" onClick={() => void onOpenWorkspace()}><FolderOpen size={16} />打开本地工作目录</button><button className="btn btn-ghost" data-testid="run-agent-b" disabled={state.workspace.manifestRevision <= 0 || state.agentB.status === "running"} title="只授予当前 task、plan revision 与 inspect_workspace 权限" type="button" onClick={() => void dispatch({ type: "RUN_AGENT_B" })}><Bot size={16} />{state.agentB.status === "running" ? "检查中" : "运行 Agent B"}</button>{canPrepareNodeDependencies ? <button className="btn btn-primary" type="button" onClick={async () => { const nextState = await dispatch({ type: "PREPARE_NODE_DEPENDENCIES" }); if (nextState.phase === "waiting_approval") onNavigate("plan"); }}><PackageCheck size={16} />准备 npm 离线依赖</button> : null}</div></section></div>
    </section>
  );
}

function WaitingPanel({ title, copy }: { title: string; copy: string }) {
  return <section className="agent-view"><div className="agent-waiting"><Loader2 className="spin" size={25} /><strong>{title}</strong><span>{copy}</span></div></section>;
}
