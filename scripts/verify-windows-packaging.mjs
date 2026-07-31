import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const require = createRequire(import.meta.url);
const config = require(path.join(root, "electron-builder.config.cjs"));
const packageJson = require(path.join(root, "package.json"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  config.appId === "com.xunlei.ai-task-agent",
  "Windows package must use a stable explicit appId."
);
assert(
  config.productName === "迅雷 AI Task Agent",
  "Windows package must use the product name."
);
assert(config.asar === true, "Application files must be packaged in ASAR.");
assert(
  config.win?.target?.some(
    (target) =>
      target.target === "nsis" &&
      target.arch?.includes("x64")
  ),
  "Windows x64 NSIS target is required."
);
assert(
  config.win?.target?.some(
    (target) =>
      target.target === "zip" &&
      target.arch?.includes("x64")
  ),
  "Windows x64 ZIP target is required."
);
assert(
  config.nsis?.oneClick === false &&
    config.nsis?.perMachine === false &&
    config.nsis?.allowToChangeInstallationDirectory === true,
  "NSIS must require an interactive per-user installation."
);
assert(
  config.files.includes("!**/.env") &&
    config.files.includes("!**/.env.*"),
  "Packaging must explicitly exclude model configuration and secrets."
);
assert(
  config.files.includes("!dist-electron/**/*.test.js"),
  "Packaging must explicitly exclude compiled Electron tests."
);
assert(
  packageJson.version === "0.3.0",
  "P3 distributable version must be 0.3.0."
);
assert(
  packageJson.devDependencies["electron-builder"] === "26.15.3",
  "Windows builder must stay pinned to the audited 26.15.3 toolchain."
);

const artifactArgument = process.argv[2];
if (artifactArgument) {
  const artifactRoot = path.resolve(root, artifactArgument);
  const executable = path.join(
    artifactRoot,
    `${config.productName}.exe`
  );
  const asarPath = path.join(artifactRoot, "resources", "app.asar");
  assert(existsSync(executable), "Packaged Windows executable is missing.");
  assert(existsSync(asarPath), "Packaged app.asar is missing.");

  const { listPackage } = require("@electron/asar");
  const entries = listPackage(asarPath);
  const normalizedEntries = entries.map((entry) =>
    entry.replaceAll("\\", "/").replace(/^\/+/u, "")
  );
  for (const required of [
    "package.json",
    "dist/index.html",
    "dist-electron/electron/main.js",
    "dist-electron/electron/preload.js",
    "node_modules/dotenv/package.json",
    "node_modules/sql.js/dist/sql-asm.js",
    "node_modules/zod/package.json"
  ]) {
    assert(
      normalizedEntries.includes(required),
      `Packaged app.asar is missing ${required}.`
    );
  }
  assert(
    normalizedEntries.every(
      (entry) =>
        entry !== ".env" &&
        !entry.startsWith(".env.") &&
        !entry.includes("/.env")
    ),
    "Packaged app.asar must not contain .env files."
  );
  assert(
    normalizedEntries.every((entry) => !entry.endsWith(".test.js")),
    "Packaged app.asar must not contain compiled tests."
  );
  assert(
    readdirSync(artifactRoot).some((entry) => entry.endsWith(".exe")),
    "Windows package root must contain an executable."
  );
}

console.log(
  artifactArgument
    ? "Windows package passed: x64 executable, ASAR contents and secret exclusions verified"
    : "Windows packaging configuration passed: NSIS/ZIP x64, ASAR and secret exclusions verified"
);
