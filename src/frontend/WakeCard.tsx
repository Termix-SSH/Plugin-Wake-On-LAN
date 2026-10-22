import { Zap } from "lucide-react";
import {
  useHosts,
  usePermission,
  usePluginApi,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { ListRow, ListRowAction, PanelList } from "@termix-ssh/plugin-sdk/ui";
import { macAddressOf, wakeHost } from "./host-action.js";

/** Dashboard card: every host with a MAC address, with a Wake button. */
export function WakeCard(_props: DashboardCardProps) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const allowed = usePermission("send");
  const { hosts } = useHosts();
  const wakeable = hosts.filter((host) => macAddressOf(host) !== null);
  return (
    <PanelList
      empty={
        <p className="p-3 text-xs text-muted-foreground">{t("card.empty")}</p>
      }
    >
      {wakeable.map((host, index) => (
        <ListRow
          key={host.id}
          stripe={index}
          title={host.name || host.ip}
          meta={macAddressOf(host)}
          actions={
            allowed ? (
              <ListRowAction
                label={t("hostAction.title")}
                tone="brand"
                onClick={() => wakeHost(api, t, String(host.id))}
              >
                <Zap />
              </ListRowAction>
            ) : undefined
          }
        />
      ))}
    </PanelList>
  );
}
