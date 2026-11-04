import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { nextCronRun } from "./cron.js";
import type { DeviceRow, DeviceStore } from "./devices.js";
import type { PowerManager } from "./power.js";
import type { StatusTracker } from "./status.js";

export const SCHEDULE_TICK_MS = 30_000;

/** Whether a schedule has a run between its last run and now. */
export function isDue(cron: string, lastRunAt: string | null, now: Date) {
  if (!cron || !lastRunAt) return false;
  const next = nextCronRun(cron, new Date(lastRunAt));
  return next !== null && next.getTime() <= now.getTime();
}

export function createScheduler(
  ctx: PluginContext,
  store: DeviceStore,
  power: PowerManager,
  status: StatusTracker,
) {
  async function run(
    row: DeviceRow,
    action: "wake" | "shutdown",
    lastRun: "lastWakeRunAt" | "lastShutdownRunAt",
  ) {
    // Saved first: a crash mid run must not fire it twice.
    await store.save(row.hostId, { [lastRun]: new Date().toISOString() });
    const already = status.current(row.hostId);
    if (action === "wake" && already === "online") return;
    if (action === "shutdown" && already === "offline") return;
    if (!row.updatedBy) return;
    const userId = row.updatedBy;
    try {
      await ctx.asUser(userId, () =>
        power[action](row.hostId, { scheduled: true }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log.warn(`Scheduled ${action} of ${row.hostId} failed: ${message}`);
      await ctx.notify
        .send({
          title: `Scheduled ${action} failed`,
          body: message,
          severity: "warning",
          category: `wake-on-lan.${action}_failed`,
          audience: { userId },
          context: { hostId: row.hostId },
        })
        .catch(() => {});
    }
  }

  return {
    async tick(now = new Date()) {
      for (const row of await store.all()) {
        if (isDue(row.wakeCron, row.lastWakeRunAt, now)) {
          await run(row, "wake", "lastWakeRunAt");
        }
        if (isDue(row.shutdownCron, row.lastShutdownRunAt, now)) {
          await run(row, "shutdown", "lastShutdownRunAt");
        }
      }
    },
  };
}
