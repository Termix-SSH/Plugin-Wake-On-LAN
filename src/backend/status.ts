import type {
  PluginContext,
  PluginHostProbeTarget,
} from "@termix-ssh/plugin-sdk/backend";
import type { DeviceStatus, PowerStatus } from "../shared/types.js";
import { substitute, type CommandRunner } from "./commands.js";
import {
  defaultRow,
  parsePorts,
  statusOf,
  type DeviceRow,
  type DeviceStore,
} from "./devices.js";
import type { Relay } from "./relay.js";

/** Misses in a row before a device counts as offline. */
const MISSES_TO_OFFLINE = 2;
const PROBE_TIMEOUT_MS = 2500;
const SERVER_CONCURRENCY = 20;
const SAFE_ADDRESS = /^[A-Za-z0-9.:-]+$/;
export const FAST_TICK_MS = 3000;
export const TICK_MS = 10_000;
export const DEFAULT_INTERVAL = 60;
/** Addresses are reused this long: reading them as a user writes an audit line. */
const TARGET_TTL_MS = 10 * 60_000;

interface Live {
  status: PowerStatus;
  openPorts: number[];
  statusChangedAt: string | null;
  lastSeenAt: string | null;
}

interface Pending {
  target: "online" | "offline";
  deadline: number;
  onFail?: () => void;
}

interface Check {
  up: boolean;
  ports: number[];
}

interface PowerHost {
  hostId: number;
  userId: string;
}

/** Checks every device of a relay in one script, one line per device. */
export function relayCheckScript(
  checks: Array<{ hostId: number; address: string; ports: number[] }>,
): string {
  const lines = checks.map(({ hostId, address, ports }) => {
    const probes = ports
      .map(
        (port) =>
          `if timeout 2 bash -c 'exec 3<>/dev/tcp/${address}/${port}' 2>/dev/null; then open="$open,${port}"; up=1; fi`,
      )
      .join("; ");
    return `(up=0; open=""; if ping -c 1 -W 1 ${address} >/dev/null 2>&1; then up=1; fi; ${probes || ":"}; echo "@${hostId} $up \${open#,}") &`;
  });
  return `${lines.join("\n")}\nwait\n`;
}

export function parseRelayChecks(output: string): Map<number, Check> {
  const checks = new Map<number, Check>();
  for (const line of output.split("\n")) {
    const match = /^@(\d+) ([01])\s*([\d,]*)$/.exec(line.trim());
    if (!match) continue;
    checks.set(Number(match[1]), {
      up: match[2] === "1",
      ports: parsePorts(match[3]!),
    });
  }
  return checks;
}

export interface StatusTracker {
  /** Loads saved states, once at start. */
  load: () => Promise<void>;
  view: (hostId: number, row: DeviceRow) => DeviceStatus;
  /** Marks an action as started and watches for its result. */
  expect: (
    hostId: number,
    status: "waking" | "stopping",
    timeoutSeconds: number,
    onFail?: () => void,
  ) => Promise<void>;
  /** The slow pass over every device. Skips until the interval has passed. */
  tick: () => Promise<void>;
  /** The fast pass over devices that are waking or stopping. */
  fastTick: () => Promise<void>;
  current: (hostId: number) => PowerStatus | null;
  forget: (hostId: number) => void;
}

