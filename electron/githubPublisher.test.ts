import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitHubPublisher,
  type GitHubPublishFetch
} from "./githubPublisher";
import {
  inspectLocalRepository,
  type LocalRepositoryInspection
} from "./localRepository";

const tempRoots: string[] = [];

function git(rootPath: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd: rootPath }, (error) =>
      error ? reject(error) : resolve()
    );
  });
}

async function createRepository(
  fileName = "README.md"
): Promise<LocalRepositoryInspection> {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), "xunlei-publish-repo-")
  );
  tempRoots.push(rootPath);
  await git(rootPath, ["init"]);
  await git(rootPath, ["config", "user.name", "Agent Test"]);
  await git(rootPath, ["config", "user.email", "agent@example.test"]);
  await writeFile(path.join(rootPath, fileName), "publish me\n", "utf8");
  await git(rootPath, ["add", fileName]);
  await git(rootPath, ["commit", "-m", "initial"]);
  return inspectLocalRepository(rootPath, {
    createId: () => "source-handle",
    now: () => new Date("2026-07-30T12:00:00.000Z")
  });
}

function preparationFetch(
  requests: Array<{ path: string; method: string; authorization: string | null }>
): GitHubPublishFetch {
  return async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization")
    });
    if (url.pathname === "/user") {
      return new Response(JSON.stringify({ login: "agent-owner" }), {
        status: 200
      });
    }
    if (url.pathname === "/repos/agent-owner/new-repository") {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404
      });
    }
    return new Response("not found", { status: 404 });
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((rootPath) =>
      rm(rootPath, { recursive: true, force: true })
    )
  );
});

