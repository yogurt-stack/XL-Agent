import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubRepositorySearchClient,
  type GitHubFetch
} from "./githubClient";

function repository(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 1,
    full_name: "openai/example",
    html_url: "https://github.com/openai/example",
    description: "Example repository",
    stargazers_count: 1200,
    forks_count: 120,
    open_issues_count: 8,
    language: "TypeScript",
    topics: ["agent", "typescript"],
    license: {
      key: "mit",
      name: "MIT License",
      spdx_id: "MIT"
    },
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
    pushed_at: "2026-07-29T00:00:00.000Z",
    private: false,
    fork: false,
    archived: false,
    ...overrides
  };
}

describe("GitHubRepositorySearchClient", () => {
  it("uses the fixed GitHub endpoint, sanitizes qualifiers and filters non-open-source repositories", async () => {
    let capturedInput: string | URL | Request | null = null;
    let capturedInit: RequestInit | undefined;
    const fetchRequest: GitHubFetch = async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return new Response(JSON.stringify({
        total_count: 3,
        incomplete_results: false,
        items: [
          repository(),
          repository({
            id: 2,
            full_name: "closed/no-license",
            html_url: "https://github.com/closed/no-license",
            license: null
          }),
          repository({
            id: 3,
            full_name: "forked/example",
            html_url: "https://github.com/forked/example",
            fork: true
          })
        ]
      }), {
        status: 200,
        headers: {
          "x-ratelimit-remaining": "29",
          "x-ratelimit-reset": "1785373200"
        }
      });
    };
    const client = new GitHubRepositorySearchClient(
      { XL_AGENT_GITHUB_TOKEN: "secret-token" },
      fetchRequest,
      () => new Date("2026-07-30T12:00:00.000Z")
    );

    const result = await client.search({
      mode: "discovery",
      keywords: "TypeScript stars:>9999",
      createdWithinDays: 30,
      sort: "stars",
      limit: 10
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.repositories).toHaveLength(1);
    expect(result.output.repositories[0]).toMatchObject({
      fullName: "openai/example",
      license: { spdxId: "MIT" }
    });
    expect(result.output.criteria).toMatchObject({
      keywords: "TypeScript stars 9999",
      createdAfter: "2026-06-30",
      sort: "stars"
    });
    expect(result.output.rateLimit.remaining).toBe(29);
    expect(result.output.authenticated).toBe(true);

    const url = new URL(String(capturedInput));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.github.com/search/repositories"
    );
    expect(url.searchParams.get("q")).toContain(
      "created:>=2026-06-30 is:public archived:false fork:false"
    );
    expect(url.searchParams.get("q")).not.toContain("stars:>9999");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe(
      "Bearer secret-token"
    );
  });

  it("supports unauthenticated public search", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchRequest: GitHubFetch = async (_input, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [repository()]
      }), { status: 200 });
    };
    const client = new GitHubRepositorySearchClient(
      {},
      fetchRequest,
      () => new Date("2026-07-30T12:00:00.000Z")
    );
    const result = await client.search({
      mode: "discovery",
      keywords: "",
      createdWithinDays: 7,
      sort: "updated",
      limit: 10
    });

    expect(result.ok).toBe(true);
    expect(new Headers(capturedInit?.headers).has("authorization")).toBe(false);
  });

  it("searches by repository name and ranks an exact name match first", async () => {
    let capturedInput: string | URL | Request | null = null;
    const fetchRequest: GitHubFetch = async (input) => {
      capturedInput = input;
      return new Response(JSON.stringify({
        total_count: 2,
        incomplete_results: false,
        items: [
          repository({
            id: 2,
            full_name: "example/tau-toolkit",
            html_url: "https://github.com/example/tau-toolkit",
            stargazers_count: 2000
          }),
          repository({
            id: 3,
            full_name: "owner/tau",
            html_url: "https://github.com/owner/tau",
            stargazers_count: 20
          })
        ]
      }), { status: 200 });
    };
    const client = new GitHubRepositorySearchClient({}, fetchRequest);

    const result = await client.search({
      mode: "name",
      query: "tau",
      limit: 10
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.criteria).toEqual({
      mode: "name",
      query: "tau",
      match: "repository-name",
      order: "best-match",
      licenseRequired: true
    });
    expect(result.output.repositories.map((item) => item.fullName)).toEqual([
      "owner/tau",
      "example/tau-toolkit"
    ]);
    const url = new URL(String(capturedInput));
    expect(url.searchParams.get("q")).toBe(
      "tau in:name is:public archived:false fork:false"
    );
    expect(url.searchParams.has("sort")).toBe(false);
  });

  it("uses a bounded repo qualifier for an exact owner/repo lookup", async () => {
    let capturedInput: string | URL | Request | null = null;
    const fetchRequest: GitHubFetch = async (input) => {
      capturedInput = input;
      return new Response(JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [repository({
          full_name: "openai/tau",
          html_url: "https://github.com/openai/tau"
        })]
      }), { status: 200 });
    };
    const client = new GitHubRepositorySearchClient({}, fetchRequest);

    const result = await client.search({
      mode: "exact",
      fullName: "openai/tau",
      limit: 1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.repositories[0]?.fullName).toBe("openai/tau");
    expect(result.output.criteria).toMatchObject({
      mode: "exact",
      fullName: "openai/tau",
      match: "exact"
    });
    expect(new URL(String(capturedInput)).searchParams.get("q")).toBe(
      "repo:openai/tau is:public archived:false fork:false"
    );
  });

  it("maps rate-limit responses without leaking the configured token", async () => {
    const fetchRequest: GitHubFetch = async () =>
      new Response(JSON.stringify({
        message: "API rate limit exceeded for token secret-token"
      }), {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1785373200"
        }
      });
    const client = new GitHubRepositorySearchClient(
      { XL_AGENT_GITHUB_TOKEN: "secret-token" },
      fetchRequest,
      () => new Date("2026-07-30T12:00:00.000Z")
    );
    const result = await client.search({
      mode: "discovery",
      keywords: "",
      createdWithinDays: 90,
      sort: "forks",
      limit: 10
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "GITHUB_RATE_LIMITED",
        retriable: true
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("pins a repository commit and creates optional npm tarballs only from a complete lockfile", async () => {
    const tarball = Buffer.from("locked npm package");
    const integrity = createHash("sha512").update(tarball).digest("base64");
    const lockfile = {
      name: "example",
      lockfileVersion: 3,
      packages: {
        "": { name: "example", version: "1.0.0" },
        "node_modules/left-pad": {
          name: "left-pad",
          version: "1.3.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          integrity: `sha512-${integrity}`,
          license: "WTFPL",
          dev: true
        }
      }
    };
    const fetchRequest: GitHubFetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/openai/example") {
        return new Response(JSON.stringify({
          full_name: "openai/example",
          html_url: "https://github.com/openai/example",
          description: "Example",
          default_branch: "main",
          size: 100,
          private: false,
          fork: false,
          archived: false,
          license: { name: "MIT License", spdx_id: "MIT" }
        }), { status: 200 });
      }
      if (url.pathname === "/repos/openai/example/commits/main") {
        return new Response(JSON.stringify({
          sha: "a".repeat(40),
          commit: { tree: { sha: "b".repeat(40) } }
        }), { status: 200 });
      }
      if (url.pathname === `/repos/openai/example/git/trees/${"b".repeat(40)}`) {
        return new Response(JSON.stringify({
          truncated: false,
          tree: [
            {
              path: "package.json",
              type: "blob",
              sha: "c".repeat(40),
              size: 100
            },
            {
              path: "package-lock.json",
              type: "blob",
              sha: "d".repeat(40),
              size: Buffer.byteLength(JSON.stringify(lockfile))
            }
          ]
        }), { status: 200 });
      }
      if (url.pathname === `/repos/openai/example/git/blobs/${"d".repeat(40)}`) {
        const content = Buffer.from(JSON.stringify(lockfile)).toString("base64");
        return new Response(JSON.stringify({
          encoding: "base64",
          content,
          size: Buffer.byteLength(JSON.stringify(lockfile))
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const client = new GitHubRepositorySearchClient(
      {},
      fetchRequest,
      () => new Date("2026-07-30T12:00:00.000Z")
    );

    const result = await client.inspectRepository("openai/example");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resource.github).toMatchObject({
      fullName: "openai/example",
      commitSha: "a".repeat(40),
      analysis: {
        nodeOfflinePreparation: "package-lock-supported",
        nodeOfflinePackageCount: 1,
        nodeOfflineBlockers: []
      }
    });
    expect(result.resource.download.url).toBe(
      `https://codeload.github.com/openai/example/zip/${"a".repeat(40)}`
    );
    expect(result.dependencyResources).toHaveLength(1);
    expect(result.dependencyResources[0]).toMatchObject({
      selected: false,
      sourceTrust: "npm-lockfile",
      npm: {
        packageName: "left-pad",
        version: "1.3.0",
        integrity: `sha512-${integrity}`,
        license: "WTFPL",
        repositoryCommitSha: "a".repeat(40)
      },
      download: {
        digestPolicy: "lockfile-integrity",
        expectedIntegrity: {
          algorithm: "sha512",
          digestBase64: integrity
        }
      }
    });
  });
});
