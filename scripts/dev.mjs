import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const isWindows = process.platform === "win32";
const tscBin = path.join("node_modules", ".bin", isWindows ? "tsc.cmd" : "tsc");
const viteBin = path.join("node_modules", ".bin", isWindows ? "vite.cmd" : "vite");
const electronBin = path.join("node_modules", ".bin", isWindows ? "electron.cmd" : "electron");
const host = "127.0.0.1";
const requestedPort = Number(process.env.VITE_DEV_SERVER_PORT ?? 5173);
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 5173;
const devServerUrl = `http://${host}:${port}`;
const childExitTimeoutMs = 5000;
const supervisorParentPid = process.ppid;

let compiler;
let vite;
let electron;
let parentWatchTimer;
let shuttingDown = false;
let requestedExitCode = 0;
let shutdownPromise;

function assertStartupActive() {
  if (shuttingDown) {
    throw new Error("Development supervisor shutdown was requested during startup.");
  }
}

function childIsRunning(child) {
  return Boolean(
    child && child.exitCode === null && child.signalCode === null
  );
}

function exitDescription(name, code, signal) {
  if (signal) return `${name} exited with signal ${signal}`;
  return `${name} exited with code ${code ?? "unknown"}`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: isWindows
    });
    compiler = child;

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (compiler === child) compiler = undefined;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(exitDescription(`${command} ${args.join(" ")}`, code, signal)));
    });
  });
}

function assertPortAvailable({ host, port }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if (error && typeof error === "object" && error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Dev server port ${host}:${port} is already in use. ` +
            "Stop the previous npm run dev process or choose another VITE_DEV_SERVER_PORT."
          )
        );
        return;
      }
      reject(error);
    });

    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

function waitForPort({ host, port, signal, timeoutMs = 30000 }) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer;
    let socket;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.destroy();
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };

    const onAbort = () => {
      finish(reject, new Error(`Stopped waiting for ${host}:${port}`));
    };

    const check = () => {
      if (signal?.aborted) {
        onAbort();
        return;
      }

      socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        finish(resolve);
      });
      socket.once("error", () => {
        socket?.destroy();
        socket = undefined;
        if (Date.now() - startedAt > timeoutMs) {
          finish(reject, new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        retryTimer = setTimeout(check, 250);
      });
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

function waitForSpawnedVite(child, options) {
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort();
      callback(value);
    };

    const onError = (error) => {
      finish(reject, error);
    };

    const onExit = (code, signal) => {
      finish(reject, new Error(exitDescription("Vite", code, signal)));
    };

    child.once("error", onError);
    child.once("exit", onExit);
    void waitForPort({ ...options, signal: controller.signal }).then(
      () => {
        if (!childIsRunning(child)) {
          finish(
            reject,
            new Error(
              exitDescription("Vite", child.exitCode, child.signalCode)
            )
          );
          return;
        }
        finish(resolve);
      },
      (error) => finish(reject, error)
    );
  });
}

function waitForChildExit(child, timeoutMs) {
  if (!childIsRunning(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);

    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };

    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (!childIsRunning(child)) finish(true);
  });
}

async function terminateChild(child, name) {
  if (!childIsRunning(child)) return;

  const exited = waitForChildExit(child, childExitTimeoutMs);
  child.kill("SIGTERM");
  if (await exited) return;

  console.error(`${name} did not exit after SIGTERM; sending SIGKILL.`);
  const forceExited = waitForChildExit(child, childExitTimeoutMs);
  child.kill("SIGKILL");
  if (!(await forceExited)) {
    throw new Error(`${name} did not exit after SIGKILL.`);
  }
}

function shutdown(exitCode = 0) {
  if (exitCode !== 0 && requestedExitCode === 0) {
    requestedExitCode = exitCode;
  }
  if (shutdownPromise) return shutdownPromise;

  shuttingDown = true;
  if (parentWatchTimer) {
    clearInterval(parentWatchTimer);
    parentWatchTimer = undefined;
  }
  shutdownPromise = (async () => {
    const failures = [];
    for (const [child, name] of [
      [electron, "Electron"],
      [vite, "Vite"],
      [compiler, "TypeScript compiler"]
    ]) {
      try {
        await terminateChild(child, name);
      } catch (error) {
        failures.push(error);
        console.error(error);
      }
    }
    if (failures.length > 0 && requestedExitCode === 0) {
      requestedExitCode = 1;
    }
    process.exitCode = requestedExitCode;
  })();

  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

if (!isWindows) {
  process.on("SIGHUP", () => {
    void shutdown(0);
  });
  parentWatchTimer = setInterval(() => {
    if (
      !shuttingDown &&
      supervisorParentPid > 1 &&
      process.ppid !== supervisorParentPid
    ) {
      console.error("Dev supervisor parent exited; stopping Electron and Vite.");
      void shutdown(0);
    }
  }, 1000);
  parentWatchTimer.unref();
}

try {
  assertStartupActive();
  await assertPortAvailable({ host, port });
  assertStartupActive();
  await run(tscBin, ["-p", "electron/tsconfig.json"]);
  assertStartupActive();

  vite = spawn(viteBin, ["--host", host, "--port", String(port), "--strictPort"], {
    stdio: "inherit",
    shell: isWindows
  });

  vite.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`Vite failed: ${error instanceof Error ? error.message : error}`);
    void shutdown(1);
  });
  vite.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(exitDescription("Vite", code, signal));
    void shutdown(code && code > 0 ? code : 1);
  });

  await waitForSpawnedVite(vite, { host, port });
  assertStartupActive();
  electron = spawn(electronBin, ["."], {
    stdio: "inherit",
    shell: isWindows,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devServerUrl
    }
  });

  electron.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`Electron failed: ${error instanceof Error ? error.message : error}`);
    void shutdown(1);
  });
  electron.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) console.error(exitDescription("Electron", code, signal));
    void shutdown(code ?? (signal ? 1 : 0));
  });
} catch (error) {
  if (!shuttingDown) console.error(error);
  await shutdown(shuttingDown ? requestedExitCode : 1);
}
