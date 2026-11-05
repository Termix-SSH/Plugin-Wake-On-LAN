import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

const SERVICE = "out-of-band.power";

interface OutOfBandPower {
  has: (hostId: number) => Promise<boolean>;
  set: (
    hostId: number,
    action: "on" | "off" | "graceful-shutdown" | "cycle" | "reset",
  ) => Promise<void>;
}

export interface Bmc {
  /** The Out-of-band plugin is on and this host has a BMC linked. */
  available: (hostId: number, userId: string | null) => Promise<boolean>;
  set: (
    hostId: number,
    userId: string | null,
    action: "on" | "graceful-shutdown",
  ) => Promise<void>;
}

/** Power through the Out-of-band plugin, when it is there. Never required. */
export function createBmc(ctx: PluginContext): Bmc {
  const service = (): OutOfBandPower | null => {
    if (!ctx.services.providers(SERVICE).includes("")) return null;
    const found = ctx.services.get<Partial<OutOfBandPower>>(SERVICE);
    return typeof found.has === "function" && typeof found.set === "function"
      ? (found as OutOfBandPower)
      : null;
  };
  // Scheduled runs have no signed in user, so they act as whoever saved the device
  const as = <T>(userId: string | null, fn: () => Promise<T>) =>
    userId ? ctx.asUser(userId, fn) : fn();

  return {
    async available(hostId, userId) {
      const found = service();
      if (!found) return false;
      try {
        return await as(userId, () => found.has(hostId));
      } catch {
        return false;
      }
    },
    async set(hostId, userId, action) {
      const found = service();
      if (!found) throw new Error("Out-of-band is not turned on");
      await as(userId, () => found.set(hostId, action));
    },
  };
}
