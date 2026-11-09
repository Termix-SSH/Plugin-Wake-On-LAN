import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import type { SignalStatus } from "@termix-ssh/plugin-sdk/operations";
import type { DeviceRow, DeviceStore } from "./devices.js";
import type { PowerManager } from "./power.js";
import type { StatusTracker } from "./status.js";

const STATUS: Record<string, SignalStatus> = {
  online: "ok",
  offline: "warn",
};

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

/** Everything Wake-on-LAN offers to the rest of Termix. */
export function registerOperations(
  ctx: PluginContext,
  store: DeviceStore,
  power: PowerManager,
  status: StatusTracker,
): void {
  ctx.operations.register("wake-on-lan.wake", {
    describe: () => "Would wake this machine with its saved method",
    run: async (_input, context) => {
      await power.wake(requireHost(context));
      return { summary: "Wake started", changed: true };
    },
  });

  ctx.operations.register("wake-on-lan.shutdown", {
    describe: () => "Would shut this machine down with its saved method",
    run: async (_input, context) => {
      await power.shutdown(requireHost(context));
      return { summary: "Shutdown started", changed: true };
    },
  });

  ctx.operations.register("wake-on-lan.sleep", {
    describe: () => "Would put this machine to sleep through Sleep-On-LAN",
    run: async (_input, context) => {
      await power.sleep(requireHost(context));
      return { summary: "Sleep started", changed: true };
    },
  });

  ctx.operations.register("wake-on-lan.power-state", {
    run: async (_input, context) => {
      const hostId = requireHost(context);
      const row =
        (await store.get(hostId)) ??
        ({ status: "unknown", openPorts: "" } as DeviceRow);
      const view = status.view(hostId, row);
      return {
        summary: view.status,
        data: {
          value: view.status,
          status: STATUS[view.status] ?? "unknown",
          label: view.status,
        },
      };
    },
  });
}
