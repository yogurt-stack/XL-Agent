import { describe, expect, it } from "vitest";
import {
  inspectLocalDevelopmentEnvironment,
  type FixedCommandRunner
} from "./localDevelopmentEnvironment";

describe("local development environment inspection", () => {
  it("runs only the fixed version command allowlist and normalizes safe output", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const signals: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    const outputs: Record<string, string> = {
      node: "v22.20.0\n",
      npm: "10.9.3\n",
      python3: "Python 3.10.8\n",
      pip3: "pip 22.2.2 from /private/user/path/site-packages/pip (python 3.10)\n",
      git: "git version 2.39.5 (Apple Git-154)\n"
    };
    const runCommand: FixedCommandRunner = async (executable, args, signal) => {
      calls.push({ executable, args });
      signals.push(signal);
      const stdout = outputs[executable];
      if (stdout) return { stdout, stderr: "" };
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };

    const output = await inspectLocalDevelopmentEnvironment({
      platform: "darwin",
      architecture: "arm64",
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      runCommand,
      signal: controller.signal
    });

    expect(calls).toHaveLength(13);
    expect(signals).toEqual(Array(13).fill(controller.signal));
    expect(calls).toContainEqual({ executable: "node", args: ["--version"] });
    expect(calls).toContainEqual({ executable: "nvcc", args: ["--version"] });
    expect(calls).toContainEqual({ executable: "cmake", args: ["--version"] });
    expect(calls).toContainEqual({ executable: "qmake", args: ["-query", "QT_VERSION"] });
    expect(calls).toContainEqual({ executable: "pkg-config", args: ["--modversion", "opencascade"] });
    expect(output).toMatchObject({
      host: { platform: "darwin", architecture: "arm64" },
      collectedAt: "2026-08-07T00:00:00.000Z",
      source: "electron-main-fixed-command-allowlist",
      boundary: "read-only-fixed-command-allowlist"
    });
    expect(output.tools.find((tool) => tool.id === "node")).toMatchObject({
      status: "available",
      version: "v22.20.0"
    });
    expect(output.tools.find((tool) => tool.id === "pip3")).toMatchObject({
      status: "available",
      version: "22.2.2",
      detail: "Python 3.10"
    });
    expect(JSON.stringify(output)).not.toContain("/private/user/path");
    expect(output.tools.find((tool) => tool.id === "cuda-compiler")).toMatchObject({
      status: "not_applicable",
      version: null
    });
  });

  it("stops the fixed probes when their caller aborts", async () => {
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const runCommand: FixedCommandRunner = (_executable, _args, signal) =>
      new Promise((resolve, reject) => {
        notifyStarted();
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
        void resolve;
      });

    const inspection = inspectLocalDevelopmentEnvironment({
      platform: "linux",
      architecture: "x64",
      runCommand,
      signal: controller.signal
    });
    await started;
    controller.abort();

    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
  });

  it("parses CUDA compiler and NVIDIA driver versions without a shell", async () => {
    const runCommand: FixedCommandRunner = async (executable) => {
      if (executable === "nvcc") {
        return {
          stdout: "Cuda compilation tools, release 12.6, V12.6.85\n",
          stderr: ""
        };
      }
      if (executable === "nvidia-smi") {
        return {
          stdout: "NVIDIA RTX 4090, 560.35, 8.9\n",
          stderr: ""
        };
      }
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };

    const output = await inspectLocalDevelopmentEnvironment({
      platform: "linux",
      architecture: "x64",
      runCommand
    });

    expect(output.tools.find((tool) => tool.id === "cuda-compiler")).toMatchObject({
      status: "available",
      version: "CUDA 12.6",
      detail: "编译器 V12.6.85"
    });
    expect(output.tools.find((tool) => tool.id === "nvidia-gpu")).toMatchObject({
      status: "available",
      version: "NVIDIA RTX 4090",
      detail: "驱动 560.35 · 计算能力 8.9"
    });
  });
});
