import { execFile } from "node:child_process";
import path from "node:path";

export type AuthenticodeVerificationStatus =
  | "valid"
  | "invalid"
  | "unsigned"
  | "unavailable"
  | "not-applicable";

export type AuthenticodeVerificationResult = {
  status: AuthenticodeVerificationStatus;
  publisher: string | null;
  signerSubject: string | null;
  certificateThumbprint: string | null;
  statusMessage: string;
  checkedAt: string;
};

export interface AuthenticodeVerifier {
  verify(filePath: string): Promise<AuthenticodeVerificationResult>;
}

type PowerShellSignatureOutput = {
  Status?: unknown;
  StatusMessage?: unknown;
  Subject?: unknown;
  Thumbprint?: unknown;
};

export type WindowsAuthenticodeVerifierOptions = {
  platform?: NodeJS.Platform;
  now?: () => Date;
  run?: (
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv
  ) => Promise<string>;
};

const inspectionScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$signature = Get-AuthenticodeSignature -LiteralPath $env:XL_AGENT_SIGNATURE_FILE
[ordered]@{
  Status = [string]$signature.Status
  StatusMessage = [string]$signature.StatusMessage
  Subject = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Subject }
  Thumbprint = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Thumbprint }
} | ConvertTo-Json -Compress
`.trim();

function encodedPowerShellCommand(value: string) {
  return Buffer.from(value, "utf16le").toString("base64");
}

function defaultRun(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv
) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        env: environment,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        encoding: "utf8"
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function publisherFromSubject(subject: string | null) {
  if (!subject) return null;
  const commonName = subject.match(
    /(?:^|,\s*)CN=(?:"((?:[^"]|"")*)"|((?:\\,|[^,])*))/i
  );
  const value = (commonName?.[1] ?? commonName?.[2])?.trim();
  return value?.replace(/""/g, '"').replace(/\\,/g, ",") ?? subject;
}

function unavailable(message: string, checkedAt: string): AuthenticodeVerificationResult {
  return {
    status: "unavailable",
    publisher: null,
    signerSubject: null,
    certificateThumbprint: null,
    statusMessage: message,
    checkedAt
  };
}

/**
 * Windows-only, fixed-purpose Authenticode inspector.
 *
 * It does not expose PowerShell to the Agent or interpolate the artifact path
 * into a script. The executable and encoded script are fixed; the absolute
 * file path is passed only through a child-process environment variable.
 */
export class WindowsAuthenticodeVerifier implements AuthenticodeVerifier {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly run: NonNullable<WindowsAuthenticodeVerifierOptions["run"]>;

  constructor(options: WindowsAuthenticodeVerifierOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.run = options.run ?? defaultRun;
  }

  async verify(filePath: string): Promise<AuthenticodeVerificationResult> {
    const checkedAt = this.now().toISOString();
    if (this.platform !== "win32") {
      return unavailable("Authenticode 仅能在 Windows 主机上通过系统信任策略校验。", checkedAt);
    }
    if (!path.isAbsolute(filePath)) {
      return unavailable("签名校验拒绝非绝对文件路径。", checkedAt);
    }

    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const executable = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const environment: NodeJS.ProcessEnv = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      XL_AGENT_SIGNATURE_FILE: filePath
    };

    try {
      const stdout = await this.run(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encodedPowerShellCommand(inspectionScript)
        ],
        environment
      );
      const parsed = JSON.parse(stdout.trim()) as PowerShellSignatureOutput;
      const nativeStatus = optionalString(parsed.Status);
      const signerSubject = optionalString(parsed.Subject);
      const statusMessage =
        optionalString(parsed.StatusMessage) ??
        (nativeStatus ? `Windows Authenticode 状态：${nativeStatus}` : "Windows 未返回签名状态。");
      return {
        status:
          nativeStatus === "Valid"
            ? "valid"
            : nativeStatus === "NotSigned"
              ? "unsigned"
              : "invalid",
        publisher: publisherFromSubject(signerSubject),
        signerSubject,
        certificateThumbprint: optionalString(parsed.Thumbprint),
        statusMessage,
        checkedAt
      };
    } catch (error) {
      return unavailable(
        error instanceof Error ? `Windows 签名校验不可用：${error.message}` : "Windows 签名校验不可用。",
        checkedAt
      );
    }
  }
}

export function publisherMatches(actual: string | null, expected: string) {
  const normalize = (value: string) =>
    value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
  const actualNormalized = actual ? normalize(actual) : "";
  const expectedNormalized = normalize(expected);
  return Boolean(actualNormalized && expectedNormalized && actualNormalized === expectedNormalized);
}
