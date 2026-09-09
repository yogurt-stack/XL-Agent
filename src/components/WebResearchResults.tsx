import { useState } from "react";
import { ExternalLink, Loader2, Search } from "lucide-react";
import type { AgentState, AgentUserEvent } from "../features/agent-core/types";
import {
  webReportFromState,
  webSources,
} from "../features/agent-core/webResearch";
import { githubFullNameFromUrl } from "../features/agent-core/githubSearch";

export function WebResearchResults({
  state,
  dispatch,
  onNavigate,
}: {
  state: AgentState;
  dispatch: (event: AgentUserEvent) => Promise<AgentState>;
  onNavigate: (view: "home" | "clarification" | "plan") => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const analysis = state.taskPlan?.steps.find(
    (step) => step.kind === "analysis",
  );
  const report = webReportFromState(state);
  const sources = webSources(state);
  const searches = state.agentRun.toolResults.filter(
    (r) => r.tool === "search_web",
  );
  const status =
    report?.status === "complete"
      ? "已完成"
      : report?.status === "partial"
        ? "部分完成"
        : "暂不可用";
  async function repositoryAction(fullName: string, prepare: boolean) {
    setBusy(fullName);
    setError(null);
    try {
      await dispatch({
        type: prepare
          ? "PREPARE_GITHUB_REPOSITORY"
          : "ANALYZE_GITHUB_REPOSITORY",
        fullName,
      });
      onNavigate(prepare ? "plan" : "clarification");
    } catch (e) {
      setError(e instanceof Error ? e.message : "仓库操作失败。");
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="agent-view github-results-view">
      <div className="agent-page-heading">
        <div>
          <span>
            <Search size={16} /> 网页搜索与研究
          </span>
          <h1>{status}</h1>
        </div>
        <p>
          {searches.length} 次搜索 · {sources.filter((s) => s.read).length}{" "}
          页正文
        </p>
      </div>
      <section className="github-results-summary" aria-label="网页研究结论">
        <p style={{ whiteSpace: "pre-wrap" }}>
          {report?.summary ?? analysis?.error ?? "没有可展示的研究报告。"}
        </p>
      </section>
      {report?.findings.length ? (
        <ol className="web-research-findings">
          {report.findings.map((finding, index) => (
            <li key={index}>
              <p>{finding.claim}</p>
              <p>
                {finding.urls.map((url, i) => (
                  <a href={url} target="_blank" rel="noreferrer" key={url}>
                    [{sources.findIndex((s) => s.url === url) + 1 || i + 1}]{" "}
                    {new URL(url).hostname}{" "}
                  </a>
                ))}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
      {report?.limitations.length ? (
        <section aria-label="尚未确认的信息">
          <h2>覆盖范围与未确认信息</h2>
          <ul>
            {report.limitations.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {error ? (
        <p className="agent-alert" role="alert">
          {error}
        </p>
      ) : null}
      <section aria-label="网页来源">
        <h2>来源资料</h2>
        {sources.length ? (
          <ol className="web-research-sources">
            {sources.map((source) => {
              const repository = githubFullNameFromUrl(source.url);
              return (
                <li
                  key={source.url}
                  style={{ marginBottom: 20, overflowWrap: "anywhere" }}
                >
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.title} <ExternalLink size={14} />
                  </a>
                  <p>{source.snippet}</p>
                  <small>
                    {source.read ? "已读取正文" : "仅搜索摘要"}
                    {source.truncated ? "（正文已截断）" : ""} ·{" "}
                    {source.fetchedAt}
                  </small>
                  {repository ? (
                    <div className="failure-actions">
                      <button
                        className="btn btn-secondary"
                        disabled={busy !== null}
                        onClick={() => void repositoryAction(repository, false)}
                      >
                        {busy === repository ? (
                          <Loader2 className="spin" size={14} />
                        ) : null}
                        分析仓库
                      </button>
                      <button
                        className="btn btn-secondary"
                        disabled={busy !== null}
                        onClick={() => void repositoryAction(repository, true)}
                      >
                        准备到本地
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p>尚未取得网页来源，请核对搜索服务配置或网络状态。</p>
        )}
      </section>
      <details>
        <summary>检索记录</summary>
        <ul>
          {searches.map((r) => (
            <li key={r.callId}>
              {r.status === "success"
                ? String((r.output as { query?: string }).query ?? "")
                : r.error?.message}
            </li>
          ))}
        </ul>
      </details>
      <footer className="github-results-footer">
        <button
          className="btn btn-primary"
          onClick={async () => {
            await dispatch({ type: "RESET" });
            onNavigate("home");
          }}
        >
          开始新任务
        </button>
      </footer>
    </section>
  );
}
