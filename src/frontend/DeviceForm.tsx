import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Info,
  Moon,
  Play,
  Power,
  SquareTerminal,
  Zap,
} from "lucide-react";
import { useHosts, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  FormFooter,
  InlineView,
  NumberField,
  SectionCard,
  SelectField,
  SwitchRow,
  TextAreaField,
  TextField,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import type {
  CommandKind,
  CommandTarget,
  DeviceInput,
  ShutdownMode,
  TestResult,
  WakeMode,
} from "../shared/types";
import { errorMessage, getDevice, saveDevice, testCommand } from "./api";
import { reloadDevices, useDevices } from "./status-store";

const SERVER = "server";

function relayValue(id: number | null): string {
  return id ? String(id) : SERVER;
}

function relayId(value: string): number | null {
  return value === SERVER ? null : Number(value);
}

export function DeviceForm({
  hostId,
  onClose,
}: {
  hostId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { hosts } = useHosts();
  const { can } = useDevices();
  const [form, setForm] = useState<DeviceInput | null>(null);
  const [name, setName] = useState("");
  const [secrets, setSecrets] = useState({
    hasSecureOn: false,
    hasSolPassword: false,
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<
    (TestResult & { kind: CommandKind }) | null
  >(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let live = true;
    getDevice(hostId)
      .then((detail) => {
        if (!live) return;
        setName(detail.summary.name);
        setSecrets(detail.secrets);
        setForm({
          ...detail.config,
          macAddress: detail.macAddress,
          broadcastAddress: detail.broadcastAddress,
        });
      })
      .catch((e: unknown) => setError(errorMessage(e, t("device.loadFailed"))));
    return () => {
      live = false;
    };
  }, [hostId, t]);

  const relayOptions = useMemo(
    () =>
      hosts
        .filter((host) => host.enableSsh !== false)
        .filter((host) => Number(host.id) !== hostId)
        .map((host) => ({
          value: String(host.id),
          label: host.name || host.ip,
        })),
    [hosts, hostId],
  );
  const withServer = [
    { value: SERVER, label: t("device.fromServer") },
    ...relayOptions,
  ];

  const set = (patch: Partial<DeviceInput>) => {
    setDirty(true);
    setForm((current) => (current ? { ...current, ...patch } : current));
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError("");
    try {
      await saveDevice(hostId, form);
      await reloadDevices();
      setDirty(false);
      onClose();
    } catch (e) {
      setError(errorMessage(e, t("device.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const test = async (kind: CommandKind) => {
    if (kind === "shutdown") {
      const ok = await confirm({
        title: t("device.testShutdownConfirm", { name }),
        confirmLabel: t("device.test"),
      });
      if (!ok) return;
    }
    setTesting(true);
    setResult(null);
    try {
      setResult({ ...(await testCommand(hostId, kind)), kind });
    } catch (e) {
      setError(errorMessage(e, t("device.testFailed")));
    } finally {
      setTesting(false);
    }
  };

  const testButton = (kind: CommandKind) => (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={dirty || testing}
        title={dirty ? t("device.saveFirst") : undefined}
        onClick={() => void test(kind)}
      >
        <Play className="size-3.5" />
        {t("device.test")}
      </Button>
      {result?.kind === kind && (
        <pre
          className={`max-h-40 overflow-auto border border-border p-2 text-xs ${result.ok ? "" : "text-destructive"}`}
        >
          {t("device.exitCode", { code: result.code ?? "-" })}
          {result.output ? `\n${result.output}` : ""}
        </pre>
      )}
    </div>
  );

  const names = { ip: "{{ DEVICE_IP }}", mac: "{{ DEVICE_MAC }}" };
  const placeholders = t("device.placeholders", names);
  const usesCommands =
    form &&
    (form.wakeMode === "custom" ||
      form.shutdownMode === "custom" ||
      form.pingCommand.trim() !== "");

  return (
    <InlineView
      stacked
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={name || t("device.title")}
      icon={<Power className="size-4" />}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void save()}
          saving={saving}
          dirty={dirty}
          status={
            error ? (
              <span className="text-destructive">{error}</span>
            ) : undefined
          }
          disabled={!form}
        />
      }
    >
      {!form ? (
        error ? (
          <p className="p-4 text-xs text-destructive">{error}</p>
        ) : null
      ) : (
        <>
          <SectionCard
            title={t("device.general")}
            icon={<Info className="size-3.5" />}
          >
            <div className="flex flex-col gap-3 py-3">
              <TextField
                label={t("device.mac")}
                value={form.macAddress}
                onChange={(macAddress) => set({ macAddress })}
                placeholder="AA:BB:CC:DD:EE:FF"
                mono
              />
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label={t("device.lanIp")}
                  value={form.lanIp}
                  onChange={(lanIp) => set({ lanIp })}
                  placeholder="192.168.1.2"
                  hint={t("device.lanIpHint")}
                  mono
                />
                <TextField
                  label={t("device.netmask")}
                  value={form.netmask}
                  onChange={(netmask) => set({ netmask })}
                  placeholder="255.255.255.0"
                  hint={t("device.netmaskHint")}
                  mono
                />
              </div>
              <TextField
                label={t("device.description")}
                value={form.description}
                onChange={(description) => set({ description })}
              />
              <TextField
                label={t("device.link")}
                value={form.linkUrl}
                onChange={(linkUrl) => set({ linkUrl })}
                placeholder="https://"
                hint={t("device.linkHint")}
              />
              <SwitchRow
                label={t("device.autoOpen")}
                description={t("device.autoOpenHint")}
                checked={form.autoOpenLink}
                onChange={(autoOpenLink) => set({ autoOpenLink })}
              />
            </div>
          </SectionCard>

          <SectionCard
            title={t("device.status")}
            icon={<Activity className="size-3.5" />}
          >
            <div className="flex flex-col gap-3 py-3">
              <SelectField<string>
                label={t("device.statusFrom")}
                value={relayValue(form.statusFrom)}
                onChange={(value) => set({ statusFrom: relayId(value) })}
                options={withServer}
                hint={t("device.statusFromHint")}
              />
              <TextField
                label={t("device.ports")}
                value={form.ports}
                onChange={(ports) => set({ ports })}
                placeholder="22, 3389, 8080"
                hint={t("device.portsHint")}
                mono
              />
              <TextAreaField
                label={t("device.pingCommand")}
                value={form.pingCommand}
                onChange={(pingCommand) => set({ pingCommand })}
                hint={t("device.pingCommandHint", names)}
                rows={2}
                mono
              />
              {form.pingCommand.trim() !== "" && testButton("ping")}
            </div>
          </SectionCard>

          <SectionCard
            title={t("device.wake")}
            icon={<Zap className="size-3.5" />}
          >
            <div className="flex flex-col gap-3 py-3">
              <SelectField<WakeMode>
                label={t("device.wakeMode")}
                value={form.wakeMode}
                onChange={(wakeMode) => set({ wakeMode })}
                options={[
                  { value: "magic", label: t("device.wakeMagic") },
                  { value: "custom", label: t("device.commandMode") },
                ]}
              />
              {form.wakeMode === "magic" ? (
                <>
                  <SelectField<string>
                    label={t("device.wakeFrom")}
                    value={relayValue(form.wakeFrom)}
                    onChange={(value) => set({ wakeFrom: relayId(value) })}
                    options={withServer}
                    hint={t("device.wakeFromHint")}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <TextField
                      label={t("device.broadcast")}
                      value={form.broadcastAddress}
                      onChange={(broadcastAddress) => set({ broadcastAddress })}
                      placeholder="192.168.1.255"
                      hint={t("device.broadcastHint")}
                      mono
                    />
                    <SelectField<string>
                      label={t("device.wakePort")}
                      value={String(form.wakePort)}
                      onChange={(value) => set({ wakePort: Number(value) })}
                      options={[
                        { value: "9", label: "9" },
                        { value: "7", label: "7" },
                      ]}
                    />
                  </div>
                  <TextField
                    label={t("device.secureOn")}
                    value={form.secureOn ?? ""}
                    onChange={(secureOn) => set({ secureOn })}
                    placeholder={
                      secrets.hasSecureOn ? t("device.secretSaved") : undefined
                    }
                    hint={t("device.secureOnHint")}
                  />
                </>
              ) : (
                <>
                  <TextAreaField
                    label={t("device.wakeCommand")}
                    value={form.wakeCommand}
                    onChange={(wakeCommand) => set({ wakeCommand })}
                    hint={placeholders}
                    rows={2}
                    mono
                  />
                  {form.wakeCommand.trim() !== "" && testButton("wake")}
                </>
              )}
              <NumberField
                label={t("device.timeout")}
                value={form.wakeTimeout}
                onChange={(wakeTimeout) => set({ wakeTimeout })}
                min={5}
                max={3600}
                hint={t("device.timeoutHint")}
              />
              <TextField
                label={t("device.cron")}
                value={form.wakeCron}
                onChange={(wakeCron) => set({ wakeCron })}
                placeholder="0 8 * * 1-5"
                hint={t("device.cronHint")}
                mono
              />
              <SwitchRow
                label={t("device.confirm")}
                checked={form.wakeConfirm}
                onChange={(wakeConfirm) => set({ wakeConfirm })}
              />
            </div>
          </SectionCard>

          <SectionCard
            title={t("device.shutdown")}
            icon={<Power className="size-3.5" />}
          >
            <div className="flex flex-col gap-3 py-3">
              <SelectField<ShutdownMode>
                label={t("device.shutdownMode")}
                value={form.shutdownMode}
                onChange={(shutdownMode) => set({ shutdownMode })}
                options={[
                  { value: "none", label: t("device.shutdownNone") },
                  { value: "ssh", label: t("device.shutdownSsh") },
                  { value: "custom", label: t("device.commandMode") },
                ]}
                hint={
                  form.shutdownMode === "ssh"
                    ? t("device.shutdownSshHint")
                    : undefined
                }
              />
              {form.shutdownMode === "custom" && (
                <>
                  <TextAreaField
                    label={t("device.shutdownCommand")}
                    value={form.shutdownCommand}
                    onChange={(shutdownCommand) => set({ shutdownCommand })}
                    hint={placeholders}
                    rows={2}
                    mono
                  />
                  {form.shutdownCommand.trim() !== "" && testButton("shutdown")}
                </>
              )}
              {form.shutdownMode !== "none" && (
                <>
                  <NumberField
                    label={t("device.timeout")}
                    value={form.shutdownTimeout}
                    onChange={(shutdownTimeout) => set({ shutdownTimeout })}
                    min={5}
                    max={3600}
                    hint={t("device.timeoutHint")}
                  />
                  <TextField
                    label={t("device.cron")}
                    value={form.shutdownCron}
                    onChange={(shutdownCron) => set({ shutdownCron })}
                    placeholder="0 23 * * *"
                    hint={t("device.cronHint")}
                    mono
                  />
                  <SwitchRow
                    label={t("device.confirm")}
                    checked={form.shutdownConfirm}
                    onChange={(shutdownConfirm) => set({ shutdownConfirm })}
                  />
                </>
              )}
            </div>
          </SectionCard>

          {usesCommands && (
            <SectionCard
              title={t("device.commands")}
              icon={<SquareTerminal className="size-3.5" />}
            >
              <div className="flex flex-col gap-3 py-3">
                <SelectField<CommandTarget>
                  label={t("device.commandTarget")}
                  value={form.commandTarget}
                  onChange={(commandTarget) => set({ commandTarget })}
                  options={[
                    { value: "host", label: t("device.targetHost") },
                    { value: "relay", label: t("device.targetRelay") },
                    ...(can.server
                      ? [
                          {
                            value: "server" as const,
                            label: t("device.targetServer"),
                          },
                        ]
                      : []),
                  ]}
                  hint={t("device.commandTargetHint")}
                />
                {form.commandTarget === "relay" && (
                  <SelectField<string>
                    label={t("device.commandRelay")}
                    value={form.commandRelay ? String(form.commandRelay) : ""}
                    onChange={(value) =>
                      set({ commandRelay: value ? Number(value) : null })
                    }
                    options={relayOptions}
                    placeholder={t("device.pickHost")}
                  />
                )}
              </div>
            </SectionCard>
          )}

          <SectionCard
            title={t("device.bmc")}
            icon={<Power className="size-3.5" />}
          >
            <div className="flex flex-col gap-3 py-3">
              <SwitchRow
                label={t("device.useBmc")}
                description={t("device.useBmcHint")}
                checked={form.useBmc}
                onChange={(useBmc) => set({ useBmc })}
              />
            </div>
          </SectionCard>

          <SectionCard
            title={t("device.sleep")}
            icon={<Moon className="size-3.5" />}
          >
            <div className="flex flex-col gap-3 py-3">
              <SwitchRow
                label={t("device.solEnable")}
                description={t("device.solHint")}
                checked={form.solEnabled}
                onChange={(solEnabled) => set({ solEnabled })}
              />
              {form.solEnabled && (
                <>
                  <NumberField
                    label={t("device.solPort")}
                    value={form.solPort}
                    onChange={(solPort) => set({ solPort })}
                    min={1}
                    max={65535}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <TextField
                      label={t("device.solUser")}
                      value={form.solUser}
                      onChange={(solUser) => set({ solUser })}
                    />
                    <TextField
                      label={t("device.solPassword")}
                      value={form.solPassword ?? ""}
                      onChange={(solPassword) => set({ solPassword })}
                      placeholder={
                        secrets.hasSolPassword
                          ? t("device.secretSaved")
                          : undefined
                      }
                    />
                  </div>
                </>
              )}
            </div>
          </SectionCard>
        </>
      )}
    </InlineView>
  );
}
