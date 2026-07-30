import { describe, expect, it } from "vitest";
import { ModelConnectionController } from "./modelConnection";

describe("model connection controller", () => {
  it("keeps a user-selected local retry offline until the connection is tested again", async () => {
    const controller = new ModelConnectionController(
      {
        async getConnectionInfo() {
          return {
            configured: true,
            endpointHost: "api.example.test",
            model: "test-model",
            providerId: "openai-compatible",
            endpointMode: "endpoint"
          };
        },
        async testConnection() {
          return { ok: true };
        }
      },
      () => "test-time"
    );

    await controller.initialize();
    controller.useLocalModel();

    expect(controller.getState()).toMatchObject({
      status: "fallback_local",
      activeProvider: "local-rule",
      configured: true,
      error: { code: "MODEL_LOCAL_OVERRIDE" },
      lastCheckedAt: "test-time"
    });
    expect(controller.shouldAttemptRemote()).toBe(false);

    await controller.testConnection();
    expect(controller.getState()).toMatchObject({
      status: "remote_available",
      activeProvider: "remote-llm"
    });
  });
});
