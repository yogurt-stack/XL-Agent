import { describe, expect, it } from "vitest";
import { shouldReturnHomeForState } from "./App";

describe("App task navigation", () => {
  it("returns an idle intake view home", () => {
    expect(shouldReturnHomeForState("intake", "clarification")).toBe(true);
  });

  it("keeps stopped or failed tasks on their recovery page", () => {
    expect(shouldReturnHomeForState("cancelled", "clarification")).toBe(false);
    expect(shouldReturnHomeForState("cancelled", "plan")).toBe(false);
  });
});
