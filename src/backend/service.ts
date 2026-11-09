import type { PowerManager } from "./power.js";

export interface WakeOnLanV1 {
  wake: (hostId: number) => Promise<void>;
  shutdown: (hostId: number) => Promise<void>;
}

export function createWakeOnLanService(power: PowerManager): WakeOnLanV1 {
  return {
    wake: (hostId) => power.wake(hostId),
    shutdown: (hostId) => power.shutdown(hostId),
  };
}
