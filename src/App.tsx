import { useState } from "react";
import {
  AgentHomeView,
  AgentTopBar,
  ClarificationView,
  ExecutionView,
  ResourcePlanView,
  WorkspaceView
} from "./components/AgentViews";
import { Sidebar, type AppView } from "./components/Sidebar";
import { useAgentCore } from "./features/agent-core/useAgentCore";

export function App() {
  const { state, dispatch } = useAgentCore();
  const [activeView, setActiveView] = useState<AppView>("home");

  return (
    <div className="app-shell agent-shell">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />
      <AgentTopBar state={state} />
      <main className="main-panel">
        {activeView === "home" && <AgentHomeView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "clarification" && <ClarificationView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "plan" && <ResourcePlanView dispatch={dispatch} state={state} onNavigate={setActiveView} />}
        {activeView === "execution" && <ExecutionView dispatch={dispatch} state={state} />}
        {activeView === "workspace" && <WorkspaceView state={state} />}
      </main>
    </div>
  );
}
