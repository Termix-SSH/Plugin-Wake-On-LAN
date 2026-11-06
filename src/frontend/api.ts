import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import {
  isElectron,
  resolveConnectionOrigin,
  resolveRemoteHostId,
} from "@termix-ssh/plugin-sdk/ui";
import type {
  CommandKind,
  DeviceDetail,
  DeviceInput,
  DeviceStatus,
  DeviceSummary,
  ScanResponse,
  TestResult,
} from "../shared/types";

export interface Allowed {
  wake: boolean;
  shutdown: boolean;
  scan: boolean;
  server: boolean;
}

export interface DeviceList {
  devices: DeviceSummary[];
  can: Allowed;
}

type WakeApp = Pick<TermixApp, "api" | "apiFor" | "getHost">;
let client: WakeApp | null = null;

export function initApi(app: WakeApp): void {
  client = app;
}

function api(): TermixApp["api"] {
  if (!client) throw new Error("Wake-on-LAN API is not ready");
  return client.api;
}

export function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { error?: string } } })
    ?.response?.data?.error;
  return message ?? fallback;
}

export const listDevices = async () =>
  (await api().get<DeviceList>("/devices")).data;

export const listStatuses = async () =>
  (await api().get<{ statuses: DeviceStatus[] }>("/status")).data.statuses;

export const getDevice = async (hostId: number) =>
  (await api().get<DeviceDetail>(`/devices/${hostId}`)).data;

export const saveDevice = (hostId: number, input: DeviceInput) =>
  api().put(`/devices/${hostId}`, input);

export const addDevice = async (input: {
  name: string;
  ip: string;
  mac: string;
  relayId: number | null;
}) => (await api().post<{ hostId: number }>("/devices", input)).data;

export type PowerAction = "wake" | "shutdown" | "sleep";

export async function runAction(hostId: number, action: PowerAction) {
  const local = api();
  if (action !== "wake" || !isElectron()) {
    return local.post(`/devices/${hostId}/${action}`);
  }
  const app = client!;
  const host = app.getHost(hostId);
  if (!host) throw new Error("Host not found");
  const origin = host.localOnly ? "local" : await resolveConnectionOrigin(host);
  if (origin === "local") return local.post(`/devices/${hostId}/wake`);
  const remoteId = await resolveRemoteHostId(host.syncId);
  if (remoteId == null) {
    throw new Error("The synced host does not exist on the remote server");
  }
  // Never fall back to this machine: its LAN may contain a different host.
  return app.apiFor("remote").post(`/devices/${remoteId}/wake`);
}

export const testCommand = async (hostId: number, kind: CommandKind) =>
  (await api().post<TestResult>(`/devices/${hostId}/test`, { kind })).data;

export const scan = async (input: { relayId: number | null; cidr: string }) =>
  (await api().post<ScanResponse>("/scan", input)).data;

export const attachResult = (input: {
  hostId: number;
  ip: string;
  mac: string;
  relayId: number | null;
}) => api().post("/scan/attach", input);
