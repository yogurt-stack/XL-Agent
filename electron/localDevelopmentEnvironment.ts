import { execFile } from "node:child_process";
import type {
  DevelopmentEnvironmentToolId,
  DevelopmentEnvironmentToolVersion,
  HostArchitecture,
  HostPlatform,
  LocalDevelopmentEnvironmentOutput
} from "../src/features/agent-core/types";

type FixedCommand = {
  id: DevelopmentEnvironmentToolId;
  name: string;
  executable: string;
  args: string[];
  parse: (stdout: string, stderr: string) => {
    version: string;
    detail: string | null;
  };
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

export type FixedCommandRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal
) => Promise<CommandResult>;

export type LocalDevelopmentEnvironmentInspectionOptions = {
  platform?: NodeJS.Platform;
  architecture?: string;
  now?: () => Date;
  runCommand?: FixedCommandRunner;
  signal?: AbortSignal;
};

function compact(value: string, maxLength = 500) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function firstLine(stdout: string, stderr: string) {
  return compact(stdout || stderr).split(/\r?\n/u)[0] ?? "";
}

function simpleVersion(stdout: string, stderr: string) {
  return { version: firstLine(stdout, stderr), detail: null };
}

function pipVersion(stdout: string, stderr: string) {
  const text = compact(stdout || stderr);
  const match = text.match(/^pip\s+([^\s]+).*\(python\s+([^\s)]+)\)/iu);
  return match
    ? { version: match[1], detail: `Python ${match[2]}` }
    : { version: firstLine(stdout, stderr), detail: null };
}

function cudaVersion(stdout: string, stderr: string) {
  const text = compact(`${stdout} ${stderr}`);
  const match = text.match(/release\s+([^,\s]+),\s+V([^\s]+)/iu);
  return match
    ? { version: `CUDA ${match[1]}`, detail: `编译器 V${match[2]}` }
    : { version: firstLine(stdout, stderr), detail: null };
}

function nvidiaGpuVersion(stdout: string, stderr: string) {
  const text = firstLine(stdout, stderr);
  const [name, driver, computeCapability] = text
    .split(",")
    .map((value) => value.trim());
  if (!name) return { version: text, detail: null };
  return {
    version: name,
    detail: [
      driver ? `驱动 ${driver}` : null,
      computeCapability ? `计算能力 ${computeCapability}` : null
    ].filter(Boolean).join(" · ") || null
  };
}

function executableName(name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return name;
  if (name === "npm") return "npm.cmd";
  return `${name}.exe`;
}

function fixedCommands(platform: NodeJS.Platform): FixedCommand[] {
  return [
    {
      id: "node",
      name: "Node.js",
      executable: executableName("node", platform),
      args: ["--version"],
      parse: simpleVersion
    },
    {
      id: "npm",
      name: "npm",
      executable: executableName("npm", platform),
      args: ["--version"],
      parse: simpleVersion
    },
    {
      id: "python3",
      name: "Python 3",
      executable: executableName("python3", platform),
      args: ["--version"],
      parse: simpleVersion
    },
    {
      id: "python",
      name: "Python",
      executable: executableName("python", platform),
      args: ["--version"],
      parse: simpleVersion
    },
    {
      id: "py",
      name: "Python Launcher",
      executable: executableName("py", platform),
      args: ["--version"],
      parse: simpleVersion
    },
    {
      id: "pip3",
      name: "pip3",
      executable: executableName("pip3", platform),
      args: ["--version"],
      parse: pipVersion
    },
    {
      id: "pip",
      name: "pip",
      executable: executableName("pip", platform),
      args: ["--version"],
      parse: pipVersion
    },
    {
      id: "git",
      name: "Git",
      executable: executableName("git", platform),
      args: ["--version"],
      parse: simpleVersion
    },
    {
      id: "cmake",
      name: "CMake",
      executable: executableName("cmake", platform),
      args: ["--version"],
      parse: simpleVersion
    },
    {
      id: "qt",
      name: "Qt / qmake",
      executable: executableName("qmake", platform),
      args: ["-query", "QT_VERSION"],
      parse: simpleVersion
    },
    {
      id: "occt",
      name: "Open CASCADE (pkg-config)",
      executable: executableName("pkg-config", platform),
      args: ["--modversion", "opencascade"],
      parse: simpleVersion
    },
    {
      id: "cuda-compiler",
      name: "CUDA Compiler",
      executable: executableName("nvcc", platform),
      args: ["--version"],
      parse: cudaVersion
    },
    {
      id: "nvidia-gpu",
      name: "NVIDIA GPU / Driver",
      executable: executableName("nvidia-smi", platform),
      args: [
        "--query-gpu=name,driver_version,compute_cap",
        "--format=csv,noheader"
      ],
      parse: nvidiaGpuVersion
    }
  ];
}

