import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  FileClock,
  FolderOpen,
  History,
  Loader2,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Wrench
} from "lucide-react";
import type { AgentPhase, ResourceStatus } from "../features/agent-core/types";
import { phaseLabel } from "../features/agent-core/selectors";
import type { TaskHistoryViewState } from "../features/task-history/useTaskHistory";

const knownPhases = new Set<AgentPhase>([
  "intake",
  "routing",
  "unsupported",
  "task_planning",
  "waiting_task_plan_confirmation",
  "clarifying",
  "planning",
  "waiting_approval",
  "downloading",
  "awaiting_failure_action",
  "verifying",
  "exporting",
  "awaiting_export_retry",
  "replanning",
  "result",
  "handoff",
  "cancelled"
]);

const resourceStatusLabels: Record<ResourceStatus, string> = {
  pending: "待确认",
  queued: "等待下载",
  downloading: "下载中",
  paused: "已暂停",
  downloaded: "待验证",
  verified: "已验证",
  failed: "失败",
  skipped: "已跳过",
  replaced: "已替代"
};

const approvalStatusLabels = {
  active: "有效",
  expired: "已过期",
  revoked: "已撤销"
} as const;

const supplyChainEventLabels: Record<string, string> = {
  "catalog-approval-pinned": "目录版本已固定",
  "catalog-pin-rejected": "目录版本不匹配",
  "plan-approval-pinned": "审批计划指纹已固定",
  "plan-pin-rejected": "审批计划指纹不匹配",
  "download-checkpointed": "下载断点已记录",
  "download-resumed": "下载已断点续传",
  "signature-verified": "制品签名已验证",
  "signature-rejected": "制品签名被拒绝"
};

function safePhaseLabel(phase: string) {
  return knownPhases.has(phase as AgentPhase)
    ? phaseLabel(phase as AgentPhase)
    : phase;
}

function formatDate(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium"
      }).format(timestamp);
}

function EmptyDetail({ message }: { message: string }) {
  return (
    <div className="history-empty-detail">
      <FileClock size={28} />
      <span>{message}</span>
    </div>
  );
}

