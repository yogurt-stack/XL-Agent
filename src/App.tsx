import { useState } from "react";
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
  const { state, dispatch, modelConnectionState, testModelConnection } = useAgentCore();
  const [activeView, setActiveView] = useState<AppView>("home");

  return (
    <div className="app-shell agent-shell">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />
      <AgentTopBar modelConnection={modelConnectionState} state={state} />
      <main className="main-panel">
        {activeView === "home" && <AgentHomeView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "clarification" && <ClarificationView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "plan" && <ResourcePlanView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "execution" && <ExecutionView dispatch={dispatch} state={state} onNavigate={setActiveView} modelConnection={modelConnectionState} />}
        {activeView === "workspace" && <WorkspaceView state={state} />}
        {activeView === "settings" && <SettingsView modelConnection={modelConnectionState} onTestConnection={testModelConnection} />}
      </main>
    </div>
  );
}
