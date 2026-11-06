import { Power } from "lucide-react";
import {
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListRow,
  PanelList,
  StatusBadge,
} from "@termix-ssh/plugin-sdk/ui";
import { timeAgo } from "./format";
import { PowerButton, TONE } from "./PowerButton";
import { useDevices } from "./status-store";

const ROW_TONE = {
  online: "brand",
  offline: "muted",
  unknown: "muted",
  waking: "warning",
  stopping: "warning",
  failed: "destructive",
} as const;

/** Dashboard card: every device with its status and power button. */
export function WakeCard({ isVisible, shell }: DashboardCardProps) {
  const { t, language } = useTranslation();
  const { devices, can } = useDevices(isVisible !== false);
  return (
    <PanelList
      empty={
        <div className="flex flex-col items-start gap-2 p-3">
          <p className="text-xs text-muted-foreground">{t("card.empty")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => shell.openSingletonTab("power")}
          >
            <Power className="size-3.5" />
            {t("tab.title")}
          </Button>
        </div>
      }
    >
      {devices.map((device, index) => (
        <ListRow
          key={device.hostId}
          stripe={index}
          tone={ROW_TONE[device.status]}
          badges={
            <StatusBadge tone={TONE[device.status]}>
              {t(`status.${device.status}`)}
            </StatusBadge>
          }
          title={device.name}
          meta={
            device.status === "online"
              ? device.address
              : (timeAgo(device.lastSeenAt, language) ?? device.address)
          }
          trailing={<PowerButton device={device} can={can} />}
        />
      ))}
    </PanelList>
  );
}
