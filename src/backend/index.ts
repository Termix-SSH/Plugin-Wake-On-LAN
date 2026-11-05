import type { Router } from "express";
import { registerOperations } from "./operations.js";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createCommandRunner } from "./commands.js";
import { createDeviceStore } from "./devices.js";
import { createPowerManager } from "./power.js";
import { createRelay } from "./relay.js";
import { registerWakeOnLanRoutes } from "./routes.js";
import { createScheduler, SCHEDULE_TICK_MS } from "./schedule.js";
import { createBmc } from "./bmc.js";
import { createWakeOnLanService } from "./service.js";
import { createStatusTracker, FAST_TICK_MS, TICK_MS } from "./status.js";
import { devices } from "./tables.js";

const MOVED_KEY = "enabled-saved-macs";

/** Hosts from before the Power switch keep working: a saved MAC turns it on. */
async function enableSavedMacs(ctx: PluginContext) {
  if (await ctx.kv.get(MOVED_KEY)) return;
  const macs = await ctx.settings.listHostValues<string>("macAddress");
  for (const { hostId, userId, value } of macs) {
    if (!value?.trim()) continue;
    await ctx.asUser(userId, () =>
      ctx.settings.setHost(hostId, "enablePower", true),
    );
  }
  await ctx.kv.set(MOVED_KEY, true);
}

export async function activate(ctx: PluginContext) {
  const store = createDeviceStore(ctx, await ctx.db.define(devices));
  const relay = createRelay(ctx);
  const commands = createCommandRunner(ctx, relay);
  const status = createStatusTracker(ctx, store, relay, commands);
  const power = createPowerManager(
    ctx,
    store,
    relay,
    commands,
    status,
    createBmc(ctx),
  );
  const scheduler = createScheduler(ctx, store, power, status);

  await status.load();
  await enableSavedMacs(ctx).catch((error) => {
    ctx.log.warn(`Could not move saved MAC addresses: ${String(error)}`);
  });

  ctx.services.provide("wake-on-lan.send", createWakeOnLanService(power));
  registerOperations(ctx, store, power, status);
  registerWakeOnLanRoutes(ctx.http.router<Router>(), ctx, {
    store,
    status,
    power,
    relay,
  });

  ctx.schedule.every(TICK_MS, () => status.tick(), { jitterMs: 2000 });
  ctx.schedule.every(FAST_TICK_MS, () => status.fastTick());
  ctx.schedule.every(SCHEDULE_TICK_MS, () => scheduler.tick());
  ctx.log.info("Wake-on-LAN routes mounted at /plugin-api/wake-on-lan");
}

export async function deactivate() {
  // Everything above was registered through ctx and is disposed by core.
}
