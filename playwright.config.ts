import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 30_000
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{platform}{ext}",
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results"
});
