import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
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
  Route,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  XCircle
} from "lucide-react";
import { createResourceManifest } from "../features/agent-core/manifest";
import {
  estimatedMinutes,
  overallProgress,
  phaseLabel,
  requiredMissingResources,
  totalDownloadSizeMb
} from "../features/agent-core/selectors";
import { getActiveClarification } from "../features/agent-core/machine";
import type { AgentEvent, AgentState, ResourceStatus } from "../features/agent-core/types";

type Dispatch = (event: AgentEvent) => void;
type Navigate = (view: "home" | "clarification" | "plan" | "execution" | "workspace") => void;

const statusMeta: Record<ResourceStatus, { label: string; className: string }> = {
  pending: { label: "待确认", className: "status-muted" },
  queued: { label: "等待下载", className: "status-queued" },
  downloading: { label: "下载中", className: "status-active" },
  downloaded: { label: "待验证", className: "status-info" },
  verified: { label: "已验证", className: "status-success" },
  failed: { label: "需重规划", className: "status-danger" },
  skipped: { label: "已跳过", className: "status-warning" },
  replaced: { label: "已替代", className: "status-queued" }
};

function formatMb(value: number) {
  return `${value.toFixed(1)} MB`;
}

function ResourceStatusBadge({ status }: { status: ResourceStatus }) {
  const meta = statusMeta[status];
  return <span className={`resource-status ${meta.className}`}>{meta.label}</span>;
}

