import type { ComponentType } from "react";
import { Power, Settings2, Zap } from "lucide-react";
import type { TabProps, TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { initApi } from "./api";
import { hasMacAddress, macAddressOf, powerAction } from "./host-action";
import { powerWidget } from "./HomepageWidget";
import { PowerHostTile } from "./HostTile";
import { PowerTab } from "./PowerTab";
import {
  currentCan,
  currentDevice,
  startStatusPolling,
  stopStatusPolling,
} from "./status-store";
import { WakeCard } from "./WakeCard";

const TAB_ID = "power";

function Tab({ isVisible, tab }: TabProps) {
  const hostId = tab.data?.hostId;
  return (
    <PowerTab
      isVisible={isVisible}
      focusHostId={typeof hostId === "number" ? hostId : null}
    />
  );
}

export function activate(app: TermixApp): void {
  initApi(app);
  startStatusPolling();

  app.registerTab(TAB_ID, Tab, {
    icon: Power,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
  });
  app.registerRailItem({
    id: TAB_ID,
    icon: Power,
    titleKey: "tab.title",
    kind: "tab",
    order: 30,
  });

  const device = (host: { id: number | string }) =>
    currentDevice(Number(host.id));

  // The list fills in shortly after start. Until then Wake shows on any host
  // with a MAC, and the route answers for anything it can't do.
  app.registerHostAction({
    id: "wake-on-lan",
    titleKey: "power.wake",
    icon: Zap,
    kind: "open",
    order: 50,
    when: (host) => hasMacAddress(host) && device(host)?.status !== "online",
    run: (host) => {
      void powerAction(
        device(host) ?? {
          hostId: Number(host.id),
          name: host.name || host.ip,
          wakeConfirm: false,
          shutdownConfirm: true,
        },
        "wake",
        app.t,
        app.confirm,
      );
    },
  });
  app.registerHostAction({
    id: "wake-on-lan.shutdown",
    titleKey: "power.shutdown",
    icon: Power,
    kind: "open",
    order: 51,
    when: (host) => {
      const known = device(host);
      return (
        !!known &&
        known.canShutdown &&
        known.status === "online" &&
        currentCan().shutdown
      );
    },
    run: (host) => {
      const known = device(host);
      if (known) void powerAction(known, "shutdown", app.t, app.confirm);
    },
  });
  app.registerHostAction({
    id: "wake-on-lan.settings",
    titleKey: "power.settings",
    icon: Settings2,
    kind: "open",
    order: 52,
    tray: false,
    when: (host) => !!device(host)?.canEdit,
    run: (host, shell) =>
      shell.openSingletonTab(TAB_ID, { data: { hostId: Number(host.id) } }),
  });

  app.registerDashboardCard({
    id: "wake-on-lan",
    titleKey: "card.title",
    defaultPanel: "side",
    defaultHeight: 220,
    frame: "framed",
    component: WakeCard,
  });

  app.registerSlotContribution("host-page.tiles", {
    actionId: "wake-on-lan.hostTile",
    titleKey: "tile.title",
    icon: Power,
    kind: "component",
    component: PowerHostTile as unknown as ComponentType<
      Record<string, unknown>
    >,
    when: (context?: { host?: { id: number | string } }) =>
      !context?.host || !!device(context.host),
  });

  app.registerExtension("homepage.widgets", powerWidget(app.t));

  // A saved host's MAC address, for plugins that send their own wake packet.
  app.registerAction("wakeOnLan.macAddress", ((hostId: string | number) =>
    macAddressOf(app.getHost(hostId))) as never);
}

export function deactivate(): void {
  stopStatusPolling();
}