function normalizePlatform(platform: NodeJS.Platform): HostPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : "unknown";
}

function normalizeArchitecture(architecture: string): HostArchitecture {
  return architecture === "x64" || architecture === "arm64"
    ? architecture
    : "other";
}

function fixedProbeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "LANG",
    "LC_ALL",
    "TEMP",
    "TMP",
    "TMPDIR"
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

const defaultCommandRunner: FixedCommandRunner = (executable, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        // Do not inherit NODE_OPTIONS, PYTHONPATH, npm/git injection variables,
        // credentials or unrelated application secrets into version probes.
        env: fixedProbeEnvironment(),
        signal
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });

function unavailableTool(
  command: FixedCommand,
  platform: NodeJS.Platform,
  error: unknown
): DevelopmentEnvironmentToolVersion {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const isAppleCuda =
    platform === "darwin" &&
    (command.id === "cuda-compiler" || command.id === "nvidia-gpu");
  if (isAppleCuda && (code === "ENOENT" || code === "127")) {
    return {
      id: command.id,
      name: command.name,
      command: command.executable,
      status: "not_applicable",
      version: null,
      detail: "当前 macOS 主机未检测到 NVIDIA CUDA 工具链；Apple GPU 使用 Metal/MPS。"
    };
  }
  const notFound = code === "ENOENT" || code === "127";
  return {
    id: command.id,
    name: command.name,
    command: command.executable,
    status: notFound ? "not_found" : "error",
    version: null,
    detail: notFound ? "当前 Electron Main PATH 中未找到该命令。" : "版本探测命令执行失败。"
  };
}

/**
 * 只执行编译期固定的版本查询命令。该工具不接收模型命令、参数或路径，
 * 不启动登录 Shell，也不向模型返回环境变量内容或配置文件。
 */
export async function inspectLocalDevelopmentEnvironment(
  options: LocalDevelopmentEnvironmentInspectionOptions = {}
): Promise<LocalDevelopmentEnvironmentOutput> {
  if (options.signal?.aborted) {
    throw new DOMException("本地环境探测已取消。", "AbortError");
  }
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const commands = fixedCommands(platform);
  const tools = await Promise.all(
    commands.map(async (command): Promise<DevelopmentEnvironmentToolVersion> => {
      try {
        const { stdout, stderr } = await runCommand(
          command.executable,
          command.args,
          options.signal
        );
        const parsed = command.parse(stdout, stderr);
        if (!parsed.version) {
          return {
            id: command.id,
            name: command.name,
            command: command.executable,
            status: "error",
            version: null,
            detail: "命令成功返回，但没有可识别的版本信息。"
          };
        }
        return {
          id: command.id,
          name: command.name,
          command: command.executable,
          status: "available",
          version: parsed.version,
          detail: parsed.detail
        };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return unavailableTool(command, platform, error);
      }
    })
  );

  return {
    host: {
      platform: normalizePlatform(platform),
      architecture: normalizeArchitecture(architecture)
    },
    tools,
    collectedAt: (options.now ?? (() => new Date()))().toISOString(),
    source: "electron-main-fixed-command-allowlist",
    boundary: "read-only-fixed-command-allowlist"
  };
}
