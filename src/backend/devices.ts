import { eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type {
  CommandTarget,
  DeviceConfig,
  DeviceInput,
  PowerStatus,
  ShutdownMode,
  WakeMode,
} from "../shared/types.js";
import { isValidCron } from "./cron.js";
import {
  isValidBroadcastAddress,
  isValidMac,
  parseSecureOn,
} from "./magic-packet.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Tables come from ctx.db.define, which the SDK hands back untyped.
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const MIN_TIMEOUT = 5;
export const MAX_TIMEOUT = 3600;
const MAX_COMMAND = 4000;

export interface DeviceRow {
  hostId: number;
  lanIp: string;
  netmask: string;
  description: string | null;
  linkUrl: string | null;
  autoOpenLink: boolean;
  wakeFrom: number | null;
  wakePort: number;
  wakeMode: string;
  wakeCommandSealed: string | null;
  wakeTimeout: number;
  wakeConfirm: boolean;
  wakeCron: string;
  secureOnSealed: string | null;
  statusFrom: number | null;
  ports: string;
  pingCommandSealed: string | null;
  shutdownMode: string;
  shutdownCommandSealed: string | null;
  shutdownTimeout: number;
  shutdownConfirm: boolean;
  shutdownCron: string;
  commandTarget: string;
  commandRelay: number | null;
  solEnabled: boolean;
  solPort: number;
  solUser: string;
  solPasswordSealed: string | null;
  useBmc: boolean;
  status: string;
  openPorts: string;
  statusChangedAt: string | null;
  lastSeenAt: string | null;
  lastWakeRunAt: string | null;
  lastShutdownRunAt: string | null;
  updatedBy: string | null;
}

/** A host with Power on but nothing saved yet. */
export function defaultRow(hostId: number): DeviceRow {
  return {
    hostId,
    lanIp: "",
    netmask: "",
    description: null,
    linkUrl: null,
    autoOpenLink: false,
    wakeFrom: null,
    wakePort: 9,
    wakeMode: "magic",
    wakeCommandSealed: null,
    wakeTimeout: 120,
    wakeConfirm: false,
    wakeCron: "",
    secureOnSealed: null,
    statusFrom: null,
    ports: "",
    pingCommandSealed: null,
    shutdownMode: "none",
    shutdownCommandSealed: null,
    shutdownTimeout: 120,
    shutdownConfirm: true,
    shutdownCron: "",
    commandTarget: "host",
    commandRelay: null,
    solEnabled: false,
    solPort: 8009,
    solUser: "",
    solPasswordSealed: null,
    useBmc: false,
    status: "unknown",
    openPorts: "",
    statusChangedAt: null,
    lastSeenAt: null,
    lastWakeRunAt: null,
    lastShutdownRunAt: null,
    updatedBy: null,
  };
}

export function parsePorts(text: string): number[] {
  const ports = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return [...new Set(ports)];
}

export interface DeviceStore {
  all: () => Promise<DeviceRow[]>;
  get: (hostId: number) => Promise<DeviceRow | null>;
  /** The saved row, or the defaults for a host with none. */
  read: (hostId: number) => Promise<DeviceRow>;
  save: (hostId: number, patch: Partial<DeviceRow>) => Promise<void>;
}

export function createDeviceStore(
  ctx: PluginContext,
  table: Table,
): DeviceStore {
  const db = () => ctx.db.client<Drizzle>();
  const store: DeviceStore = {
    async all() {
      return (await (await db()).select().from(table)) as DeviceRow[];
    },
    async get(hostId) {
      const rows = (await (
        await db()
      )
        .select()
        .from(table)
        .where(eq(table.hostId, hostId))) as DeviceRow[];
      return rows[0] ?? null;
    },
    async read(hostId) {
      return (await store.get(hostId)) ?? defaultRow(hostId);
    },
    async save(hostId, patch) {
      const client = await db();
      if (await store.get(hostId)) {
        await client.update(table).set(patch).where(eq(table.hostId, hostId));
      } else {
        await client.insert(table).values({ ...patch, hostId });
      }
      await ctx.db.persist({ lazy: true });
    },
  };
  return store;
}

async function unseal(ctx: PluginContext, sealed: string | null) {
  return sealed ? ((await ctx.secrets.unseal(sealed)) ?? "") : "";
}

/** What the form shows. Passwords never leave the server. */
export async function toConfig(
  ctx: PluginContext,
  row: DeviceRow,
): Promise<DeviceConfig> {
  return {
    lanIp: row.lanIp,
    netmask: row.netmask,
    description: row.description ?? "",
    linkUrl: row.linkUrl ?? "",
    autoOpenLink: row.autoOpenLink,
    wakeFrom: row.wakeFrom,
    wakePort: row.wakePort,
    wakeMode: row.wakeMode as WakeMode,
    wakeCommand: await unseal(ctx, row.wakeCommandSealed),
    wakeTimeout: row.wakeTimeout,
    wakeConfirm: row.wakeConfirm,
    wakeCron: row.wakeCron,
    statusFrom: row.statusFrom,
    ports: row.ports,
    pingCommand: await unseal(ctx, row.pingCommandSealed),
    shutdownMode: row.shutdownMode as ShutdownMode,
    shutdownCommand: await unseal(ctx, row.shutdownCommandSealed),
    shutdownTimeout: row.shutdownTimeout,
    shutdownConfirm: row.shutdownConfirm,
    shutdownCron: row.shutdownCron,
    commandTarget: row.commandTarget as CommandTarget,
    commandRelay: row.commandRelay,
    solEnabled: row.solEnabled,
    solPort: row.solPort,
    solUser: row.solUser,
    useBmc: row.useBmc === true,
  };
}

const ADDRESS_RE = /^[A-Za-z0-9.:-]*$/;

function validPort(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
}

function validTimeout(value: unknown): boolean {
  return (
    Number.isInteger(value) &&
    Number(value) >= MIN_TIMEOUT &&
    Number(value) <= MAX_TIMEOUT
  );
}

function validRelay(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && Number(value) > 0);
}

