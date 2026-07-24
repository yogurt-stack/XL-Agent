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
  ListChecks,
  Loader2,
  PackageCheck,
  Play,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wifi,
  WifiOff,
  Wrench,
  XCircle
} from "lucide-react";
import { catalogById } from "../features/agent-core/catalog";
import { createResourceManifest } from "../features/agent-core/manifest";
import type { ModelConnectionState } from "../features/agent-core/modelConnection";
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
import type { AgentEvent, AgentState, ResourceCapability, ResourceStatus } from "../features/agent-core/types";

type Dispatch = (event: AgentEvent) => AgentState;
type Navigate = (view: "home" | "clarification" | "plan" | "execution" | "workspace" | "settings") => void;

const statusMeta: Record<ResourceStatus, { label: string; className: string }> = {
  pending: { label: "待确认", className: "status-muted" },
  queued: { label: "等待下载", className: "status-queued" },
  downloading: { label: "下载中", className: "status-active" },
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
  const active = state.phase === "routing" || state.phase === "planning" || state.phase === "replanning";
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

export function AgentHomeView({ state, dispatch, onNavigate }: { state: AgentState; dispatch: Dispatch; onNavigate: Navigate }) {
  const recentTasks = [
    "帮我准备一个 Windows 下的 AI 开发环境",
    "为全栈 AI 原型准备 Windows 工具链",
    "准备可交接的 Python AI 示例项目"
  ];
  const downloadCount = state.resources.filter((resource) => resource.status === "downloading").length;
  const taskSubmissionLocked =
    state.phase === "downloading" ||
    state.phase === "verifying" ||
    state.phase === "exporting";

  return (
    <section className="agent-view agent-home-view">
      <div className="agent-page-heading">
        <div><span>任务入口</span><h1>准备一个可交接的开发工作区</h1></div>
        <p>Agent 会先路由、逐项澄清，再生成可再次确认的可信资源计划。</p>
      </div>
      <form
        className="agent-task-form"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const task = String(formData.get("task") ?? "");
          const nextState = dispatch({ type: "SUBMIT_TASK", task });
          if (nextState.phase === "routing" && nextState.task === task.trim()) onNavigate("clarification");
        }}
      >
        <label className="sr-only" htmlFor="agent-task-input">任务描述</label>
        <textarea id="agent-task-input" disabled={taskSubmissionLocked} name="task" defaultValue={state.task || "帮我准备一个 Windows 下的 AI 开发环境"} />
        <button className="btn btn-primary" disabled={taskSubmissionLocked} title={taskSubmissionLocked ? "当前资源执行完成后才能开始新任务" : undefined} type="submit"><Sparkles size={17} />开始任务</button>
      </form>
      <div className="agent-home-grid">
        <section className="agent-panel">
          <div className="agent-panel-heading"><Clock3 size={17} /><h2>最近任务</h2></div>
          <div className="recent-task-list">
            {recentTasks.map((task) => (
              <button disabled={taskSubmissionLocked} key={task} type="button" onClick={() => { const nextState = dispatch({ type: "SUBMIT_TASK", task }); if (nextState.phase === "routing" && nextState.task === task) onNavigate("clarification"); }}>
                <span>{task}</span><ChevronRight size={16} />
              </button>
            ))}
          </div>
        </section>
        <section className="agent-panel">
          <div className="agent-panel-heading"><Route size={17} /><h2>支持的领域 Skill</h2></div>
          <div className="skill-list"><span><Bot size={16} />Windows AI 开发环境</span><span><GitBranch size={16} />可信资源准备</span><span><PackageCheck size={16} />工作区交接</span></div>
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

export function ClarificationView({ state, dispatch, onNavigate }: { state: AgentState; dispatch: Dispatch; onNavigate: Navigate }) {
  const question = getActiveClarification(state);
  if (!question) {
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
    return <WaitingPanel title={state.phase === "planning" ? "正在生成资源计划" : "正在路由任务"} copy="Agent 正在读取系统画像并决定下一项动作。" />;
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

export function ResourcePlanView({ state, dispatch, onNavigate }: { state: AgentState; dispatch: Dispatch; onNavigate: Navigate }) {
  if (state.phase === "planning" || state.phase === "routing" || state.phase === "clarifying") return <WaitingPanel title="正在生成计划" copy="资源计划将由已确认的系统画像和澄清答案生成。" />;
  if (state.resources.length === 0) return <WaitingPanel title="尚无资源计划" copy="请先在首页提交任务并完成澄清。" />;
  const waitingApproval = state.phase === "waiting_approval";
  const validationCurrent = state.planValidation?.checkedRevision === state.revision;
  const canApprove = waitingApproval && validationCurrent && state.planValidation?.valid === true;
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
      <div className="agent-resource-list">
        {state.resources.map((resource) => (
          <article className={`agent-resource-row ${resource.required ? "agent-resource-required" : ""}`} key={resource.id}>
            <label className="resource-selection"><input aria-label={`${resource.selected ? "取消选择" : "选择"} ${resource.name}`} checked={resource.selected} disabled={!waitingApproval} type="checkbox" onChange={(event) => dispatch({ type: "TOGGLE_RESOURCE", resourceId: resource.id, selected: event.target.checked })} /><span /></label>
            <div className="resource-plan-main"><div><h3>{resource.name}</h3><span>{resource.version} {resource.replacedFrom ? `· 替代 ${resource.replacedFrom}` : ""}</span></div><ResourceStatusBadge status={resource.status} /></div>
            <div className="resource-plan-details"><span><strong>来源</strong>{resource.source}</span><span><strong>用途</strong>{resource.purpose}</span><span><strong>大小</strong>{formatMb(resource.sizeMb)}</span><span><strong>授权</strong>{resource.license}</span></div>
            <p>{resource.recommendation}</p>
            <div className="resource-plan-footer"><span>{resource.required ? "必需项" : "可选项"}</span><span>{resource.dependsOn.length ? `依赖：${resource.dependsOn.join("、")}` : "无前置依赖"}</span></div>
          </article>
        ))}
      </div>
      <div className="plan-footer"><span>已选择 {state.resources.filter((resource) => resource.selected).length} 项资源</span><button className="btn btn-primary" disabled={!canApprove} title={canApprove ? `批准计划 r${state.revision}` : "请先解决计划验证问题"} type="button" onClick={() => { const nextState = dispatch({ type: "APPROVE_PLAN", revision: state.revision }); if (nextState.phase === "downloading" && nextState.approvedRevision === state.revision) onNavigate("execution"); }}><ShieldCheck size={16} />确认下载计划 r{state.revision}</button></div>
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
            <button className="btn btn-ghost" type="button" onClick={() => { const nextState = dispatch({ type: "RESOLVE_DOWNLOAD_FAILURE", action: "delegate-agent-b" }); if (nextState.phase === "handoff" && nextState.agentRun.status === "delegated") onNavigate("workspace"); }}><Bot size={16} />交给 Agent B</button>
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
          {state.resources.length ? state.resources.map((resource) => <div className="execution-resource" key={resource.id}><div><strong>{resource.name}</strong><ResourceStatusBadge status={resource.status} /></div><div aria-label={`${resource.name} 下载进度`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={resource.progress} className="progress-track" role="progressbar"><span style={{ width: `${resource.progress}%` }} /></div><small>{resource.progress}% {resource.failureReason ? `· ${resource.failureReason}` : ""}</small></div>) : <span className="agent-empty-copy">等待模型生成资源计划。</span>}
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
  modelConnection,
  onTestConnection,
  persistence,
  state
}: {
  modelConnection: ModelConnectionState;
  onTestConnection: () => Promise<ModelConnectionState>;
  persistence: PersistenceViewState;
  state: AgentState;
}) {
  const meta = modelConnectionMeta[modelConnection.status];
  const testing = modelConnection.status === "checking";
  const canTest = modelConnection.configured && !testing;

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
          <div className="settings-row"><div><strong>配置方式</strong><span>修改项目根目录 .env 后需要重启 Electron 主进程。</span></div><code>主进程环境变量</code></div>
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
        </section>
      </div>
    </section>
  );
}

export function WorkspaceView({
  dispatch,
  onOpenWorkspace,
  onReadFile,
  state
}: {
  dispatch: Dispatch;
  onOpenWorkspace: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onReadFile: (relativePath: string) => Promise<
    | { ok: true; content: string }
    | { ok: false; error: { code: string; message: string; retriable: boolean } }
  >;
  state: AgentState;
}) {
  const [previewFile, setPreviewFile] = useState("resource-manifest.json");
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
  return (
    <section className="agent-view workspace-view">
      <div className="agent-page-heading"><div><span>工作区交接</span><h1>{state.workspace.ready ? "交接包已就绪" : state.workspace.exportStatus === "failed" ? "交接包导出失败" : "等待资源准备完成"}</h1></div><p>{state.workspace.rootPath ?? state.systemProfile.workspaceRoot}</p></div>
      {state.agentRun.status === "delegated" ? <section className="agent-b-handoff-notice"><Bot size={19} /><div><strong>已交给 Agent B 处理未完成资源</strong><span>当前 Agent 已保留任务目标、失败原因、资源状态和计划 revision；工作区尚未标记为可用。</span></div></section> : null}
      {state.workspace.exportStatus === "failed" ? <section className="failure-resolution-panel" role="alert"><p>{state.workspace.exportError}</p><button className="btn btn-primary" type="button" onClick={() => dispatch({ type: "RETRY_WORKSPACE_EXPORT" })}><RefreshCw size={16} />重试导出</button></section> : null}
      <div className="workspace-agent-grid"><section className="agent-panel"><div className="agent-panel-heading"><FileCode2 size={17} /><h2>文件清单</h2></div><div className="workspace-file-buttons">{state.workspace.files.map((file) => { const record = state.workspace.fileRecords.find((item) => item.relativePath === file); return <button className={previewFile === file ? "file-selected" : ""} key={file} type="button" onClick={() => setPreviewFile(file)}>{file === "resource-manifest.json" ? <FileJson2 size={15} /> : <FileText size={15} />}{file}{record ? <small>{record.bytesWritten} B</small> : null}</button>; })}</div></section><section className="agent-panel"><div className="agent-panel-heading"><FileText size={17} /><h2>{previewFile} {state.workspace.ready ? "真实文件" : "预览"}</h2></div>{selectedFileRecord ? <small className="agent-empty-copy">SHA256 {selectedFileRecord.sha256}</small> : null}<pre className="workspace-code-preview">{preview}</pre></section><section className="agent-panel"><div className="agent-panel-heading"><Bot size={17} /><h2>Agent 交接面板</h2></div><div className="handoff-list"><span><strong>目标</strong>{state.task || "尚未输入任务"}</span><span><strong>资源状态</strong>{state.workspace.ready ? "已验证并真实落盘" : "仍有资源或导出未完成"}</span><span><strong>缺失项</strong>{missing.length ? missing.map((resource) => resource.name).join("、") : "无"}</span><span><strong>下一步</strong>{state.workspace.nextAction}</span></div><button className="btn btn-ghost" disabled={!state.workspace.ready} type="button" onClick={() => void onOpenWorkspace()}><FolderOpen size={16} />打开本地工作目录</button></section></div>
    </section>
  );
}

function WaitingPanel({ title, copy }: { title: string; copy: string }) {
  return <section className="agent-view"><div className="agent-waiting"><Loader2 className="spin" size={25} /><strong>{title}</strong><span>{copy}</span></div></section>;
}
