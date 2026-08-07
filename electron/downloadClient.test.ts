import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { downloadTrustedResource } from "./downloadClient";

describe("downloadTrustedResource lockfile integrity", () => {
  it("records SHA256 while enforcing package-lock SHA512", async () => {
    const body = Buffer.from("locked npm tarball");
    const sha512 = createHash("sha512").update(body).digest("base64");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "xunlei-download-test-")
    );
    try {
      const output = await downloadTrustedResource(
        {
          resourceId: "npm-left-pad-test",
          url: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          expectedSha256: null,
          digestPolicy: "lockfile-integrity",
          expectedIntegrity: {
            algorithm: "sha512",
            digestBase64: sha512
          },
          maxSizeMb: 1,
          allowedHosts: ["registry.npmjs.org"]
        },
        {
          tempRoot,
          fetchRequest: async () =>
            new Response(body, {
              status: 200,
              headers: {
                "content-length": String(body.byteLength),
                "content-disposition": "attachment; filename=left-pad.tgz"
              }
            })
        }
      );

      expect(output.sha256).toBe(sha256);
      expect(output.fileName).toBe("left-pad.tgz");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the tarball does not match the lockfile", async () => {
    const body = Buffer.from("tampered npm tarball");
    const expected = createHash("sha512")
      .update("expected npm tarball")
      .digest("base64");
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "xunlei-download-test-")
    );
    try {
      await expect(
        downloadTrustedResource(
          {
            resourceId: "npm-left-pad-test",
            url: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
            expectedSha256: null,
            digestPolicy: "lockfile-integrity",
            expectedIntegrity: {
              algorithm: "sha512",
              digestBase64: expected
            },
            maxSizeMb: 1,
            allowedHosts: ["registry.npmjs.org"]
          },
          {
            tempRoot,
            fetchRequest: async () => new Response(body, { status: 200 })
          }
        )
      ).rejects.toMatchObject({
        detail: {
          code: "CHECKSUM_MISMATCH",
          message: expect.stringContaining("SHA512"),
          retriable: true
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
