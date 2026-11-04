import { useMemo, useState } from "react";
import { Power } from "lucide-react";
import { useHosts, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  FormFooter,
  InlineView,
  SectionCard,
  SelectField,
  TextField,
} from "@termix-ssh/plugin-sdk/ui";
import { addDevice, errorMessage, saveDevice, getDevice } from "./api";
import { reloadDevices, useDevices } from "./status-store";

const NEW = "new";
const SERVER = "server";

/**
 * Turns Power on for a host Termix already has, or makes a new one. A machine
 * that is already a host never needs a second entry for its LAN address.
 */
export function AddDeviceForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { hosts } = useHosts();
  const { devices } = useDevices();
  const [picked, setPicked] = useState(NEW);
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [mac, setMac] = useState("");
  const [relay, setRelay] = useState(SERVER);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const free = useMemo(() => {
    const taken = new Set(devices.map((device) => device.hostId));
    return hosts.filter((host) => !taken.has(Number(host.id)));
  }, [hosts, devices]);

  const relays = hosts
    .filter((host) => host.enableSsh !== false)
    .map((host) => ({ value: String(host.id), label: host.name || host.ip }));
  const relayId = relay === SERVER ? null : Number(relay);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (picked === NEW) {
        await addDevice({ name, ip, mac, relayId });
      } else {
        const hostId = Number(picked);
        const detail = await getDevice(hostId);
        await saveDevice(hostId, {
          ...detail.config,
          lanIp: ip.trim() || detail.config.lanIp,
          wakeFrom: relayId,
          macAddress: mac.trim(),
          broadcastAddress: detail.broadcastAddress,
        });
      }
      await reloadDevices();
      onClose();
    } catch (e) {
      setError(errorMessage(e, t("device.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("add.title")}
      icon={<Power className="size-4" />}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void save()}
          saving={saving}
          dirty
          status={
            error ? (
              <span className="text-destructive">{error}</span>
            ) : undefined
          }
        />
      }
    >
      <div className="p-3">
        <SectionCard
          title={t("device.general")}
          icon={<Power className="size-3.5" />}
        >
          <div className="flex flex-col gap-3 py-3">
            <SelectField<string>
              label={t("add.host")}
              value={picked}
              onChange={setPicked}
              options={[
                { value: NEW, label: t("add.newHost") },
                ...free.map((host) => ({
                  value: String(host.id),
                  label: host.name || host.ip,
                })),
              ]}
              hint={t("add.hostHint")}
            />
            {picked === NEW && (
              <TextField
                label={t("device.name")}
                value={name}
                onChange={setName}
              />
            )}
            <TextField
              label={t("device.lanIp")}
              value={ip}
              onChange={setIp}
              placeholder="192.168.1.2"
              hint={t("device.lanIpHint")}
              mono
            />
            <TextField
              label={t("device.mac")}
              value={mac}
              onChange={setMac}
              placeholder="AA:BB:CC:DD:EE:FF"
              mono
            />
            <SelectField<string>
              label={t("device.wakeFrom")}
              value={relay}
              onChange={setRelay}
              options={[
                { value: SERVER, label: t("device.fromServer") },
                ...relays,
              ]}
              hint={t("device.wakeFromHint")}
            />
          </div>
        </SectionCard>
      </div>
    </InlineView>
  );
}
