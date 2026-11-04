import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
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

let client: TermixApp["api"] | null = null;

export function initApi(api: TermixApp["api"]): void {
  client = api;
}

function api(): TermixApp["api"] {
  if (!client) throw new Error("Wake-on-LAN API is not ready");
  return client;
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

export const runAction = (hostId: number, action: PowerAction) =>
  api().post(`/devices/${hostId}/${action}`);

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
