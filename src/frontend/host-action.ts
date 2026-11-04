import { toast } from "sonner";
import type {
  ConfirmRequest,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import type { DeviceSummary } from "../shared/types";
import { errorMessage, runAction, type PowerAction } from "./api";
import { pokeStatus, reloadDevices } from "./status-store";

export function macAddressOf(
  host: Pick<PluginHostRecord, "pluginSettings"> | null | undefined,
): string | null {
  const macAddress = host?.pluginSettings?.["wake-on-lan"]?.macAddress;
  return typeof macAddress === "string" && macAddress.trim()
    ? macAddress.trim()
    : null;
}

export function hasMacAddress(
  host: Pick<PluginHostRecord, "pluginSettings">,
): boolean {
  return macAddressOf(host) !== null;
}

/** Asks first when the device wants that, then runs the action with toasts. */
export async function powerAction(
  device: Pick<
    DeviceSummary,
    "hostId" | "name" | "wakeConfirm" | "shutdownConfirm"
  >,
  action: PowerAction,
  t: TermixApp["t"],
  confirm: (options: ConfirmRequest) => Promise<boolean>,
): Promise<boolean> {
  const ask = action === "wake" ? device.wakeConfirm : device.shutdownConfirm;
  if (ask) {
    const ok = await confirm({
      title: t(`power.confirm.${action}`, { name: device.name }),
      confirmLabel: t(`power.${action}`),
      destructive: action !== "wake",
    });
    if (!ok) return false;
  }
  try {
    await runAction(device.hostId, action);
    toast.success(t(`power.sent.${action}`, { name: device.name }));
    await reloadDevices();
    pokeStatus();
    return true;
  } catch (error) {
    toast.error(errorMessage(error, t(`power.failed.${action}`)));
    return false;
  }
}
