import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import {
  publicWebUrl,
  webSearchInputSchema,
  webPageInputSchema,
  webSearchOutputSchema,
  webPageOutputSchema,
  type WebResearchTools,
  type WebSearchInput,
  type WebPageInput,
} from "../src/features/agent-core/webResearch";
import type { AgentToolExecutionOptions } from "../src/features/agent-core/interfaces";

export type WebResearchEnvironment = {
  XL_AGENT_SEARCH_PROVIDER?: string;
  XL_AGENT_TAVILY_API_KEY?: string;
  XL_AGENT_SEARXNG_URL?: string;
};
const maxBytes = 2 * 1024 * 1024;

export function isPublicIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  )
    return false;
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function publicAddress(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!publicWebUrl(url))
    throw new Error("网页地址不是允许的公开 HTTP(S) 地址。");
  // Resolve once, reject mixed public/private answers, and pin this address to the socket.
  const answers = await new Promise<Array<{ address: string; family: number }>>(
    (resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      lookup(new URL(url).hostname, { all: true, family: 4 })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", aborted));
    },
  );
  signal.throwIfAborted();
  if (!answers.length || answers.some((a) => !isPublicIpv4(a.address)))
    throw new Error("网页域名解析到了非公网地址，已拒绝读取。");
  return answers[0].address;
}

function requestSignal(options?: AgentToolExecutionOptions) {
  const remaining =
    options?.deadlineAt === undefined
      ? 25000
      : Math.max(1, Math.min(25000, options.deadlineAt - Date.now()));
  return AbortSignal.any([
    AbortSignal.timeout(remaining),
    ...(options?.signal ? [options.signal] : []),
  ]);
}

