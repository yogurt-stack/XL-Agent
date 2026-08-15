import { useEffect, useRef, useState } from "react";
import {
  AgentHomeView,
  AgentTopBar,
  cancelActiveTaskAndReturnHome,
  ClarificationView,
  ExecutionView,
  ResourcePlanView,
  SettingsView,
  WorkspaceView
} from "./components/AgentViews";
import { Sidebar, type AppView } from "./components/Sidebar";
import { TaskHistoryView } from "./components/TaskHistoryView";
import { useAgentCore } from "./features/agent-core/useAgentCore";
import { useTaskHistory } from "./features/task-history/useTaskHistory";
import type { AgentState } from "./features/agent-core/types";

export function shouldReturnHomeForState(
  phase: AgentState["phase"],
  activeView: AppView
) {
  return (
    phase === "intake" &&
    ["clarification", "plan", "execution", "workspace"].includes(activeView)
  );
}

export function App() {
  const {
    state,
    dispatch,
    modelConnectionState,
    persistenceState,
    capabilities,
    testModelConnection,
    retryTaskLocally,
    resetDemoData,
    readWorkspaceFile,
    openWorkspace,
    selectLocalResources,
    selectLocalRepository,
    prepareGitHubPublish,
    approveGitHubPublish,
    selectWorkspaceRoot
  } = useAgentCore();
  const [activeView, setActiveView] = useState<AppView>("home");
  const [cancellingTask, setCancellingTask] = useState(false);
  const historyState = useTaskHistory(activeView === "history");
  const mainPanelRef = useRef<HTMLElement>(null);
  const previousHandoffReadyRef = useRef(false);

  const handoffReady =
    state.phase === "handoff" && state.workspace.ready;

  useEffect(() => {
    const becameReady = handoffReady && !previousHandoffReadyRef.current;
    previousHandoffReadyRef.current = handoffReady;
    if (becameReady && activeView === "execution") {
      setActiveView("workspace");
    }
  }, [activeView, handoffReady]);

  useEffect(() => {
    const mainPanel = mainPanelRef.current;
    if (!mainPanel) return;
    mainPanel.scrollTop = 0;
    mainPanel.scrollLeft = 0;
  }, [activeView]);

  useEffect(() => {
    if (shouldReturnHomeForState(state.phase, activeView)) {
      setActiveView("home");
    }
  }, [activeView, state.phase]);

  const cancelCurrentTask = () => {
    if (cancellingTask) return;
    setCancellingTask(true);
    void cancelActiveTaskAndReturnHome(dispatch, setActiveView)
      .catch(() => undefined)
      .finally(() => setCancellingTask(false));
  };

  return (
    <div className="app-shell agent-shell">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />
      <AgentTopBar
        cancelling={cancellingTask}
        modelConnection={modelConnectionState}
        onCancelTask={cancelCurrentTask}
        state={state}
      />
      <main className="main-panel" ref={mainPanelRef}>
        {persistenceState.status === "error" && activeView !== "settings" ? (
          <div className="agent-alert" role="alert">
            <strong>Agent Runtime 状态异常：</strong>
            <span>{persistenceState.error}</span>
          </div>
        ) : null}
        {activeView === "home" && <AgentHomeView capabilities={capabilities} dispatch={dispatch} state={state} onNavigate={setActiveView} onSelectLocalRepository={selectLocalRepository} />}
        {activeView === "clarification" && <ClarificationView dispatch={dispatch} state={state} onNavigate={setActiveView} onRetryLocally={retryTaskLocally} />}
        {activeView === "plan" && <ResourcePlanView dispatch={dispatch} state={state} onNavigate={setActiveView} onSelectLocalResources={selectLocalResources} onSelectWorkspaceRoot={selectWorkspaceRoot} />}
        {activeView === "execution" && <ExecutionView capabilities={capabilities} dispatch={dispatch} state={state} onNavigate={setActiveView} modelConnection={modelConnectionState} />}
        {activeView === "workspace" && <WorkspaceView dispatch={dispatch} onApproveGitHubPublish={approveGitHubPublish} onNavigate={setActiveView} onOpenWorkspace={openWorkspace} onPrepareGitHubPublish={prepareGitHubPublish} onReadFile={readWorkspaceFile} onSelectWorkspaceRoot={selectWorkspaceRoot} state={state} />}
        {activeView === "history" && <TaskHistoryView historyState={historyState} />}
        {activeView === "settings" && <SettingsView capabilities={capabilities} modelConnection={modelConnectionState} onResetDemoData={resetDemoData} onTestConnection={testModelConnection} persistence={persistenceState} state={state} />}
      </main>
    </div>
  );
}
