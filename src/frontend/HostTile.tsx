import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { timeAgo } from "./format";
import { PowerButton, StatusDot } from "./PowerButton";
import { useDevices } from "./status-store";

/** Power state and button for one host, on the host page. */
export function PowerHostTile({
  hostId,
  isVisible = true,
}: {
  hostId: number;
  isVisible?: boolean;
}) {
  const { t, language } = useTranslation();
  const { devices, can } = useDevices(isVisible);
  const device = devices.find((entry) => entry.hostId === Number(hostId));
  if (!device) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("tile.none")}</p>
    );
  }
  return (
    <div className="flex items-center gap-2 p-3 text-xs">
      <StatusDot status={device.status} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{t(`tile.status.${device.status}`)}</span>
        <span className="truncate text-muted-foreground">
          {device.status === "online"
            ? device.address
            : (timeAgo(device.lastSeenAt, language) ?? device.address)}
        </span>
      </div>
      <PowerButton device={device} can={can} />
    </div>
  );
}
