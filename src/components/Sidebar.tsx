import {
  FolderKanban,
  ClipboardCheck,
  DownloadCloud,
  Home,
  ListChecks,
  Zap
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type AppView = "home" | "clarification" | "plan" | "execution" | "workspace";

type AvailableNavItem = {
  key: AppView;
  label: string;
  icon: LucideIcon;
  available: true;
};

type UnavailableNavItem = {
  key: AppView | "workspace" | "settings";
  label: string;
  icon: LucideIcon;
  available: false;
};

type NavItem = AvailableNavItem | UnavailableNavItem;

const navItems: NavItem[] = [
  { key: "home", label: "首页", icon: Home, available: true },
  { key: "clarification", label: "澄清", icon: ClipboardCheck, available: true },
  { key: "plan", label: "计划", icon: ListChecks, available: true },
  { key: "execution", label: "执行", icon: DownloadCloud, available: true },
  { key: "workspace", label: "工作区", icon: FolderKanban, available: true },
];

type SidebarProps = {
  activeView: AppView;
  onViewChange: (view: AppView) => void;
};

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="brand-mark" title="迅雷 AI Task Agent">
        <Zap size={22} />
      </div>
      <nav className="nav-list">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = item.key === activeView;
          return (
            <button
              aria-current={isActive ? "page" : undefined}
              aria-disabled={!item.available}
              className={`nav-item ${isActive ? "nav-item-active" : ""}`}
              disabled={!item.available}
              key={item.key}
              type="button"
              title={item.available ? item.label : `${item.label}视图即将提供`}
              onClick={() => {
                if (item.available) {
                  onViewChange(item.key);
                }
              }}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
