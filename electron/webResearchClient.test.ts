import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  WebResearchClient,
  extractPage,
  fetchPublicPage,
  isPublicIpv4,
} from "./webResearchClient";

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ request: network.request }));

const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });

describe("public web providers", () => {
  it("pins the validated DNS address and checks redirect destinations again", async () => {
    network.lookup
      .mockResolvedValueOnce([{ address: "140.82.112.4", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    network.request.mockImplementationOnce((_url, options, respond) => {
      const callback = vi.fn();
      options.lookup("untrusted-dns-change", { all: false }, callback);
      expect(callback).toHaveBeenCalledWith(null, "140.82.112.4", 4);
      const req = new EventEmitter() as EventEmitter & { end(): void };
      req.end = () => {
        respond({
          statusCode: 302,
          headers: { location: "https://redirect.attacker.com/private" },
          resume() {},
        });
      };
      return req;
    });
    await expect(
      fetchPublicPage(
        "https://github.com/acme/repo",
        new AbortController().signal,
      ),
    ).rejects.toThrow("非公网");
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it("does not wait indefinitely for DNS after cancellation", async () => {
    network.lookup.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = fetchPublicPage(
      "https://github.com/acme/repo",
      controller.signal,
    );
    controller.abort(new Error("cancelled during DNS"));
    await expect(pending).rejects.toThrow("cancelled during DNS");
    expect(network.request).not.toHaveBeenCalled();
  });
  it("preserves multilingual queries and sends credentials only to the fixed Tavily endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        results: [
          {
            title: "Project",
            url: "https://github.com/acme/project#readme",
            content: "Windows 离线中文",
          },
          {
            title: "Duplicate",
            url: "https://github.com/acme/project",
            content: "",
          },
          { title: "Private", url: "http://127.0.0.1/secrets", content: "" },
          { title: "Script", url: "javascript:alert(1)", content: "" },
        ],
      }),
    );
    const client = new WebResearchClient(
      { XL_AGENT_TAVILY_API_KEY: "test-secret" },
      fetcher,
    );
    const result = await client.search({
      query: "Windows 离线 中文 RAG site:github.com",
      limit: 5,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://github.com/acme/project");
    expect(fetcher.mock.calls[0][0]).toBe("https://api.tavily.com/search");
    const init = fetcher.mock.calls[0][1]!;
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toMatchObject({
      query: "Windows 离线 中文 RAG site:github.com",
      include_answer: false,
    });
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });

  it("uses SearXNG JSON without transmitting the Tavily key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ results: [] }));
    const client = new WebResearchClient(
      {
        XL_AGENT_SEARCH_PROVIDER: "searxng",
        XL_AGENT_SEARXNG_URL: "http://127.0.0.1:8080",
        XL_AGENT_TAVILY_API_KEY: "unused",
      },
      fetcher,
    );
    const result = await client.search({ query: "中文搜索", limit: 3 });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("中文搜索");
    expect(url.searchParams.get("format")).toBe("json");
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).has("authorization"),
    ).toBe(false);
    expect(result.results).toEqual([]);
  });

  it("reports configuration and provider errors without leaking response bodies or keys", async () => {
    const missing = new WebResearchClient({});
    await expect(missing.search({ query: "test", limit: 5 })).rejects.toThrow(
      "XL_AGENT_TAVILY_API_KEY",
    );
    const client = new WebResearchClient(
      { XL_AGENT_TAVILY_API_KEY: "secret" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("secret internal error", { status: 429 }),
        ),
    );
    await expect(client.search({ query: "test", limit: 5 })).rejects.toThrow(
      "服务限流",
    );
  });

  it("extracts bounded text and links without executing scripts", async () => {
    const page = extractPage({
      url: "https://docs.python.org/3/",
      contentType: "text/html",
      content:
        '<html><head><title>Offline guide</title><script>stealCredentials()</script></head><body><main><h1>Guide</h1><p>Install locally and run offline.</p><a href="tutorial/">Tutorial</a><a href="http://localhost/private">Private</a></main></body></html>',
    });
    expect(page.content).toContain("run offline");
    expect(page.content).not.toContain("stealCredentials");
    expect(page.links).toEqual(["https://docs.python.org/3/tutorial/"]);
    expect(page.trust).toBe("untrusted-web-content");
    const large = extractPage({
      url: "https://docs.python.org/3/",
      contentType: "text/plain",
      content: "a".repeat(30000),
    });
    expect(large.content).toHaveLength(24000);
    expect(large.truncated).toBe(true);
  });

  it("bounds Tavily extraction and reports unreadable pages", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          results: [
            {
              url: "https://docs.python.org/3/",
              raw_content:
                "# Docs\n[GitHub](https://github.com/python/cpython)\n" +
                "a".repeat(26000),
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ results: [], failed_results: [{ error: "blocked" }] }),
      );
    const client = new WebResearchClient(
      { XL_AGENT_TAVILY_API_KEY: "key" },
      fetcher,
    );
    const page = await client.readPage({ url: "https://docs.python.org/3/" });
    expect(page.content).toHaveLength(24000);
    expect(page.truncated).toBe(true);
    expect(page.links).toContain("https://github.com/python/cpython");
    await expect(
      client.readPage({ url: "https://docs.python.org/3/" }),
    ).rejects.toThrow("正文提取失败");
  });

  it("rejects local addresses, metadata networks and invalid page protocols", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "198.19.0.1",
      "224.0.0.1",
    ])
      expect(isPublicIpv4(ip)).toBe(false);
    expect(isPublicIpv4("140.82.112.4")).toBe(true);
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "file:///etc/passwd",
      "https://user:pass@github.com/",
    ])
      await expect(
        fetchPublicPage(url, new AbortController().signal),
      ).rejects.toThrow();
  });

  it("propagates cancellation and caps provider response bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        init?.signal?.throwIfAborted();
        return response({ results: [], padding: "a".repeat(2 * 1024 * 1024) });
      });
    const client = new WebResearchClient(
      { XL_AGENT_TAVILY_API_KEY: "key" },
      fetcher,
    );
    await expect(
      client.search(
        { query: "test", limit: 5 },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    await expect(client.search({ query: "test", limit: 5 })).rejects.toThrow(
      "大小上限",
    );
  });
});
