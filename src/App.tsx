import { useEffect, useRef, useState } from "react";
import {
  AgentHomeView,
  AgentTopBar,
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
    selectWorkspaceRoot
  } = useAgentCore();
  const [activeView, setActiveView] = useState<AppView>("home");
  const historyState = useTaskHistory(activeView === "history");
  const mainPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const mainPanel = mainPanelRef.current;
    if (!mainPanel) return;
    mainPanel.scrollTop = 0;
    mainPanel.scrollLeft = 0;
  }, [activeView]);

  return (
    <div className="app-shell agent-shell">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />
      <AgentTopBar modelConnection={modelConnectionState} state={state} />
      <main className="main-panel" ref={mainPanelRef}>
        {activeView === "home" && <AgentHomeView capabilities={capabilities} dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "clarification" && <ClarificationView dispatch={dispatch} state={state} onNavigate={setActiveView} onRetryLocally={retryTaskLocally} />}
        {activeView === "plan" && <ResourcePlanView dispatch={dispatch} state={state} onNavigate={setActiveView} onSelectLocalResources={selectLocalResources} onSelectWorkspaceRoot={selectWorkspaceRoot} />}
        {activeView === "execution" && <ExecutionView dispatch={dispatch} state={state} onNavigate={setActiveView} modelConnection={modelConnectionState} />}
        {activeView === "workspace" && <WorkspaceView dispatch={dispatch} onOpenWorkspace={openWorkspace} onReadFile={readWorkspaceFile} onSelectWorkspaceRoot={selectWorkspaceRoot} state={state} />}
        {activeView === "history" && <TaskHistoryView historyState={historyState} />}
        {activeView === "settings" && <SettingsView capabilities={capabilities} modelConnection={modelConnectionState} onResetDemoData={resetDemoData} onTestConnection={testModelConnection} persistence={persistenceState} state={state} />}
      </main>
    </div>
  );
}
