export type PowerStatus =
  "unknown" | "online" | "offline" | "waking" | "stopping" | "failed";

export type WakeMode = "magic" | "custom";
export type ShutdownMode = "none" | "ssh" | "custom";
export type CommandTarget = "host" | "relay" | "server";

/** Sealed values the browser may set but never reads. */
export interface DeviceSecrets {
  hasSecureOn: boolean;
  hasSolPassword: boolean;
}

export interface DeviceConfig {
  lanIp: string;
  netmask: string;
  description: string;
  linkUrl: string;
  autoOpenLink: boolean;
  wakeFrom: number | null;
  wakePort: number;
  wakeMode: WakeMode;
  wakeCommand: string;
  wakeTimeout: number;
  wakeConfirm: boolean;
  wakeCron: string;
  statusFrom: number | null;
  ports: string;
  pingCommand: string;
  shutdownMode: ShutdownMode;
  shutdownCommand: string;
  shutdownTimeout: number;
  shutdownConfirm: boolean;
  shutdownCron: string;
  commandTarget: CommandTarget;
  commandRelay: number | null;
  solEnabled: boolean;
  solPort: number;
  solUser: string;
  // Use the Out-of-band plugin for wake and shutdown when the host has a BMC
  useBmc: boolean;
}

/** A save. A password left out stays as it is, an empty one clears it. */
export interface DeviceInput extends DeviceConfig {
  macAddress: string;
  broadcastAddress: string;
  secureOn?: string;
  solPassword?: string;
}

/** One card on the Power tab. */
export interface DeviceSummary {
  hostId: number;
  name: string;
  address: string;
  folder: string | null;
  macAddress: string;
  description: string;
  linkUrl: string;
  autoOpenLink: boolean;
  status: PowerStatus;
  openPorts: number[];
  statusChangedAt: string | null;
  lastSeenAt: string | null;
  wakeConfirm: boolean;
  shutdownConfirm: boolean;
  canWake: boolean;
  canShutdown: boolean;
  canSleep: boolean;
  canEdit: boolean;
}

export interface DeviceStatus {
  hostId: number;
  status: PowerStatus;
  openPorts: number[];
  statusChangedAt: string | null;
  lastSeenAt: string | null;
}

export interface DeviceDetail {
  summary: DeviceSummary;
  macAddress: string;
  broadcastAddress: string;
  config: DeviceConfig;
  secrets: DeviceSecrets;
}

export interface ScanMatch {
  hostId: number;
  name: string;
  /** How the host was matched, best first. */
  by: "mac" | "ip" | "name";
  hasMac: boolean;
}

export interface ScanResult {
  ip: string;
  mac: string;
  name: string;
  vendor: string;
  match: ScanMatch | null;
}

export interface ScanResponse {
  results: ScanResult[];
  /** Why few or no results came back, when that can be told. */
  hint: "bridge" | "no-mac" | null;
}

export type CommandKind = "wake" | "shutdown" | "ping";

export interface TestResult {
  ok: boolean;
  code: number | null;
  output: string;
}
