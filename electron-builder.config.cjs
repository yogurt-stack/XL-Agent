const fs = require("node:fs");

const nativeHostRoot = "native/xunlei-download-host/dist/windows-x64";
const extraResources = fs.existsSync(nativeHostRoot)
  ? [
      {
        from: nativeHostRoot,
        to: "xunlei-sdk",
        // xunlei-download-host.exe 依赖 dk.dll（迅雷 SDK）、libcurl.dll（依赖 z.dll）
        // 以及 VC++ 运行库（msvcp140/vcruntime140/vcruntime140_1）。
        // 全部一起打包，否则宿主在安装包内启动失败。
        filter: [
          "xunlei-download-host.exe",
          "dk.dll",
          "libcurl.dll",
          "z.dll",
          "msvcp140.dll",
          "vcruntime140.dll",
          "vcruntime140_1.dll"
        ]
      }
    ]
  : [];

module.exports = {
  appId: "com.xunlei.ai-task-agent",
  productName: "迅雷 AI Task Agent",
  asar: true,
  compression: "maximum",
  directories: {
    output: "release"
  },
  files: [
    "dist/**/*",
    "dist-electron/**/*",
    "package.json",
    "!**/*.map",
    "!dist-electron/**/*.test.js",
    "!**/.env",
    "!**/.env.*"
  ],
  extraResources,
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"]
      },
      {
        target: "zip",
        arch: ["x64"]
      }
    ],
    artifactName: "Xunlei-AI-Task-Agent-${version}-${arch}.${ext}",
    verifyUpdateCodeSignature: true
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true
  },
  publish: null
};