describe("GitHubPublisher", () => {
  it("requires a separate publish token and never falls back to the search token", async () => {
    const inspection = await createRepository();
    const publisher = new GitHubPublisher({
      XL_AGENT_GITHUB_PUBLISH_TOKEN: undefined
    });

    const result = await publisher.prepare(inspection, {
      repositoryName: "new-repository",
      visibility: "private"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "GITHUB_PUBLISH_NOT_CONFIGURED" }
    });
  });

  it("creates a fixed no-force plan only when the target does not exist", async () => {
    const inspection = await createRepository();
    const requests: Array<{
      path: string;
      method: string;
      authorization: string | null;
    }> = [];
    const publisher = new GitHubPublisher(
      { XL_AGENT_GITHUB_PUBLISH_TOKEN: "write-token" },
      preparationFetch(requests),
      () => new Date("2026-07-30T12:01:00.000Z"),
      () => "publish-id"
    );

    const result = await publisher.prepare(inspection, {
      repositoryName: "new-repository",
      visibility: "private",
      branch: "main",
      commitMessage: "Approved root commit"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      publishId: "github-publish-publishid",
      repositoryHandleId: "local-repo-sourcehandle",
      targetOwner: "agent-owner",
      targetRepository: "new-repository",
      targetVisibility: "private",
      targetBranch: "main",
      createRepository: true,
      force: false,
      fileCount: 1
    });
    expect(result.plan.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(requests).toEqual([
      {
        path: "/user",
        method: "GET",
        authorization: "Bearer write-token"
      },
      {
        path: "/repos/agent-owner/new-repository",
        method: "GET",
        authorization: "Bearer write-token"
      }
    ]);
  });

  it("rejects likely secret files before any GitHub request", async () => {
    const inspection = await createRepository(".env");
    let requested = false;
    const publisher = new GitHubPublisher(
      { XL_AGENT_GITHUB_PUBLISH_TOKEN: "write-token" },
      async () => {
        requested = true;
        return new Response("unexpected", { status: 500 });
      }
    );

    const result = await publisher.prepare(inspection, {
      repositoryName: "new-repository",
      visibility: "private"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "GITHUB_PUBLISH_SCOPE_REJECTED" }
    });
    expect(requested).toBe(false);
  });

  it("uploads committed Git blobs only after execution and creates a root ref", async () => {
    const inspection = await createRepository();
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    let blobIndex = 0;
    const fetchRequest: GitHubPublishFetch = async (input, init) => {
      const url = new URL(String(input));
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body
      });
      if (url.pathname === "/user") {
        return new Response(JSON.stringify({ login: "agent-owner" }), {
          status: 200
        });
      }
      if (
        url.pathname === "/repos/agent-owner/new-repository" &&
        init?.method === "GET"
      ) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404
        });
      }
      if (url.pathname === "/user/repos") {
        return new Response(
          JSON.stringify({
            name: "new-repository",
            full_name: "agent-owner/new-repository",
            html_url: "https://github.com/agent-owner/new-repository",
            private: true,
            owner: { login: "agent-owner" }
          }),
          { status: 201 }
        );
      }
      if (url.pathname.endsWith("/git/blobs")) {
        blobIndex += 1;
        return new Response(JSON.stringify({ sha: `${blobIndex}`.repeat(40) }), {
          status: 201
        });
      }
      if (url.pathname.endsWith("/git/trees")) {
        return new Response(JSON.stringify({ sha: "a".repeat(40) }), {
          status: 201
        });
      }
      if (url.pathname.endsWith("/git/commits")) {
        return new Response(JSON.stringify({ sha: "b".repeat(40) }), {
          status: 201
        });
      }
      if (url.pathname.endsWith("/git/refs")) {
        return new Response(JSON.stringify({ ref: "refs/heads/main" }), {
          status: 201
        });
      }
      return new Response("not found", { status: 404 });
    };
    const publisher = new GitHubPublisher(
      { XL_AGENT_GITHUB_PUBLISH_TOKEN: "write-token" },
      fetchRequest,
      () => new Date("2026-07-30T12:01:00.000Z"),
      () => "publish-id"
    );
    const prepared = await publisher.prepare(inspection, {
      repositoryName: "new-repository",
      visibility: "private",
      branch: "main"
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const result = await publisher.execute(prepared.plan, inspection);

    expect(result).toMatchObject({
      ok: true,
      output: {
        fullName: "agent-owner/new-repository",
        branch: "main",
        commitSha: "b".repeat(40),
        fileCount: 1
      }
    });
    const createRepositoryRequest = requests.find(
      (request) => request.path === "/user/repos"
    );
    expect(createRepositoryRequest?.body).toEqual({
      name: "new-repository",
      private: true,
      auto_init: false
    });
    const blobRequest = requests.find((request) =>
      request.path.endsWith("/git/blobs")
    );
    expect(
      Buffer.from(
        (blobRequest?.body as { content: string }).content,
        "base64"
      ).toString("utf8")
    ).toBe("publish me\n");
    expect(
      requests.find((request) => request.path.endsWith("/git/refs"))?.body
    ).toEqual({
      ref: "refs/heads/main",
      sha: "b".repeat(40)
    });
  });

  it("stops before uploading blobs when GitHub returns the wrong visibility", async () => {
    const inspection = await createRepository();
    let blobRequested = false;
    const fetchRequest: GitHubPublishFetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/user") {
        return new Response(JSON.stringify({ login: "agent-owner" }), {
          status: 200
        });
      }
      if (
        url.pathname === "/repos/agent-owner/new-repository" &&
        init?.method === "GET"
      ) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404
        });
      }
      if (url.pathname === "/user/repos") {
        return new Response(
          JSON.stringify({
            name: "new-repository",
            full_name: "agent-owner/new-repository",
            html_url: "https://github.com/agent-owner/new-repository",
            private: false,
            owner: { login: "agent-owner" }
          }),
          { status: 201 }
        );
      }
      if (url.pathname.endsWith("/git/blobs")) blobRequested = true;
      return new Response("unexpected", { status: 500 });
    };
    const publisher = new GitHubPublisher(
      { XL_AGENT_GITHUB_PUBLISH_TOKEN: "write-token" },
      fetchRequest,
      () => new Date("2026-07-30T12:01:00.000Z"),
      () => "publish-id"
    );
    const prepared = await publisher.prepare(inspection, {
      repositoryName: "new-repository",
      visibility: "private"
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const result = await publisher.execute(prepared.plan, inspection);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "GITHUB_PUBLISH_TARGET_MISMATCH" }
    });
    expect(blobRequested).toBe(false);
  });

  it("fails closed when the local repository changes after planning", async () => {
    const inspection = await createRepository();
    const requests: Array<{
      path: string;
      method: string;
      authorization: string | null;
    }> = [];
    const publisher = new GitHubPublisher(
      { XL_AGENT_GITHUB_PUBLISH_TOKEN: "write-token" },
      preparationFetch(requests),
      () => new Date("2026-07-30T12:01:00.000Z"),
      () => "publish-id"
    );
    const prepared = await publisher.prepare(inspection, {
      repositoryName: "new-repository",
      visibility: "private"
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await writeFile(
      path.join(inspection.sourcePath, "README.md"),
      "changed after approval\n",
      "utf8"
    );

    const result = await publisher.execute(prepared.plan, inspection);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "GITHUB_PUBLISH_SOURCE_CHANGED" }
    });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(
      0
    );
  });

  it("rejects a plan whose approved fields changed without a new hash", async () => {
    const inspection = await createRepository();
    const requests: Array<{
      path: string;
      method: string;
      authorization: string | null;
    }> = [];
    const publisher = new GitHubPublisher(
      { XL_AGENT_GITHUB_PUBLISH_TOKEN: "write-token" },
      preparationFetch(requests),
      () => new Date("2026-07-30T12:01:00.000Z"),
      () => "publish-id"
    );
    const prepared = await publisher.prepare(inspection, {
      repositoryName: "new-repository",
      visibility: "private"
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const result = await publisher.execute(
      {
        ...prepared.plan,
        targetVisibility: "public"
      },
      inspection
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "GITHUB_PUBLISH_APPROVAL_INVALID" }
    });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(
      0
    );
  });
});
