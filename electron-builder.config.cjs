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