export function AgentTopBar({ state }: { state: AgentState }) {
  const active = state.phase === "routing" || state.phase === "planning" || state.phase === "replanning";
  return (
    <header className="topbar">
      <div className="title-block">
        <div className="app-title-row">
          <span className="app-title">迅雷 AI Task Agent</span>
          <span className={`status-pill ${state.phase === "handoff" ? "status-success" : active ? "status-active" : "status-info"}`}>
            {active ? <Loader2 className="spin" size={14} /> : <Bot size={14} />}
            {phaseLabel(state.phase)}
          </span>
        </div>
        <span className="app-subtitle">Agent Core r{state.revision} · Windows 11 x64 · 前端内存模拟</span>
      </div>
      <div className="topbar-meta">
        <span className="meta-chip"><ShieldCheck size={15} />可信目录</span>
        <span className="meta-chip"><TerminalSquare size={15} />{state.systemProfile.shell}</span>
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
          dispatch({ type: "SUBMIT_TASK", task });
          onNavigate("clarification");
        }}
      >
        <textarea name="task" defaultValue={state.task || "帮我准备一个 Windows 下的 AI 开发环境"} />
        <button className="btn btn-primary" type="submit"><Sparkles size={17} />开始任务</button>
      </form>
      <div className="agent-home-grid">
        <section className="agent-panel">
          <div className="agent-panel-heading"><Clock3 size={17} /><h2>最近任务</h2></div>
          <div className="recent-task-list">
            {recentTasks.map((task) => (
              <button key={task} type="button" onClick={() => { dispatch({ type: "SUBMIT_TASK", task }); onNavigate("clarification"); }}>
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
    return <WaitingPanel title="正在路由任务" copy="Agent 将根据系统画像加载下一项澄清。" />;
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
      {state.phase === "planning" && <button className="btn btn-primary" type="button" onClick={() => onNavigate("plan")}><ListChecks size={16} />查看资源计划</button>}
    </section>
  );
}

export function ResourcePlanView({ state, dispatch, onNavigate }: { state: AgentState; dispatch: Dispatch; onNavigate: Navigate }) {
  if (state.phase === "planning" || state.phase === "routing" || state.phase === "clarifying") return <WaitingPanel title="正在生成计划" copy="资源计划将由已确认的系统画像和澄清答案生成。" />;
  if (state.resources.length === 0) return <WaitingPanel title="尚无资源计划" copy="请先在首页提交任务并完成澄清。" />;
  const waitingApproval = state.phase === "waiting_approval";
  return (
    <section className="agent-view plan-view">
      <div className="agent-page-heading"><div><span>资源计划 r{state.revision}</span><h1>{state.replanReason ? "替代计划等待再次确认" : "可信资源准备计划"}</h1></div><p>总量 {formatMb(totalDownloadSizeMb(state))} · 预计 {estimatedMinutes(state)} 分钟</p></div>
      {state.replanReason && <div className="agent-alert"><AlertTriangle size={17} />{state.replanReason === "download_failed" ? "下载失败后已生成备用来源。" : state.replanReason === "version_mismatch" ? "版本验证不匹配，已生成替代版本。" : "必需资源被取消，已生成替代交付方案。"}</div>}
      <div className="agent-resource-list">
        {state.resources.map((resource) => (
          <article className={`agent-resource-row ${resource.required ? "agent-resource-required" : ""}`} key={resource.id}>
            <label className="resource-selection"><input checked={resource.selected} disabled={!waitingApproval} type="checkbox" onChange={(event) => dispatch({ type: "TOGGLE_RESOURCE", resourceId: resource.id, selected: event.target.checked })} /><span /></label>
            <div className="resource-plan-main"><div><h3>{resource.name}</h3><span>{resource.version} {resource.replacedFrom ? `· 替代 ${resource.replacedFrom}` : ""}</span></div><ResourceStatusBadge status={resource.status} /></div>
            <div className="resource-plan-details"><span><strong>来源</strong>{resource.source}</span><span><strong>用途</strong>{resource.purpose}</span><span><strong>大小</strong>{formatMb(resource.sizeMb)}</span><span><strong>授权</strong>{resource.license}</span></div>
            <p>{resource.recommendation}</p>
            <div className="resource-plan-footer"><span>{resource.required ? "必需项" : "可选项"}</span><span>{resource.dependsOn.length ? `依赖：${resource.dependsOn.join("、")}` : "无前置依赖"}</span></div>
          </article>
        ))}
      </div>
      <div className="plan-footer"><span>已选择 {state.resources.filter((resource) => resource.selected).length} 项资源</span><button className="btn btn-primary" disabled={!waitingApproval} type="button" onClick={() => { dispatch({ type: "APPROVE_PLAN" }); onNavigate("execution"); }}><ShieldCheck size={16} />确认下载计划 r{state.revision}</button></div>
    </section>
  );
}

export function ExecutionView({ state, dispatch }: { state: AgentState; dispatch: Dispatch }) {
  const isWorking = ["downloading", "verifying", "replanning"].includes(state.phase);
  return (
    <section className="agent-view execution-view">
      <div className="agent-page-heading"><div><span>执行监控</span><h1>Agent 正在{phaseLabel(state.phase)}</h1></div><button className="btn btn-ghost" disabled={!isWorking} type="button" onClick={() => dispatch({ type: "CANCEL_TASK" })}><XCircle size={16} />取消任务</button></div>
      <div className="execution-summary"><div><span>总体进度</span><strong>{overallProgress(state)}%</strong></div><div><span>活动资源</span><strong>{state.activeResourceId ?? "等待"}</strong></div><div><span>计划修订</span><strong>r{state.revision}</strong></div></div>
      <div className="execution-grid"><section className="agent-panel"><div className="agent-panel-heading"><PackageCheck size={17} /><h2>下载任务</h2></div>{state.resources.map((resource) => <div className="execution-resource" key={resource.id}><div><strong>{resource.name}</strong><ResourceStatusBadge status={resource.status} /></div><div className="progress-track"><span style={{ width: `${resource.progress}%` }} /></div><small>{resource.progress}% {resource.failureReason ? `· ${resource.failureReason}` : ""}</small></div>)}</section><section className="agent-panel agent-log-panel"><div className="agent-panel-heading"><FileText size={17} /><h2>操作日志</h2></div>{state.logs.length ? <div className="agent-log-list">{state.logs.map((log) => <span className={`agent-log-${log.level}`} key={log.id}><small>{log.at}</small>{log.message}</span>)}</div> : <span className="agent-empty-copy">等待 Agent 事件。</span>}</section></div>
    </section>
  );
}

export function WorkspaceView({ state }: { state: AgentState }) {
  const [previewFile, setPreviewFile] = useState("resource-manifest.json");
  const manifest = useMemo(() => JSON.stringify(createResourceManifest(state), null, 2), [state]);
  const missing = requiredMissingResources(state);
  const preview = previewFile === "resource-manifest.json" ? manifest : previewFile === "README.md" ? "# AI Dev Workspace\n\n1. 运行 scripts/bootstrap.ps1\n2. 运行 scripts/verify-environment.ps1" : previewFile === "RESOURCE_MANIFEST.md" ? `# Resource Manifest r${state.revision}\n\n所有资源均由可信目录生成。` : "# AGENTS.md\n\n后续 Agent 读取 resource-manifest.json、日志和下一步动作。";
  return (
    <section className="agent-view workspace-view">
      <div className="agent-page-heading"><div><span>工作区交接</span><h1>{state.workspace.ready ? "交接包已就绪" : "等待资源准备完成"}</h1></div><p>{state.systemProfile.workspaceRoot}</p></div>
      <div className="workspace-agent-grid"><section className="agent-panel"><div className="agent-panel-heading"><FileCode2 size={17} /><h2>文件清单</h2></div><div className="workspace-file-buttons">{state.workspace.files.map((file) => <button className={previewFile === file ? "file-selected" : ""} key={file} type="button" onClick={() => setPreviewFile(file)}>{file === "resource-manifest.json" ? <FileJson2 size={15} /> : <FileText size={15} />}{file}</button>)}</div></section><section className="agent-panel"><div className="agent-panel-heading"><FileText size={17} /><h2>{previewFile} 预览</h2></div><pre className="workspace-code-preview">{preview}</pre></section><section className="agent-panel"><div className="agent-panel-heading"><Bot size={17} /><h2>Agent 交接面板</h2></div><div className="handoff-list"><span><strong>目标</strong>{state.task || "尚未输入任务"}</span><span><strong>资源状态</strong>{state.workspace.ready ? "已验证，可交接" : "仍有资源未验证"}</span><span><strong>缺失项</strong>{missing.length ? missing.map((resource) => resource.name).join("、") : "无"}</span><span><strong>下一步</strong>{state.workspace.nextAction}</span></div><button className="btn btn-ghost" disabled type="button" title="纯前端内存模拟不会创建本地目录"><FolderOpen size={16} />打开本地工作目录</button></section></div>
    </section>
  );
}

function WaitingPanel({ title, copy }: { title: string; copy: string }) {
  return <section className="agent-view"><div className="agent-waiting"><Loader2 className="spin" size={25} /><strong>{title}</strong><span>{copy}</span></div></section>;
}
