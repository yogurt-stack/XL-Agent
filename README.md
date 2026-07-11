# 迅雷 AI Task Agent

一个基于 Electron + React + TypeScript + Vite 的桌面端高保真交互 Demo。

它模拟“用户用自然语言描述目标，Agent 路由并澄清需求，生成可信资源计划，经用户确认后模拟下载、验证、重规划并生成可交接工作区”的流程。所有资源、下载进度、失败重试和 Manifest 都在前端内存中模拟，不会真实下载文件，也不会发起网络请求。

## 技术栈

- Electron 主进程 + preload
- React + TypeScript + Vite renderer
- lucide-react 图标
- 原生 CSS 样式
- IPC 示例：`getAppInfo`
- `nodeIntegration: false`
- 纯 TypeScript Agent Core 状态机

## 启动

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

构建会依次执行 renderer 类型检查、Electron 主进程编译和 Vite production build。

## Agent Core 验证

```bash
npm run verify:agent-core
```

该场景覆盖必需资源取消、下载失败、版本不匹配、替代计划再次确认和最终交接 Manifest revision。

## 目录结构

```text
xunlei-ai-task-agent/
  electron/
    main.ts
    preload.ts
    tsconfig.json
  scripts/
    dev.mjs
  src/
    components/
    features/agent-core/
    styles/
    types/
    App.tsx
    main.tsx
  index.html
  package.json
  tsconfig.app.json
  tsconfig.node.json
  vite.config.mts
```

## Demo 流程

1. 输入任务，例如“帮我准备一个 Windows 下的 AI 开发环境”。
2. Agent 固定路由到 Windows AI 开发环境 Skill，并一次询问一个澄清问题。
3. 生成可信资源计划 r1；取消必需资源、下载失败或版本不匹配都会进入重规划。
4. 每次替代计划生成后都会进入 `waiting_approval`，必须由用户再次确认。
5. 验证通过后生成含 `revision` 字段的 `resource-manifest.json` 和工作区交接预览。
