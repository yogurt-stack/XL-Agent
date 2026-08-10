import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fakeCompiler = `#!/usr/bin/env node
process.exit(0);
`;

const fakeBlockingCompiler = `#!/usr/bin/env node
const fs = require("node:fs");

fs.writeFileSync(process.env.XL_AGENT_TEST_COMPILER_PID_PATH, String(process.pid));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => process.exit(0));
}
setInterval(() => {}, 1_000);
`;

const fakeVite = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");

const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
const server = net.createServer();

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, stop);
}

server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(process.env.XL_AGENT_TEST_VITE_PID_PATH, String(process.pid));
});
`;

const fakeElectron = `#!/usr/bin/env node
const fs = require("node:fs");

fs.writeFileSync(process.env.XL_AGENT_TEST_ELECTRON_PID_PATH, String(process.pid));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => process.exit(0));
}
setInterval(() => {}, 1_000);
`;

function processIsAlive(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a loopback test port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function writeExecutable(filePath: string, source: string) {
  await writeFile(filePath, source, "utf8");
  await chmod(filePath, 0o755);
}

async function readPidFile(filePath: string) {
  try {
    const pid = Number(await readFile(filePath, "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function terminate(pid: number | null) {
  if (!processIsAlive(pid)) return;
  try {
    process.kill(pid as number, "SIGKILL");
  } catch {
    // The isolated fixture process may have exited between the liveness check
    // and the cleanup signal.
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("The development supervisor did not exit in time."));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

describe("development supervisor lifecycle", () => {
  it("does not start Vite or Electron after SIGHUP interrupts compilation", async () => {
    if (process.platform === "win32") return;

    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "xl-agent-dev-startup-supervisor-")
    );
    const scriptsDirectory = path.join(fixtureRoot, "scripts");
    const binDirectory = path.join(fixtureRoot, "node_modules", ".bin");
    const compilerPidPath = path.join(fixtureRoot, "compiler.pid");
    const vitePidPath = path.join(fixtureRoot, "vite.pid");
    const electronPidPath = path.join(fixtureRoot, "electron.pid");
    let supervisor: ChildProcess | null = null;
    let compilerPid: number | null = null;
    let vitePid: number | null = null;
    let electronPid: number | null = null;
    let output = "";

    try {
      await mkdir(scriptsDirectory, { recursive: true });
      await mkdir(binDirectory, { recursive: true });
      await writeFile(
        path.join(scriptsDirectory, "dev.mjs"),
        await readFile(path.resolve("scripts/dev.mjs"), "utf8"),
        "utf8"
      );
      await writeExecutable(
        path.join(binDirectory, "tsc"),
        fakeBlockingCompiler
      );
      await writeExecutable(path.join(binDirectory, "vite"), fakeVite);
      await writeExecutable(path.join(binDirectory, "electron"), fakeElectron);

      const port = await reservePort();
      supervisor = spawn(process.execPath, ["scripts/dev.mjs"], {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          VITE_DEV_SERVER_PORT: String(port),
          XL_AGENT_TEST_COMPILER_PID_PATH: compilerPidPath,
          XL_AGENT_TEST_VITE_PID_PATH: vitePidPath,
          XL_AGENT_TEST_ELECTRON_PID_PATH: electronPidPath
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      supervisor.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      supervisor.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });

      await waitUntil(async () => {
        try {
          compilerPid = Number(await readFile(compilerPidPath, "utf8"));
          return processIsAlive(compilerPid);
        } catch {
          return false;
        }
      }, 5_000, `The isolated compiler fixture did not start.\n${output}`);

      process.kill(supervisor.pid as number, "SIGHUP");
      await waitForExit(supervisor, 6_000);
      await waitUntil(
        () => !processIsAlive(compilerPid),
        2_000,
        "SIGHUP left the isolated compiler child running."
      );

      await new Promise((resolve) => setTimeout(resolve, 350));
      vitePid = await readPidFile(vitePidPath);
      electronPid = await readPidFile(electronPidPath);
      expect(
        vitePid,
        `Vite started after startup cancellation.\n${output}`
      ).toBeNull();
      expect(
        electronPid,
        `Electron started after startup cancellation.\n${output}`
      ).toBeNull();
    } finally {
      vitePid ??= await readPidFile(vitePidPath);
      electronPid ??= await readPidFile(electronPidPath);
      terminate(electronPid);
      terminate(vitePid);
      terminate(compilerPid);
      terminate(supervisor?.pid ?? null);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("forwards SIGHUP into a complete Vite and Electron shutdown", async () => {
    if (process.platform === "win32") return;

    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "xl-agent-dev-supervisor-")
    );
    const scriptsDirectory = path.join(fixtureRoot, "scripts");
    const binDirectory = path.join(fixtureRoot, "node_modules", ".bin");
    const vitePidPath = path.join(fixtureRoot, "vite.pid");
    const electronPidPath = path.join(fixtureRoot, "electron.pid");
    let supervisor: ChildProcess | null = null;
    let vitePid: number | null = null;
    let electronPid: number | null = null;
    let output = "";

    try {
      await mkdir(scriptsDirectory, { recursive: true });
      await mkdir(binDirectory, { recursive: true });
      await writeFile(
        path.join(scriptsDirectory, "dev.mjs"),
        await readFile(path.resolve("scripts/dev.mjs"), "utf8"),
        "utf8"
      );
      await writeExecutable(path.join(binDirectory, "tsc"), fakeCompiler);
      await writeExecutable(path.join(binDirectory, "vite"), fakeVite);
      await writeExecutable(path.join(binDirectory, "electron"), fakeElectron);

      const port = await reservePort();
      supervisor = spawn(process.execPath, ["scripts/dev.mjs"], {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          VITE_DEV_SERVER_PORT: String(port),
          XL_AGENT_TEST_VITE_PID_PATH: vitePidPath,
          XL_AGENT_TEST_ELECTRON_PID_PATH: electronPidPath
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      supervisor.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      supervisor.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });

      await waitUntil(async () => {
        try {
          vitePid = Number(await readFile(vitePidPath, "utf8"));
          electronPid = Number(await readFile(electronPidPath, "utf8"));
          return processIsAlive(vitePid) && processIsAlive(electronPid);
        } catch {
          return false;
        }
      }, 5_000, `The isolated development fixture did not start.\n${output}`);

      process.kill(supervisor.pid as number, "SIGHUP");
      await waitForExit(supervisor, 6_000);

      let childrenStopped = true;
      try {
        await waitUntil(
          () => !processIsAlive(vitePid) && !processIsAlive(electronPid),
          2_000,
          "SIGHUP left an isolated Vite or Electron child running."
        );
      } catch {
        childrenStopped = false;
      }

      expect(
        childrenStopped,
        `The supervisor exited without shutting down all children.\n${output}`
      ).toBe(true);
    } finally {
      terminate(electronPid);
      terminate(vitePid);
      terminate(supervisor?.pid ?? null);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
