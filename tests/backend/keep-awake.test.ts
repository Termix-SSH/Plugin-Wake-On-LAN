import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { keepAwake } from "../../src/backend/keep-awake.js";

describe("keepAwake", () => {
  it("tells Termix when the plugin has work", () => {
    const calls: Array<[string, boolean]> = [];
    const schedule = {
      keepAwake: vi.fn(function (
        this: unknown,
        reason: string,
        awake: boolean,
      ) {
        expect(this).toBe(schedule);
        calls.push([reason, awake]);
      }),
    };
    const ctx = { schedule } as unknown as PluginContext;
    keepAwake(ctx, "watches", true);
    keepAwake(ctx, "watches", false);
    expect(calls).toEqual([
      ["watches", true],
      ["watches", false],
    ]);
  });

  it("does nothing on a Termix without it", () => {
    const ctx = { schedule: {} } as unknown as PluginContext;
    expect(() => keepAwake(ctx, "watches", true)).not.toThrow();
  });
});