export function createStatusTracker(
  ctx: PluginContext,
  store: DeviceStore,
  relay: Relay,
  commands: CommandRunner,
): StatusTracker {
  const live = new Map<number, Live>();
  const pending = new Map<number, Pending>();
  const misses = new Map<number, number>();
  const targets = new Map<
    number,
    { target: PluginHostProbeTarget; at: number }
  >();
  let lastRun = 0;

  async function write(hostId: number, entry: Live) {
    await store.save(hostId, {
      status: entry.status,
      openPorts: entry.openPorts.join(","),
      statusChangedAt: entry.statusChangedAt,
      lastSeenAt: entry.lastSeenAt,
    });
  }

  function entryOf(hostId: number): Live {
    let entry = live.get(hostId);
    if (!entry) {
      entry = {
        status: "unknown",
        openPorts: [],
        statusChangedAt: null,
        lastSeenAt: null,
      };
      live.set(hostId, entry);
    }
    return entry;
  }

  /** Only a change of status is saved; each save rewrites the database. */
  async function change(hostId: number, status: PowerStatus) {
    const entry = entryOf(hostId);
    if (entry.status === status) return;
    entry.status = status;
    entry.statusChangedAt = new Date().toISOString();
    await write(hostId, entry);
  }

  async function apply(hostId: number, check: Check) {
    const entry = entryOf(hostId);
    entry.openPorts = check.ports;
    if (check.up) {
      entry.lastSeenAt = new Date().toISOString();
      misses.set(hostId, 0);
    }
    const waiting = pending.get(hostId);
    if (waiting) {
      if ((waiting.target === "online") === check.up) {
        pending.delete(hostId);
        await change(hostId, waiting.target);
      } else if (Date.now() >= waiting.deadline) {
        pending.delete(hostId);
        await change(hostId, "failed");
        waiting.onFail?.();
      }
      return;
    }
    if (check.up) return change(hostId, "online");
    const count = (misses.get(hostId) ?? 0) + 1;
    misses.set(hostId, count);
    if (count >= MISSES_TO_OFFLINE || entry.status === "unknown") {
      await change(hostId, "offline");
    }
  }

  async function serverCheck(
    target: PluginHostProbeTarget,
    row: DeviceRow,
  ): Promise<Check> {
    const wanted = parsePorts(row.ports);
    const ports = wanted.length > 0 ? wanted : [target.port];
    const results = await Promise.all(
      ports.map(async (port) =>
        (await ctx.network
          .tcpProbe(target.ip, port, { timeoutMs: PROBE_TIMEOUT_MS })
          .catch(() => false))
          ? port
          : 0,
      ),
    );
    const open = results.filter(Boolean);
    return { up: open.length > 0, ports: open };
  }

  /** A ping command decides up or down, as in UpSnap. Ports stay extra. */
  async function commandCheck(
    target: PluginHostProbeTarget,
    row: DeviceRow,
  ): Promise<boolean> {
    if (!row.updatedBy || !row.pingCommandSealed) return false;
    const command = await ctx.secrets.unseal(row.pingCommandSealed);
    if (!command) return false;
    const result = await commands.run({
      command: substitute(command, {
        ip: row.lanIp || target.ip,
        mac:
          (await ctx.settings.getHost<string>(target.id, "macAddress")) ?? "",
      }),
      target: row.commandTarget as "host",
      hostId: target.id,
      relayId: row.commandRelay,
      userId: row.updatedBy,
    });
    return result.ok;
  }

  interface Item {
    target: PluginHostProbeTarget;
    row: DeviceRow;
  }

  async function checkOnRelay(relayId: number, userId: string, items: Item[]) {
    const usable = items.filter(({ row, target }) =>
      SAFE_ADDRESS.test(row.lanIp || target.ip),
    );
    if (usable.length === 0) return;
    let checks: Map<number, Check>;
    try {
      const result = await relay.run(
        relayId,
        userId,
        relayCheckScript(
          usable.map(({ row, target }) => ({
            hostId: target.id,
            address: row.lanIp || target.ip,
            ports: parsePorts(row.ports),
          })),
        ),
      );
      checks = parseRelayChecks(result.stdout);
    } catch (error) {
      // A relay that is down says nothing about the devices behind it.
      ctx.log.warn(
        `Status relay ${relayId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const { target } of usable) {
      const check = checks.get(target.id);
      if (check) await apply(target.id, check);
    }
  }

  async function checkOne({ target, row }: Item) {
    if (row.pingCommandSealed) {
      const up = await commandCheck(target, row).catch(() => false);
      const ports = parsePorts(row.ports).length
        ? (await serverCheck(target, row)).ports
        : [];
      return apply(target.id, { up, ports });
    }
    return apply(target.id, await serverCheck(target, row));
  }

  /** Probe targets need a user, so each owner's hosts load as that owner. */
  async function targetsOf(hosts: PowerHost[]) {
    const now = Date.now();
    const byOwner = new Map<string, number[]>();
    for (const { hostId, userId } of hosts) {
      const cached = targets.get(hostId);
      if (cached && now - cached.at < TARGET_TTL_MS) continue;
      byOwner.set(userId, [...(byOwner.get(userId) ?? []), hostId]);
    }
    for (const [userId, hostIds] of byOwner) {
      try {
        const found = await ctx.asUser(userId, () =>
          ctx.hosts.probeTargets({ hostIds }),
        );
        for (const target of found) {
          targets.set(target.id, { target, at: now });
        }
      } catch (error) {
        ctx.log.warn(`Could not read hosts for status: ${String(error)}`);
      }
    }
    return hosts.flatMap(({ hostId }) => targets.get(hostId)?.target ?? []);
  }

  async function check(hosts: PowerHost[]) {
    if (hosts.length === 0) return;
    const [found, rows] = await Promise.all([targetsOf(hosts), store.all()]);
    const rowOf = new Map(rows.map((row) => [row.hostId, row]));
    const items: Item[] = found.map((target) => ({
      target,
      row: rowOf.get(target.id) ?? defaultRow(target.id),
    }));

    // One script per relay and login, so nobody uses another user's access.
    const groups = new Map<string, Item[]>();
    const direct: Item[] = [];
    for (const item of items) {
      const { statusFrom, updatedBy, pingCommandSealed } = item.row;
      if (statusFrom && updatedBy && !pingCommandSealed) {
        const key = `${statusFrom}:${updatedBy}`;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      } else {
        direct.push(item);
      }
    }

    const relays = [...groups.values()].map((group) => {
      const { statusFrom, updatedBy } = group[0]!.row;
      return checkOnRelay(statusFrom!, updatedBy!, group);
    });
    const workers = Array.from({ length: SERVER_CONCURRENCY }, async () => {
      for (let item = direct.shift(); item; item = direct.shift()) {
        await checkOne(item);
      }
    });
    await Promise.all([...relays, ...workers]);
  }

  async function enabledHosts(): Promise<PowerHost[]> {
    const rows = await ctx.settings.listHostValues<boolean>("enablePower");
    return rows.filter((row) => row.value === true);
  }

  return {
    async load() {
      for (const row of await store.all()) {
        live.set(row.hostId, {
          status: statusOf(row),
          openPorts: parsePorts(row.openPorts),
          statusChangedAt: row.statusChangedAt,
          lastSeenAt: row.lastSeenAt,
        });
      }
    },
    view(hostId, row) {
      const entry = live.get(hostId);
      return {
        hostId,
        status: entry?.status ?? statusOf(row),
        openPorts: entry?.openPorts ?? parsePorts(row.openPorts),
        statusChangedAt: entry?.statusChangedAt ?? row.statusChangedAt,
        lastSeenAt: entry?.lastSeenAt ?? row.lastSeenAt,
      };
    },
    async expect(hostId, status, timeoutSeconds, onFail) {
      misses.delete(hostId);
      pending.set(hostId, {
        target: status === "waking" ? "online" : "offline",
        deadline: Date.now() + timeoutSeconds * 1000,
        onFail,
      });
      await change(hostId, status);
    },
    async tick() {
      const seconds =
        (await ctx.settings.get<number>("statusInterval")) ?? DEFAULT_INTERVAL;
      if (Date.now() - lastRun < seconds * 1000) return;
      lastRun = Date.now();
      await check(await enabledHosts()).catch((error: unknown) => {
        ctx.log.warn(`Status check failed: ${String(error)}`);
      });
    },
    async fastTick() {
      if (pending.size === 0) return;
      const hosts = await enabledHosts();
      const on = new Set(hosts.map((host) => host.hostId));
      // A host woken from its MAC alone has no card to update.
      for (const hostId of pending.keys()) {
        if (!on.has(hostId)) pending.delete(hostId);
      }
      await check(hosts.filter((host) => pending.has(host.hostId))).catch(
        (error: unknown) => {
          ctx.log.warn(`Status check failed: ${String(error)}`);
        },
      );
    },
    current(hostId) {
      return live.get(hostId)?.status ?? null;
    },
    forget(hostId) {
      live.delete(hostId);
      targets.delete(hostId);
      pending.delete(hostId);
      misses.delete(hostId);
    },
  };
}
