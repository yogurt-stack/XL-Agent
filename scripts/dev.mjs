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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: isWindows
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function waitForPort({ host, port, timeoutMs = 30000 }) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        resolve();
      });

      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(check, 250);
      });
    };

    check();
  });
}

let vite;
let electron;

function stop() {
  if (electron && !electron.killed) {
    electron.kill();
  }
  if (vite && !vite.killed) {
    vite.kill();
  }
}

process.on("SIGINT", () => {
  stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});

try {
  await run(tscBin, ["-p", "electron/tsconfig.json"]);

  vite = spawn(viteBin, ["--host", host, "--port", String(port), "--strictPort"], {
    stdio: "inherit",
    shell: isWindows
  });

  await waitForPort({ host, port });
  electron = spawn(electronBin, ["."], {
    stdio: "inherit",
    shell: isWindows,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devServerUrl
    }
  });

  electron.on("exit", (code) => {
    stop();
    process.exit(code ?? 0);
  });
} catch (error) {
  stop();
  console.error(error);
  process.exit(1);
}
