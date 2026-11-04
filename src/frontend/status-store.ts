import { useEffect, useSyncExternalStore } from "react";
import type { DeviceSummary } from "../shared/types";
import {
  listDevices,
  listStatuses,
  type Allowed,
  type DeviceList,
} from "./api";

const IDLE_MS = 60_000;
const WATCHED_MS = 10_000;
const BUSY_MS = 3000;

const NOTHING: Allowed = {
  wake: false,
  shutdown: false,
  scan: false,
  server: false,
};

let state: DeviceList & { loaded: boolean; failed: boolean } = {
  devices: [],
  can: NOTHING,
  loaded: false,
  failed: false,
};
const listeners = new Set<() => void>();
let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function publish(next: Partial<typeof state>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function currentDevice(hostId: number): DeviceSummary | undefined {
  return state.devices.find((device) => device.hostId === hostId);
}

export function currentCan(): Allowed {
  return state.can;
}

export async function reloadDevices(): Promise<void> {
  try {
    publish({ ...(await listDevices()), loaded: true, failed: false });
  } catch {
    publish({ loaded: true, failed: true });
  }
}

async function refreshStatuses() {
  const statuses = await listStatuses();
  const known = new Set(state.devices.map((device) => device.hostId));
  // A host turned on or off elsewhere: the list itself is out of date.
  if (
    statuses.length !== known.size ||
    statuses.some((entry) => !known.has(entry.hostId))
  ) {
    return reloadDevices();
  }
  const byId = new Map(statuses.map((entry) => [entry.hostId, entry]));
  publish({
    devices: state.devices.map((device) => ({
      ...device,
      ...byId.get(device.hostId),
    })),
  });
}

function delay(): number {
  const busy = state.devices.some(
    (device) => device.status === "waking" || device.status === "stopping",
  );
  if (busy) return BUSY_MS;
  return watchers > 0 ? WATCHED_MS : IDLE_MS;
}

function schedule(ms = delay()) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void loop(), ms);
}

async function loop() {
  if (!running) return;
  if (document.visibilityState !== "hidden") {
    await refreshStatuses().catch(() => {});
  }
  if (running) schedule();
}

/** Starts the slow poll that keeps host row buttons right. */
export function startStatusPolling(): void {
  running = true;
  void reloadDevices().finally(() => {
    if (running) schedule();
  });
}

export function stopStatusPolling(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Asks for a status soon, after an action or when a view opens. */
export function pokeStatus(): void {
  if (running) schedule(500);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The device list, polled faster while something on screen uses it. */
export function useDevices(isVisible = true) {
  useEffect(() => {
    if (!isVisible) return;
    watchers += 1;
    pokeStatus();
    return () => {
      watchers -= 1;
    };
  }, [isVisible]);
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
