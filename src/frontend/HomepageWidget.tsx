import type { ComponentType, ReactNode } from "react";
import { Power } from "lucide-react";
import {
  useTranslation,
  type ExtensionContribution,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { Checkbox, WidgetTitle } from "@termix-ssh/plugin-sdk/ui";
import { PowerButton, StatusDot } from "./PowerButton";
import { useDevices } from "./status-store";

const GRID_SIZE = 30;

interface PowerWidgetConfig {
  /** Empty means every device. */
  hostIds: number[];
}

interface WidgetProps {
  widget: { title?: string | null };
  config: PowerWidgetConfig;
}

interface EditProps {
  config: PowerWidgetConfig;
  onChange: (config: PowerWidgetConfig) => void;
}

/** What app.registerExtension("homepage.widgets", ...) takes. */
interface WidgetDefinition extends ExtensionContribution {
  id: string;
  name: string;
  description: string;
  category: "links" | "info" | "system" | "monitoring";
  icon: ReactNode;
  defaultConfig: PowerWidgetConfig;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  components: {
    view: ComponentType<WidgetProps>;
    editForm?: ComponentType<EditProps>;
  };
}

function PowerWidget({ widget, config }: WidgetProps) {
  const { t } = useTranslation();
  const { devices, can } = useDevices();
  const picked = config.hostIds ?? [];
  const shown = picked.length
    ? devices.filter((device) => picked.includes(device.hostId))
    : devices;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <WidgetTitle title={widget.title} icon={<Power size={11} />} />
      <div
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {shown.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">{t("card.empty")}</p>
        )}
        {shown.map((device) => (
          <div
            key={device.hostId}
            className="flex min-w-0 items-center gap-2 px-1 text-xs"
          >
            <StatusDot status={device.status} />
            {device.linkUrl ? (
              <a
                href={device.linkUrl}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate hover:underline"
              >
                {device.name}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate">{device.name}</span>
            )}
            <PowerButton device={device} can={can} />
          </div>
        ))}
      </div>
    </div>
  );
}

function PowerWidgetEditForm({ config, onChange }: EditProps) {
  const { t } = useTranslation();
  const { devices } = useDevices();
  const picked = config.hostIds ?? [];
  const toggle = (hostId: number, on: boolean) =>
    onChange({
      ...config,
      hostIds: on ? [...picked, hostId] : picked.filter((id) => id !== hostId),
    });
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {t("widget.pick")}
      </span>
      {devices.map((device) => (
        <label key={device.hostId} className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={picked.includes(device.hostId)}
            onCheckedChange={(value) => toggle(device.hostId, value === true)}
          />
          {device.name}
        </label>
      ))}
    </div>
  );
}

export function powerWidget(t: TermixApp["t"]): WidgetDefinition {
  return {
    id: "power",
    name: t("widget.name"),
    description: t("widget.description"),
    category: "monitoring",
    icon: <Power size={16} />,
    defaultConfig: { hostIds: [] },
    defaultSize: { w: 10 * GRID_SIZE, h: 8 * GRID_SIZE },
    minSize: { w: 6 * GRID_SIZE, h: 4 * GRID_SIZE },
    components: { view: PowerWidget, editForm: PowerWidgetEditForm },
  };
}