function validLink(url: string): boolean {
  if (!url) return true;
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The first problem with a save, or null. */
export function validateInput(input: DeviceInput): string | null {
  if (typeof input !== "object" || input === null) return "Invalid device";
  const mac = String(input.macAddress ?? "").trim();
  if (mac && !isValidMac(mac)) return "Invalid MAC address";
  const broadcast = String(input.broadcastAddress ?? "").trim();
  if (broadcast && !isValidBroadcastAddress(broadcast)) {
    return "Invalid broadcast address";
  }
  if (!ADDRESS_RE.test(String(input.lanIp ?? ""))) return "Invalid LAN IP";
  const netmask = String(input.netmask ?? "");
  if (netmask && !isValidBroadcastAddress(netmask)) return "Invalid netmask";
  if (!validLink(String(input.linkUrl ?? ""))) return "Invalid link";
  if (!["magic", "custom"].includes(input.wakeMode)) return "Invalid wake mode";
  if (![7, 9].includes(input.wakePort)) return "The wake port must be 7 or 9";
  if (!["none", "ssh", "custom"].includes(input.shutdownMode)) {
    return "Invalid shutdown mode";
  }
  if (!["host", "relay", "server"].includes(input.commandTarget)) {
    return "Invalid command target";
  }
  if (
    !validRelay(input.wakeFrom) ||
    !validRelay(input.statusFrom) ||
    !validRelay(input.commandRelay)
  ) {
    return "Invalid relay host";
  }
  if (input.commandTarget === "relay" && !input.commandRelay) {
    return "Pick a relay host for this command";
  }
  if (
    !validTimeout(input.wakeTimeout) ||
    !validTimeout(input.shutdownTimeout)
  ) {
    return `Timeouts must be ${MIN_TIMEOUT} to ${MAX_TIMEOUT} seconds`;
  }
  if (!validPort(input.solPort)) return "Invalid Sleep-On-LAN port";
  for (const cron of [input.wakeCron, input.shutdownCron]) {
    if (cron && !isValidCron(cron)) return "Invalid cron expression";
  }
  for (const command of [
    input.wakeCommand,
    input.shutdownCommand,
    input.pingCommand,
  ]) {
    if (String(command ?? "").length > MAX_COMMAND) {
      return "That command is too long";
    }
  }
  if (input.wakeMode === "custom" && !input.wakeCommand?.trim()) {
    return "Enter a wake command";
  }
  if (input.shutdownMode === "custom" && !input.shutdownCommand?.trim()) {
    return "Enter a shutdown command";
  }
  if (input.secureOn && parseSecureOn(input.secureOn) === null) {
    return "The SecureON password must be 4 or 6 characters";
  }
  return null;
}

/** Every relay a save points at, which the saver must be able to reach. */
export function relaysOf(input: DeviceInput): number[] {
  const ids = [input.wakeFrom, input.statusFrom];
  if (input.commandTarget === "relay") ids.push(input.commandRelay);
  return [...new Set(ids.filter((id): id is number => id !== null))];
}

/** Whether anything saved would run on the Termix server. */
export function runsOnServer(input: DeviceInput): boolean {
  return (
    input.commandTarget === "server" &&
    Boolean(
      input.pingCommand?.trim() ||
      input.wakeMode === "custom" ||
      input.shutdownMode === "custom",
    )
  );
}

async function seal(ctx: PluginContext, value: string) {
  const trimmed = value.trim();
  return trimmed ? ctx.secrets.seal(trimmed) : null;
}

export async function toPatch(
  ctx: PluginContext,
  input: DeviceInput,
  current: DeviceRow,
  userId: string,
): Promise<Partial<DeviceRow>> {
  const patch: Partial<DeviceRow> = {
    lanIp: input.lanIp.trim(),
    netmask: input.netmask.trim(),
    description: input.description.trim() || null,
    linkUrl: input.linkUrl.trim() || null,
    autoOpenLink: input.autoOpenLink === true,
    wakeFrom: input.wakeFrom,
    wakePort: input.wakePort,
    wakeMode: input.wakeMode,
    wakeCommandSealed: await seal(ctx, input.wakeCommand),
    wakeTimeout: input.wakeTimeout,
    wakeConfirm: input.wakeConfirm === true,
    wakeCron: input.wakeCron.trim(),
    statusFrom: input.statusFrom,
    ports: parsePorts(input.ports).join(","),
    pingCommandSealed: await seal(ctx, input.pingCommand),
    shutdownMode: input.shutdownMode,
    shutdownCommandSealed: await seal(ctx, input.shutdownCommand),
    shutdownTimeout: input.shutdownTimeout,
    shutdownConfirm: input.shutdownConfirm === true,
    shutdownCron: input.shutdownCron.trim(),
    commandTarget: input.commandTarget,
    commandRelay: input.commandRelay,
    solEnabled: input.solEnabled === true,
    solPort: input.solPort,
    solUser: input.solUser.trim(),
    useBmc: input.useBmc === true,
    updatedBy: userId,
  };
  if (input.secureOn !== undefined) {
    patch.secureOnSealed = await seal(ctx, input.secureOn);
  }
  if (input.solPassword !== undefined) {
    patch.solPasswordSealed = input.solPassword
      ? await ctx.secrets.seal(input.solPassword)
      : null;
  }
  // A new schedule starts counting from now, not from its last run.
  const now = new Date().toISOString();
  if (patch.wakeCron !== current.wakeCron) patch.lastWakeRunAt = now;
  if (patch.shutdownCron !== current.shutdownCron) {
    patch.lastShutdownRunAt = now;
  }
  return patch;
}

export function statusOf(row: DeviceRow): PowerStatus {
  return row.status as PowerStatus;
}
