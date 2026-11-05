import { useState } from "react";
import { Radar } from "lucide-react";
import { useHosts, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  InlineView,
  ListBadge,
  ListRow,
  PanelList,
  SectionCard,
  SelectField,
  TextField,
  Select2,
} from "@termix-ssh/plugin-sdk/ui";
import type { ScanResponse, ScanResult } from "../shared/types";
import { addDevice, attachResult, errorMessage, scan } from "./api";
import { reloadDevices, useDevices } from "./status-store";

const SERVER = "server";
const NEW = "new";

/** The key a result's chosen host is kept under. */
const keyOf = (result: ScanResult) => `${result.ip}|${result.mac}`;

export function ScanView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { hosts } = useHosts();
  const { can } = useDevices();
  const relays = hosts
    .filter((host) => host.enableSsh !== false)
    .map((host) => ({ value: String(host.id), label: host.name || host.ip }));
  const [from, setFrom] = useState("");
  const [cidr, setCidr] = useState("");
  const [response, setResponse] = useState<ScanResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});

  const relayId = from === SERVER || !from ? null : Number(from);

  const start = async () => {
    setScanning(true);
    setError("");
    setResponse(null);
    setDone({});
    try {
      setResponse(await scan({ relayId, cidr: cidr.trim() }));
    } catch (e) {
      setError(errorMessage(e, t("scan.failed")));
    } finally {
      setScanning(false);
    }
  };

  const chosen = (result: ScanResult) =>
    choice[keyOf(result)] ?? (result.match ? String(result.match.hostId) : NEW);

  const apply = async (result: ScanResult) => {
    setError("");
    const target = chosen(result);
    try {
      if (target === NEW) {
        await addDevice({
          name: result.name.split(".")[0] || result.ip,
          ip: result.ip,
          mac: result.mac,
          relayId,
        });
      } else {
        await attachResult({
          hostId: Number(target),
          ip: result.ip,
          mac: result.mac,
          relayId,
        });
      }
      setDone((current) => ({ ...current, [keyOf(result)]: true }));
      await reloadDevices();
    } catch (e) {
      setError(errorMessage(e, t("scan.addFailed")));
    }
  };

  const hostOptions = [
    { value: NEW, label: t("scan.newHost") },
    ...hosts.map((host) => ({
      value: String(host.id),
      label: t("scan.attachTo", { name: host.name || host.ip }),
    })),
  ];

  return (
    <InlineView
      stacked
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("scan.title")}
      icon={<Radar className="size-4" />}
    >
      <>
        <SectionCard
          title={t("scan.where")}
          icon={<Radar className="size-3.5" />}
        >
          <div className="flex flex-col gap-3 py-3">
            <SelectField<string>
              label={t("scan.from")}
              value={from}
              onChange={setFrom}
              options={[
                ...relays,
                ...(can.server
                  ? [{ value: SERVER, label: t("device.fromServer") }]
                  : []),
              ]}
              placeholder={t("device.pickHost")}
              hint={t("scan.fromHint")}
            />
            <TextField
              label={t("scan.range")}
              value={cidr}
              onChange={setCidr}
              placeholder="192.168.1.0/24"
              hint={t(from === SERVER ? "scan.rangeNeeded" : "scan.rangeHint")}
              mono
            />
            <Button
              size="sm"
              className="self-start"
              disabled={scanning || !from}
              onClick={() => void start()}
            >
              <Radar className="size-3.5" />
              {scanning ? t("scan.scanning") : t("scan.start")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("scan.note")}</p>
          </div>
        </SectionCard>

        {error && (
          <p className="border-b border-border px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {response?.hint && (
          <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            {t(`scan.hint.${response.hint}`)}
          </p>
        )}

        {response && (
          <PanelList
            empty={
              <p className="p-3 text-xs text-muted-foreground">
                {t("scan.none")}
              </p>
            }
          >
            {response.results.map((result, index) => (
              <ListRow
                key={keyOf(result)}
                stripe={index}
                title={result.name || result.ip}
                meta={
                  <span className="font-mono">
                    {result.ip} | {result.mac || t("scan.noMac")}
                    {result.vendor ? ` | ${result.vendor}` : ""}
                  </span>
                }
                badges={
                  result.match ? (
                    <ListBadge>
                      {t(`scan.match.${result.match.by}`, {
                        name: result.match.name,
                      })}
                    </ListBadge>
                  ) : undefined
                }
                trailing={
                  done[keyOf(result)] ? (
                    <span className="text-xs text-muted-foreground">
                      {t("scan.added")}
                    </span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Select2
                        className="h-8 max-w-48 px-2.5 text-xs"
                        value={chosen(result)}
                        aria-label={t("scan.choose")}
                        onChange={(event) =>
                          setChoice((current) => ({
                            ...current,
                            [keyOf(result)]: event.target.value,
                          }))
                        }
                      >
                        {hostOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select2>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!result.mac}
                        onClick={() => void apply(result)}
                      >
                        {chosen(result) === NEW
                          ? t("scan.add")
                          : t("scan.attach")}
                      </Button>
                    </div>
                  )
                }
              />
            ))}
          </PanelList>
        )}
      </>
    </InlineView>
  );
}
