import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectLocalRepository,
  readLocalRepositoryBlob
} from "./localRepository";

const tempRoots: string[] = [];

function git(rootPath: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd: rootPath }, (error) =>
      error ? reject(error) : resolve()
    );
  });
}

async function createRepository() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "xunlei-local-repo-"));
  tempRoots.push(rootPath);
  await git(rootPath, ["init"]);
  await git(rootPath, ["config", "user.name", "Agent Test"]);
  await git(rootPath, ["config", "user.email", "agent@example.test"]);
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "local-agent-test", version: "1.0.0" }),
    "utf8"
  );
  await writeFile(
    path.join(rootPath, "package-lock.json"),
    JSON.stringify({
      name: "local-agent-test",
      lockfileVersion: 3,
      packages: { "": { name: "local-agent-test", version: "1.0.0" } }
    }),
    "utf8"
  );
  await git(rootPath, ["add", "package.json", "package-lock.json"]);
  await git(rootPath, ["commit", "-m", "initial"]);
  return rootPath;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((rootPath) =>
      rm(rootPath, { recursive: true, force: true })
    )
  );
});

describe("inspectLocalRepository", () => {
  it("returns only a sanitized clean-HEAD summary and reads fixed Git blobs", async () => {
    const rootPath = await createRepository();
    const inspection = await inspectLocalRepository(rootPath, {
      createId: () => "fixed-id",
      now: () => new Date("2026-07-30T12:00:00.000Z")
    });

    expect(inspection.summary).toMatchObject({
      repositoryHandleId: "local-repo-fixedid",
      displayName: path.basename(rootPath),
      clean: true,
      branch: expect.any(String),
      fileCount: 2,
      trackedFileCount: 2,
      hasSubmodules: false,
      hasSymlinks: false,
      analysis: {
        ecosystems: ["node"],
        manifests: ["package.json"],
        lockfiles: ["package-lock.json"],
        nodeOfflinePreparation: "package-lock-supported"
      }
    });
    expect(JSON.stringify(inspection.summary)).not.toContain(rootPath);
    expect(inspection.trackedFiles).toHaveLength(2);
    expect(inspection.trackedFiles[0].objectId).toMatch(/^[a-f0-9]{40,64}$/u);
    const packageJson = inspection.trackedFiles.find(
      (file) => file.relativePath === "package.json"
    )!;
    expect(
      JSON.parse(
        (
          await readLocalRepositoryBlob(inspection, packageJson.objectId)
        ).toString("utf8")
      )
    ).toMatchObject({ name: "local-agent-test" });
  });

  it("reports dirty files without changing the repository", async () => {
    const rootPath = await createRepository();
    await writeFile(path.join(rootPath, "package.json"), "changed", "utf8");
    await writeFile(path.join(rootPath, "notes.txt"), "untracked", "utf8");

    const inspection = await inspectLocalRepository(rootPath);

    expect(inspection.summary.clean).toBe(false);
    expect(inspection.summary.status.modified).toBe(1);
    expect(inspection.summary.status.untracked).toBe(1);
    expect(inspection.trackedFiles).toHaveLength(2);
  });

  it("rejects a directory that is not a standard Git repository", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "xunlei-not-repo-"));
    tempRoots.push(rootPath);
    await mkdir(path.join(rootPath, "source"));

    await expect(inspectLocalRepository(rootPath)).rejects.toMatchObject({
      code: "LOCAL_REPOSITORY_INVALID"
    });
  });
});
