import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_SNAPSHOT_PROTOCOL_VERSION,
  classifyAgentRuntimeSnapshot,
  type AgentRuntimeSnapshotCursor
} from "./runtimeBridge";

function envelope(
  runtimeInstanceId: string,
  sequence: number,
  protocolVersion: number = AGENT_RUNTIME_SNAPSHOT_PROTOCOL_VERSION
) {
  return { protocolVersion, runtimeInstanceId, sequence };
}

describe("Agent Runtime snapshot ordering", () => {
  it("accepts the first compatible snapshot", () => {
    const decision = classifyAgentRuntimeSnapshot(
      null,
      envelope("runtime-a", 1)
    );

    expect(decision).toEqual({
      accepted: true,
      reason: "first",
      cursor: {
        runtimeInstanceId: "runtime-a",
        sequence: 1,
        retiredRuntimeInstanceIds: []
      }
    });
  });

  it("accepts only a strictly increasing sequence from the same instance", () => {
    const current: AgentRuntimeSnapshotCursor = {
      runtimeInstanceId: "runtime-a",
      sequence: 7,
      retiredRuntimeInstanceIds: []
    };

    expect(
      classifyAgentRuntimeSnapshot(current, envelope("runtime-a", 8))
    ).toEqual({
      accepted: true,
      reason: "newer",
      cursor: { ...current, sequence: 8 }
    });
    expect(
      classifyAgentRuntimeSnapshot(current, envelope("runtime-a", 7))
    ).toEqual({
      accepted: false,
      reason: "stale-sequence",
      cursor: current
    });
    expect(
      classifyAgentRuntimeSnapshot(current, envelope("runtime-a", 6))
    ).toEqual({
      accepted: false,
      reason: "stale-sequence",
      cursor: current
    });
  });

  it("accepts a new instance and retires the previous instance", () => {
    const current: AgentRuntimeSnapshotCursor = {
      runtimeInstanceId: "runtime-a",
      sequence: 12,
      retiredRuntimeInstanceIds: []
    };

    const decision = classifyAgentRuntimeSnapshot(
      current,
      envelope("runtime-b", 0)
    );

    expect(decision).toEqual({
      accepted: true,
      reason: "new-instance",
      cursor: {
        runtimeInstanceId: "runtime-b",
        sequence: 0,
        retiredRuntimeInstanceIds: ["runtime-a"]
      }
    });
  });

  it("rejects delayed snapshots from a retired instance", () => {
    const current: AgentRuntimeSnapshotCursor = {
      runtimeInstanceId: "runtime-b",
      sequence: 2,
      retiredRuntimeInstanceIds: ["runtime-a"]
    };

    expect(
      classifyAgentRuntimeSnapshot(current, envelope("runtime-a", 99))
    ).toEqual({
      accepted: false,
      reason: "retired-instance",
      cursor: current
    });
  });

  it("rejects incompatible protocols without advancing the cursor", () => {
    const current: AgentRuntimeSnapshotCursor = {
      runtimeInstanceId: "runtime-a",
      sequence: 3,
      retiredRuntimeInstanceIds: []
    };

    expect(
      classifyAgentRuntimeSnapshot(
        current,
        envelope(
          "runtime-a",
          4,
          AGENT_RUNTIME_SNAPSHOT_PROTOCOL_VERSION + 1
        )
      )
    ).toEqual({
      accepted: false,
      reason: "incompatible-protocol",
      cursor: current
    });
  });

  it("rejects legacy or malformed envelopes", () => {
    expect(classifyAgentRuntimeSnapshot(null, { sequence: 1 })).toEqual({
      accepted: false,
      reason: "invalid-envelope",
      cursor: null
    });
    expect(
      classifyAgentRuntimeSnapshot(null, envelope("runtime-a", -1))
    ).toEqual({
      accepted: false,
      reason: "invalid-envelope",
      cursor: null
    });
  });
});
