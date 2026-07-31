import { describe, expect, it } from "vitest";
import { SingleFlightGate } from "./singleFlightGate";

describe("SingleFlightGate", () => {
  it("rejects a duplicate approval before the first async operation releases", () => {
    const gate = new SingleFlightGate();
    const release = gate.tryAcquire();

    expect(release).toBeTypeOf("function");
    expect(gate.isLocked()).toBe(true);
    expect(gate.tryAcquire()).toBeNull();

    release?.();
    expect(gate.isLocked()).toBe(false);
    expect(gate.tryAcquire()).toBeTypeOf("function");
  });

  it("makes the release callback idempotent", () => {
    const gate = new SingleFlightGate();
    const release = gate.tryAcquire();
    release?.();
    release?.();

    expect(gate.isLocked()).toBe(false);
  });
});