export function TaskHistoryView({
  historyState
}: {
  historyState: TaskHistoryViewState;
}) {
  const {
    listStatus,
    detailStatus,
    history,
    selectedTaskId,
    detail,
    error,
    refresh,
    selectTask
  } = historyState;

  return (
    <section className="agent-view task-history-view" data-testid="history-view">
      <div className="agent-page-heading history-page-heading">
        <div>
          <span>SQLite 只读记录</span>
          <h1>历史任务</h1>
        </div>
        <div className="history-heading-actions">
          <p>查看每个任务最近一次持久化快照，不会切换或修改当前任务。</p>
          <button
            className="btn btn-ghost btn-small"
            disabled={listStatus === "loading"}
            type="button"
            onClick={refresh}
          >
            {listStatus === "loading" ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <RefreshCw size={15} />
            )}
            刷新
          </button>
        </div>
      </div>

      {listStatus === "loading" && history.length === 0 ? (
        <section className="agent-panel history-state-panel">
          <Loader2 className="spin" size={24} />
          <strong>正在读取历史任务</strong>
          <span>从本机 SQLite 加载最近保存的任务快照。</span>
        </section>
      ) : null}

      {listStatus === "error" && history.length === 0 ? (
        <section className="failure-resolution-panel history-state-panel" role="alert">
          <AlertTriangle size={22} />
          <strong>历史任务读取失败</strong>
          <span>{error}</span>
          <button className="btn btn-primary btn-small" type="button" onClick={refresh}>
            <RefreshCw size={15} />
            重新读取
          </button>
        </section>
      ) : null}

      {listStatus === "ready" && history.length === 0 ? (
        <section className="agent-panel history-state-panel">
          <Database size={26} />
          <strong>还没有历史任务</strong>
          <span>开始一个任务并发生状态转换后，快照会显示在这里。</span>
        </section>
      ) : null}

      {history.length > 0 ? (
        <div className="history-layout">
          <aside className="agent-panel history-list-panel" aria-label="历史任务列表">
            <div className="agent-panel-heading">
              <History size={17} />
              <h2>最近任务</h2>
              <span className="history-count">{history.length}</span>
            </div>
            <div className="history-task-list">
              {history.map((item) => (
                <button
                  aria-pressed={selectedTaskId === item.taskId}
                  className={
                    selectedTaskId === item.taskId
                      ? "history-task history-task-selected"
                      : "history-task"
                  }
                  data-task-id={item.taskId}
                  key={item.taskId}
                  type="button"
                  onClick={() => selectTask(item.taskId)}
                >
                  <span className="history-task-title">
                    <strong>{item.task}</strong>
                    {item.hasErrors ? <AlertTriangle size={14} /> : null}
                  </span>
                  <span className="history-task-meta">
                    <em>{safePhaseLabel(item.phase)}</em>
                    <small>r{item.revision}</small>
                    <small>
                      {item.verifiedResourceCount}/{item.resourceCount} 已验证
                    </small>
                  </span>
                  <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
                </button>
              ))}
            </div>
          </aside>

          <section className="history-detail-panel" aria-live="polite">
            {detailStatus === "loading" ? (
              <section className="agent-panel history-state-panel">
                <Loader2 className="spin" size={23} />
                <strong>正在读取任务详情</strong>
              </section>
            ) : null}

            {detailStatus === "error" ? (
              <section className="failure-resolution-panel history-state-panel" role="alert">
                <AlertTriangle size={21} />
                <strong>任务详情不可用</strong>
                <span>{error}</span>
              </section>
            ) : null}

            {detailStatus === "ready" && detail ? (
              <>
                <section className="agent-panel history-overview">
                  <div className="history-detail-heading">
                    <div>
                      <span>{safePhaseLabel(detail.summary.phase)}</span>
                      <h2>{detail.summary.task}</h2>
                      <code>{detail.summary.taskId}</code>
                    </div>
                    <span
                      className={`status-pill ${
                        detail.summary.hasErrors ? "status-danger" : "status-success"
                      }`}
                    >
                      {detail.summary.hasErrors ? (
                        <AlertTriangle size={14} />
                      ) : (
                        <CheckCircle2 size={14} />
                      )}
                      {detail.summary.hasErrors ? "包含错误" : "快照正常"}
                    </span>
                  </div>
                  <div className="history-stat-grid">
                    <span>
                      <small>计划版本</small>
                      <strong>r{detail.summary.revision}</strong>
                    </span>
                    <span>
                      <small>审批版本</small>
                      <strong>
                        {detail.summary.approvedRevision === null
                          ? "未审批"
                          : `r${detail.summary.approvedRevision}`}
                      </strong>
                    </span>
                    <span>
                      <small>资源验证</small>
                      <strong>
                        {detail.summary.verifiedResourceCount}/{detail.summary.resourceCount}
                      </strong>
                    </span>
                    <span>
                      <small>工作区</small>
                      <strong>{detail.summary.workspaceReady ? "已就绪" : "未就绪"}</strong>
                    </span>
                  </div>
                  <p className="history-updated-at">
                    <Clock3 size={14} />
                    最近保存于 {formatDate(detail.summary.updatedAt)}
                  </p>
                </section>

                <section className="agent-panel">
                  <div className="agent-panel-heading">
                    <Database size={17} />
                    <h2>资源快照</h2>
                  </div>
                  {detail.state.resources.length ? (
                    <div className="history-resource-list">
                      {detail.state.resources.map((resource) => (
                        <div className="history-resource-row" key={resource.id}>
                          <div>
                            <strong>{resource.name}</strong>
                            <small>{resource.version} · {resource.source}</small>
                          </div>
                          <span>{resourceStatusLabels[resource.status]}</span>
                          <small>{resource.attempts} 次尝试</small>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyDetail message="该快照尚未生成资源计划。" />
                  )}
                </section>

                <div className="history-audit-grid">
                  <section className="agent-panel">
                    <div className="agent-panel-heading">
                      <ShieldCheck size={17} />
                      <h2>审批记录</h2>
                    </div>
                    {detail.approvals.length ? (
                      <div className="history-record-list">
                        {detail.approvals.map((approval) => (
                          <div key={`${approval.taskId}-${approval.revision}`}>
                            <span>
                              <strong>r{approval.revision}</strong>
                              <em className={`history-approval-${approval.status}`}>
                                {approvalStatusLabels[approval.status]}
                              </em>
                            </span>
                            <small>批准：{formatDate(approval.approvedAt)}</small>
                            <small>到期：{formatDate(approval.expiresAt)}</small>
                            <small>目录：{approval.catalogVersion} · {approval.catalogSourceSha256.slice(0, 12)}…</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyDetail message="没有审批记录。" />
                    )}
                  </section>

                  <section className="agent-panel">
                    <div className="agent-panel-heading">
                      <FolderOpen size={17} />
                      <h2>工作区导出</h2>
                    </div>
                    {detail.workspaceExports.length ? (
                      <div className="history-record-list">
                        {detail.workspaceExports.map((output) => (
                          <div key={`${output.taskId}-${output.revision}`}>
                            <span>
                              <strong>r{output.revision}</strong>
                              <em>{output.files.length} 个文件</em>
                            </span>
                            <code title={output.rootPath}>{output.rootPath}</code>
                            <small>{formatDate(output.generatedAt)}</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyDetail message="没有工作区导出记录。" />
                    )}
                  </section>
                </div>

                <div className="history-audit-grid">
                  <section className="agent-panel">
                    <div className="agent-panel-heading">
                      <Wrench size={17} />
                      <h2>模型与工具审计</h2>
                    </div>
                    <div className="history-audit-summary">
                      <span>
                        <small>模型决策</small>
                        <strong>{detail.state.agentRun.decisions.length}</strong>
                      </span>
                      <span>
                        <small>工具结果</small>
                        <strong>{detail.state.agentRun.toolResults.length}</strong>
                      </span>
                      <span>
                        <small>策略记录</small>
                        <strong>{detail.state.agentRun.policyAudit.length}</strong>
                      </span>
                    </div>
                    <div className="history-tool-list">
                      {detail.state.agentRun.toolResults.slice().reverse().map((result) => (
                        <div key={result.callId}>
                          <span>{result.tool}</span>
                          <em className={`trace-${result.status}`}>{result.status}</em>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="agent-panel">
                    <div className="agent-panel-heading">
                      <ScrollText size={17} />
                      <h2>运行日志</h2>
                    </div>
                    {detail.state.logs.length ? (
                      <div className="history-log-list">
                        {detail.state.logs.slice().reverse().map((entry) => (
                          <div className={`history-log-${entry.level}`} key={entry.id}>
                            <time>{entry.at}</time>
                            <span>{entry.message}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyDetail message="该快照没有运行日志。" />
                    )}
                  </section>

                  <section className="agent-panel">
                    <div className="agent-panel-heading">
                      <ShieldCheck size={17} />
                      <h2>供应链与恢复审计</h2>
                    </div>
                    {detail.operationEvents.length ? (
                      <div className="history-log-list">
                        {detail.operationEvents.slice(0, 20).map((event) => (
                          <div className={`history-log-${event.outcome === "success" ? "info" : "error"}`} key={event.eventId}>
                            <time>{formatDate(event.createdAt)}</time>
                            <span>{supplyChainEventLabels[event.eventType] ?? event.eventType}{event.resourceId ? ` · ${event.resourceId}` : ""}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyDetail message="该任务尚无 P1 供应链事件。" />
                    )}
                    {detail.downloadArtifacts.length ? (
                      <div className="history-tool-list">
                        {detail.downloadArtifacts.map((artifact) => (
                          <div key={`${artifact.taskId}-${artifact.revision}-${artifact.resourceId}`}>
                            <span>{artifact.resourceId} · {artifact.actualPublisher ?? artifact.expectedPublisher ?? "签名不适用"}</span>
                            <em className={artifact.signatureStatus === "valid" || artifact.signatureStatus === "not-applicable" ? "trace-success" : artifact.signatureStatus === "pending" ? "trace-cancelled" : "trace-error"}>{artifact.signatureStatus}</em>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </section>
                </div>
              </>
            ) : null}

            {detailStatus === "idle" ? (
              <section className="agent-panel">
                <EmptyDetail message="请选择一条历史任务。" />
              </section>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}
