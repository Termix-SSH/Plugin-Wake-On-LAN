import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Loader2, Moon, Power } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  StatusDot as SdkStatusDot,
  useConfirm,
  type StatusTone,
} from "@termix-ssh/plugin-sdk/ui";
import type { DeviceSummary } from "../shared/types";
import type { Allowed, PowerAction } from "./api";
import { powerAction } from "./host-action";

// Offline is idle here: a powered off machine is normal, not an error.
export const TONE: Record<DeviceSummary["status"], StatusTone> = {
  online: "ok",
  offline: "idle",
  unknown: "idle",
  waking: "warn",
  stopping: "warn",
  failed: "bad",
};

export function StatusDot({ status }: { status: DeviceSummary["status"] }) {
  const { t } = useTranslation();
  return (
    <span role="img" aria-label={t(`status.${status}`)} className="inline-flex">
      <SdkStatusDot
        tone={TONE[status]}
        pulse={status === "waking" || status === "stopping"}
        title={t(`status.${status}`)}
      />
    </span>
  );
}

export function isBusy(device: Pick<DeviceSummary, "status">): boolean {
  return device.status === "waking" || device.status === "stopping";
}

/** What the main button does now, or null when it can do nothing. */
export function mainAction(
  device: DeviceSummary,
  can: Allowed,
): PowerAction | null {
  if (device.status === "online") {
    return device.canShutdown && can.shutdown ? "shutdown" : null;
  }
  return device.canWake && can.wake ? "wake" : null;
}

/** Opens the link once a wake started here reaches online. */
function useOpenAfterWake(device: DeviceSummary) {
  const waiting = useRef(false);
  useEffect(() => {
    if (device.status === "failed") waiting.current = false;
    if (!waiting.current || device.status !== "online") return;
    waiting.current = false;
    if (device.autoOpenLink && device.linkUrl) {
      window.open(device.linkUrl, "_blank", "noopener");
    }
  }, [device.status, device.autoOpenLink, device.linkUrl]);
  return waiting;
}

export function PowerButton({
  device,
  can,
}: {
  device: DeviceSummary;
  can: Allowed;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [sending, setSending] = useState(false);
  const waiting = useOpenAfterWake(device);
  const action = mainAction(device, can);
  const busy = sending || isBusy(device);

  const press = async (event: MouseEvent) => {
    event.stopPropagation();
    if (!action) return;
    setSending(true);
    const started = await powerAction(device, action, t, confirm);
    if (started && action === "wake") waiting.current = true;
    setSending(false);
  };

  const title = action ? t(`power.${action}`) : t(`status.${device.status}`);
  return (
    <Button
      variant="outline"
      size="icon"
      disabled={!action || busy}
      onClick={(event: MouseEvent) => void press(event)}
      title={title}
      aria-label={title}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Power
          className={`size-4 ${device.status === "online" ? "text-emerald-500" : ""}`}
        />
      )}
    </Button>
  );
}

export function SleepButton({
  device,
  can,
}: {
  device: DeviceSummary;
  can: Allowed;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  if (!device.canSleep || !can.shutdown || device.status !== "online") {
    return null;
  }
  return (
    <Button
      variant="outline"
      size="icon"
      title={t("power.sleep")}
      aria-label={t("power.sleep")}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        void powerAction(device, "sleep", t, confirm);
      }}
    >
      <Moon className="size-4" />
    </Button>
  );
}
