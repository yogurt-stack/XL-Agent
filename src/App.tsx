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
import { useAgentCore } from "./features/agent-core/useAgentCore";

export function App() {
  const {
    state,
    dispatch,
    modelConnectionState,
    persistenceState,
    testModelConnection,
    readWorkspaceFile,
    openWorkspace
  } = useAgentCore();
  const [activeView, setActiveView] = useState<AppView>("home");
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
        {activeView === "home" && <AgentHomeView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "clarification" && <ClarificationView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "plan" && <ResourcePlanView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "execution" && <ExecutionView dispatch={dispatch} state={state} onNavigate={setActiveView} modelConnection={modelConnectionState} />}
        {activeView === "workspace" && <WorkspaceView dispatch={dispatch} onOpenWorkspace={openWorkspace} onReadFile={readWorkspaceFile} state={state} />}
        {activeView === "settings" && <SettingsView modelConnection={modelConnectionState} onTestConnection={testModelConnection} persistence={persistenceState} state={state} />}
      </main>
    </div>
  );
}
