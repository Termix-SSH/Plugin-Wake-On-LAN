import { describe, it, expect, vi } from "vitest";
import { createFakeContext } from "@termix-ssh/plugin-sdk/testing";
import {
  defaultRow,
  type DeviceRow,
  type DeviceStore,
} from "../../src/backend/devices.js";
import type { PowerManager } from "../../src/backend/power.js";
import { createScheduler, isDue } from "../../src/backend/schedule.js";
import type { StatusTracker } from "../../src/backend/status.js";

const AT_NINE = new Date("2026-11-03T09:00:30");
const BEFORE = new Date("2026-11-03T08:59:00").toISOString();
const AFTER = new Date("2026-11-03T09:00:10").toISOString();

function setup(row: Partial<DeviceRow>, current = "offline") {
  const fake = createFakeContext({ actor: "nobody" });
  const saved = { ...defaultRow(1), updatedBy: "saver", ...row };
  const store = {
    all: vi.fn(async () => [saved]),
    save: vi.fn(async (_id: number, patch: Partial<DeviceRow>) => {
      Object.assign(saved, patch);
    }),
  } as unknown as DeviceStore;
  const power = {
    wake: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  } as unknown as PowerManager;
  const status = { current: () => current } as unknown as StatusTracker;
  const scheduler = createScheduler(fake.ctx, store, power, status);
  return { fake, power, scheduler };
}

describe("isDue", () => {
  it("is due once the time has passed since the last run", () => {
    expect(isDue("0 9 * * *", BEFORE, AT_NINE)).toBe(true);
    expect(isDue("0 9 * * *", AFTER, AT_NINE)).toBe(false);
  });

  it("never fires with no starting point", () => {
    expect(isDue("0 9 * * *", null, AT_NINE)).toBe(false);
    expect(isDue("", BEFORE, AT_NINE)).toBe(false);
  });
});

describe("scheduler", () => {
  it("runs once and marks the run first", async () => {
    const { power, scheduler } = setup({
      wakeCron: "0 9 * * *",
      lastWakeRunAt: BEFORE,
    });
    await scheduler.tick(AT_NINE);
    await scheduler.tick(new Date(AT_NINE.getTime() + 1000));
    expect(power.wake).toHaveBeenCalledTimes(1);
    expect(power.wake).toHaveBeenCalledWith(1, { scheduled: true });
  });

  it("skips a wake when the device is already on", async () => {
    const { power, scheduler } = setup(
      { wakeCron: "0 9 * * *", lastWakeRunAt: BEFORE },
      "online",
    );
    await scheduler.tick(AT_NINE);
    expect(power.wake).not.toHaveBeenCalled();
  });

  it("skips a shutdown when the device is already off", async () => {
    const { power, scheduler } = setup({
      shutdownCron: "0 9 * * *",
      lastShutdownRunAt: BEFORE,
    });
    await scheduler.tick(AT_NINE);
    expect(power.shutdown).not.toHaveBeenCalled();
  });

  it("alerts the saver when a run fails", async () => {
    const { fake, power, scheduler } = setup({
      wakeCron: "0 9 * * *",
      lastWakeRunAt: BEFORE,
    });
    vi.mocked(power.wake).mockRejectedValue(new Error("no route"));
    const send = vi.spyOn(fake.ctx.notify, "send");
    await scheduler.tick(AT_NINE);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: { userId: "saver" },
        body: "no route",
      }),
    );
  });
});
