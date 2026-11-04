import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Power, Radar, Settings2 } from "lucide-react";
import {
  usePluginPanelView,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  Button,
  DataView,
  EmptyState,
  ListBadge,
  PanelSearch,
  PanelShell,
  ViewToggle,
  useConfirm,
  type DataColumn,
} from "@termix-ssh/plugin-sdk/ui";
import type { DeviceSummary } from "../shared/types";
import { AddDeviceForm } from "./AddDeviceForm";
import { DeviceForm } from "./DeviceForm";
import { timeAgo } from "./format";
import { powerAction } from "./host-action";
import { PowerButton, SleepButton, StatusDot, mainAction } from "./PowerButton";
import { ScanView } from "./ScanView";
import { useDevices } from "./status-store";

type View =
  | { kind: "list" }
  | { kind: "edit"; hostId: number }
  | { kind: "add" }
  | { kind: "scan" };

export function PowerTab({
  isVisible,
  focusHostId,
}: {
  isVisible: boolean;
  focusHostId: number | null;
}) {
  const { t, language } = useTranslation();
  const confirm = useConfirm();
  const panel = usePluginPanelView("power-");
  const { devices, can, loaded, failed } = useDevices(isVisible);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });

  useEffect(() => {
    if (focusHostId) setView({ kind: "edit", hostId: focusHostId });
  }, [focusHostId]);

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const shown = devices.filter((device) =>
      [device.name, device.address, device.macAddress, device.description]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
    const byFolder = new Map<string, DeviceSummary[]>();
    for (const device of shown) {
      const folder = device.folder ?? "";
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), device]);
    }
    return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [devices, search]);

  const back = () => setView({ kind: "list" });

  if (view.kind === "edit") {
    return <DeviceForm key={view.hostId} hostId={view.hostId} onClose={back} />;
  }
  if (view.kind === "add") return <AddDeviceForm onClose={back} />;
  if (view.kind === "scan") return <ScanView onClose={back} />;

  const online = devices.filter((d) => d.status === "online").length;

  const wakeAll = async (items: DeviceSummary[], folder: string) => {
    const asleep = items.filter((d) => mainAction(d, can) === "wake");
    if (asleep.length === 0) return;
    const ok = await confirm({
      title: t("tab.wakeAllConfirm", { count: asleep.length, folder }),
      confirmLabel: t("tab.wakeAll"),
      destructive: false,
    });
    if (!ok) return;
    await Promise.all(
      asleep.map((device) =>
        powerAction({ ...device, wakeConfirm: false }, "wake", t, confirm),
      ),
    );
  };

  const name = (device: DeviceSummary) =>
    device.linkUrl ? (
      <a
        href={device.linkUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(event: MouseEvent) => event.stopPropagation()}
        className="truncate font-medium hover:underline"
      >
        {device.name}
      </a>
    ) : (
      <span className="truncate font-medium">{device.name}</span>
    );

  const seen = (device: DeviceSummary) =>
    device.status === "online" || device.status === "offline"
      ? timeAgo(device.statusChangedAt, language)
      : t(`status.${device.status}`);

  const settings = (device: DeviceSummary) =>
    device.canEdit ? (
      <Button
        variant="ghost"
        size="icon"
        title={t("power.settings")}
        aria-label={t("power.settings")}
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          setView({ kind: "edit", hostId: device.hostId });
        }}
      >
        <Settings2 className="size-4" />
      </Button>
    ) : null;

  const columns: DataColumn<DeviceSummary>[] = [
    {
      key: "status",
      header: "",
      width: "24px",
      cell: (device) => <StatusDot status={device.status} />,
    },
    { key: "name", header: t("device.name"), width: "2fr", cell: name },
    {
      key: "address",
      header: t("device.lanIp"),
      width: "1fr",
      hideBelow: "md",
      cell: (device) => <span className="font-mono">{device.address}</span>,
    },
    {
      key: "mac",
      header: t("device.mac"),
      width: "1fr",
      hideBelow: "lg",
      cell: (device) => <span className="font-mono">{device.macAddress}</span>,
    },
    {
      key: "seen",
      header: t("device.lastChange"),
      width: "120px",
      hideBelow: "md",
      cell: seen,
    },
    {
      key: "actions",
      header: "",
      width: "120px",
      align: "end",
      cell: (device) => (
        <div className="flex items-center justify-end gap-1">
          {settings(device)}
          <SleepButton device={device} can={can} />
          <PowerButton device={device} can={can} />
        </div>
      ),
    },
  ];

  const card = (device: DeviceSummary) => (
    <div className="flex h-full flex-col gap-2 border border-border bg-card p-3 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <StatusDot status={device.status} />
        {name(device)}
      </div>
      <div className="min-w-0 font-mono text-muted-foreground">
        <div className="truncate">{device.address}</div>
        <div className="truncate">{device.macAddress || t("device.noMac")}</div>
      </div>
      {device.description && (
        <p className="line-clamp-2 text-muted-foreground">
          {device.description}
        </p>
      )}
      {device.openPorts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {device.openPorts.map((port) => (
            <ListBadge key={port}>{port}</ListBadge>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-center gap-1 pt-1">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {seen(device)}
        </span>
        {settings(device)}
        <SleepButton device={device} can={can} />
        <PowerButton device={device} can={can} />
      </div>
    </div>
  );

  return (
    <div className="h-full w-full overflow-hidden">
      <div className="flex h-full w-full min-h-0 flex-1 flex-col overflow-hidden">
        <PanelShell
          icon={<Power className="size-4" />}
          title={t("tab.title")}
          status={t("tab.status", { online, total: devices.length })}
          actions={
            <>
              {can.scan && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setView({ kind: "scan" })}
                >
                  <Radar className="size-3.5" />
                  {t("tab.scan")}
                </Button>
              )}
              <AddButton
                label={t("tab.add")}
                onClick={() => setView({ kind: "add" })}
              />
            </>
          }
          toolbar={
            <>
              <PanelSearch
                value={search}
                onChange={setSearch}
                placeholder={t("tab.search")}
              />
              <ViewToggle
                view={panel.view}
                onView={panel.setView}
                columns={panel.columns}
                onColumns={panel.setColumns}
              />
            </>
          }
        >
          {failed && devices.length === 0 ? (
            <p className="p-6 text-center text-xs text-destructive">
              {t("tab.failed")}
            </p>
          ) : groups.length === 0 ? (
            loaded && (
              <EmptyState
                icon={Power}
                title={t(search ? "tab.noMatch" : "tab.empty")}
                hint={search ? undefined : t("tab.emptyHint")}
              />
            )
          ) : (
            <div className="flex flex-col gap-4 p-3">
              {groups.map(([folder, items]) => (
                <section key={folder} className="flex flex-col gap-2">
                  {(folder || groups.length > 1) && (
                    <div className="flex items-center gap-2">
                      <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                        {folder || t("tab.noFolder")}
                      </h3>
                      {can.wake && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            void wakeAll(items, folder || t("tab.noFolder"))
                          }
                        >
                          {t("tab.wakeAll")}
                        </Button>
                      )}
                    </div>
                  )}
                  <DataView
                    items={items}
                    view={panel.view}
                    getKey={(device) => String(device.hostId)}
                    columns={{ base: 1, md: 2, xl: 3 }}
                    size={panel.columns}
                    listColumns={columns}
                    empty={null}
                    renderCard={card}
                  />
                </section>
              ))}
            </div>
          )}
        </PanelShell>
      </div>
    </div>
  );
}