/** No scripts, cookies, credentials, downloads or arbitrary private-network access. */
export async function fetchPublicPage(
  url: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ url: string; content: string; contentType: string }> {
  if (redirects > 4) throw new Error("网页重定向次数过多。");
  const address = await publicAddress(url, signal);
  const response = await new Promise<{
    status: number;
    location?: string;
    contentType: string;
    content: string;
  }>((resolve, reject) => {
    const request = (url.startsWith("https:") ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        // Node may request all addresses during connection-family selection.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
        headers: {
          "user-agent": "XL-Agent/0.3 WebResearch",
          accept: "text/html, text/plain;q=0.9",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          resolve({
            status,
            location: res.headers.location,
            contentType,
            content: "",
          });
          return;
        }
        if (
          status < 200 ||
          status >= 300 ||
          !/^(text\/(html|plain)|application\/xhtml\+xml)\b/i.test(contentType)
        ) {
          res.destroy();
          reject(
            new Error(`网页无法提取：HTTP ${status}，仅支持 HTML 或纯文本。`),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes)
            res.destroy(new Error("网页超过 2 MiB 读取上限。"));
          else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status,
            contentType,
            content: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
  if (response.location)
    return fetchPublicPage(
      new URL(response.location, url).toString(),
      signal,
      redirects + 1,
    );
  if (response.status >= 300) throw new Error("网页重定向没有提供有效目标。");
  return { url, content: response.content, contentType: response.contentType };
}

function safeLinks(values: string[], base: string) {
  const urls = values.flatMap((value) => {
    try {
      const url = publicWebUrl(new URL(value, base).toString());
      return url ? [url] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(urls)].slice(0, 30);
}

export function extractPage(page: {
  url: string;
  content: string;
  contentType: string;
}) {
  let title = new URL(page.url).hostname;
  let content = page.content;
  let links: string[] = [];
  if (!page.contentType.startsWith("text/plain")) {
    const { document } = parseHTML(page.content);
    title = document.querySelector("title")?.textContent?.trim() || title;
    for (const element of document.querySelectorAll(
      "script,style,noscript,iframe,form,svg",
    ))
      element.remove();
    links = safeLinks(
      [...document.querySelectorAll("a[href]")].map(
        (a) => a.getAttribute("href") ?? "",
      ),
      page.url,
    );
    const fallback =
      document.querySelector("main,article")?.textContent ||
      document.body?.textContent ||
      "";
    const article = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
      { maxElemsToParse: 30000, disableJSONLD: true },
    ).parse();
    content = article?.textContent || fallback;
  }
  content = content
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!content)
    throw new Error("网页没有可读取正文，可能需要登录或 JavaScript 渲染。");
  return webPageOutputSchema.parse({
    url: page.url,
    title: title.slice(0, 500),
    content: content.slice(0, 24000),
    links,
    fetchedAt: new Date().toISOString(),
    truncated: content.length > 24000,
    trust: "untrusted-web-content",
  });
}

export class WebResearchClient implements WebResearchTools {
  constructor(
    private readonly environment: WebResearchEnvironment = process.env,
    private readonly fetchRequest: typeof fetch = fetch,
    private readonly readPublicPage = fetchPublicPage,
  ) {}

  private provider() {
    const provider =
      this.environment.XL_AGENT_SEARCH_PROVIDER?.trim() || "tavily";
    if (provider !== "tavily" && provider !== "searxng")
      throw new Error("XL_AGENT_SEARCH_PROVIDER 仅支持 tavily 或 searxng。");
    return provider;
  }

  private async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchRequest(url, {
      ...init,
      redirect: "error",
      signal,
    });
    if (!response.ok)
      throw new Error(
        `搜索服务 HTTP ${response.status}。${response.status === 401 || response.status === 403 ? "请检查服务密钥或 SearXNG JSON 输出配置。" : response.status === 429 ? "服务限流，请稍后重试。" : "请检查服务状态。"}`,
      );
    if (!response.body) throw new Error("搜索服务返回空响应。");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("搜索服务响应超过大小上限。");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("搜索服务返回了无法解析的 JSON。");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("搜索服务响应格式错误。");
    return data as Record<string, unknown>;
  }

  private tavily(
    path: "search" | "extract",
    body: unknown,
    signal: AbortSignal,
  ) {
    const key = this.environment.XL_AGENT_TAVILY_API_KEY?.trim();
    if (!key)
      throw new Error(
        "尚未配置网页搜索：请设置 XL_AGENT_TAVILY_API_KEY，或选择 searxng 并设置 XL_AGENT_SEARXNG_URL，然后重启应用。",
      );
    return this.json(
      `https://api.tavily.com/${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  async search(input: WebSearchInput, options?: AgentToolExecutionOptions) {
    const { query, limit } = webSearchInputSchema.parse(input);
    const signal = requestSignal(options);
    const provider = this.provider();
    let data: Record<string, unknown>;
    if (provider === "tavily") {
      data = await this.tavily(
        "search",
        {
          query,
          max_results: limit,
          search_depth: "advanced",
          include_answer: false,
          include_raw_content: false,
        },
        signal,
      );
    } else {
      const base = this.environment.XL_AGENT_SEARXNG_URL?.trim();
      if (!base) throw new Error("尚未设置 XL_AGENT_SEARXNG_URL。");
      const url = new URL(
        base.endsWith("/") ? `${base}search` : `${base}/search`,
      );
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("SearXNG 配置必须是无凭据的 HTTP(S) 基础地址。");
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      data = await this.json(
        url.toString(),
        { headers: { accept: "application/json" } },
        signal,
      );
    }
    if (!Array.isArray(data.results))
      throw new Error("搜索服务未返回 results 数组；请检查 API 配置。");
    const seen = new Set<string>();
    const results = data.results
      .flatMap((raw: unknown) => {
        if (!raw || typeof raw !== "object") return [];
        const item = raw as Record<string, unknown>;
        const url =
          typeof item.url === "string" ? publicWebUrl(item.url) : null;
        if (!url || seen.has(url)) return [];
        seen.add(url);
        return [
          {
            url,
            title: String(item.title ?? url).slice(0, 500),
            snippet: String(item.content ?? "").slice(0, 2000),
          },
        ];
      })
      .slice(0, limit);
    return webSearchOutputSchema.parse({
      query,
      provider,
      results,
      fetchedAt: new Date().toISOString(),
      trust: "untrusted-web-content",
    });
  }

  async readPage(input: WebPageInput, options?: AgentToolExecutionOptions) {
    const { url: rawUrl } = webPageInputSchema.parse(input);
    const url = publicWebUrl(rawUrl)!;
    const signal = requestSignal(options);
    if (this.provider() === "searxng")
      return extractPage(await this.readPublicPage(url, signal));
    const data = await this.tavily(
      "extract",
      { urls: [url], format: "markdown", extract_depth: "basic" },
      signal,
    );
    const result = Array.isArray(data.results)
      ? (data.results[0] as Record<string, unknown> | undefined)
      : undefined;
    if (
      !result ||
      typeof result.raw_content !== "string" ||
      !result.raw_content.trim()
    )
      throw new Error("正文提取失败，页面可能不可访问、需要登录或不支持提取。");
    const resolvedUrl =
      typeof result.url === "string" ? publicWebUrl(result.url) : url;
    if (!resolvedUrl) throw new Error("正文服务返回非公网地址。");
    const content = result.raw_content.trim();
    const links = safeLinks(
      [...content.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((m) => m[1]),
      resolvedUrl,
    );
    return webPageOutputSchema.parse({
      url: resolvedUrl,
      title: String(result.title ?? new URL(resolvedUrl).hostname).slice(
        0,
        500,
      ),
      content: content.slice(0, 24000),
      links,
      fetchedAt: new Date().toISOString(),
      truncated: content.length > 24000,
      trust: "untrusted-web-content",
    });
  }
}
