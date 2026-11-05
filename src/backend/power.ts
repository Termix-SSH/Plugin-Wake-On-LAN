import type {
  PluginContext,
  PluginHostSummary,
} from "@termix-ssh/plugin-sdk/backend";
import { SUDO_REFUSED_RE } from "@termix-ssh/plugin-sdk/host-scripts";
import type { CommandKind, TestResult } from "../shared/types.js";
import { CommandError, substitute, type CommandRunner } from "./commands.js";
import type { DeviceRow, DeviceStore } from "./devices.js";
import {
  broadcastFor,
  buildMagicPacket,
  isValidBroadcastAddress,
  isValidMac,
  sendMagicPacket,
} from "./magic-packet.js";
import type { Bmc } from "./bmc.js";
import type { Relay } from "./relay.js";
import type { StatusTracker } from "./status.js";

const SAFE_ADDRESS = /^[A-Za-z0-9.:-]+$/;
const SSH_TIMEOUT_MS = 20_000;
const SLEEP_TIMEOUT_MS = 10_000;

/** A failure the caller should see as a 400. */
export class PowerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function wakeScript(packet: Buffer, address: string, port: number) {
  const data = packet.toString("base64");
  return `data='${data}'; addr='${address}'; port=${port}
if command -v python3 >/dev/null 2>&1; then
python3 - "$data" "$addr" "$port" <<'PY'
import base64, socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
s.sendto(base64.b64decode(sys.argv[1]), (sys.argv[2], int(sys.argv[3])))
PY
elif command -v perl >/dev/null 2>&1; then
perl -MSocket -MMIME::Base64 -e 'socket(my $s, PF_INET, SOCK_DGRAM, 0) or die; setsockopt($s, SOL_SOCKET, SO_BROADCAST, 1); send($s, decode_base64($ARGV[0]), 0, sockaddr_in($ARGV[2], inet_aton($ARGV[1]))) or die' "$data" "$addr" "$port"
else
echo "This relay needs python3 or perl to send the packet" >&2; exit 4
fi
`;
}

/** Shuts down after a moment, so the SSH command can end cleanly first. */
const POSIX_SHUTDOWN = `if [ "$(id -u)" = "0" ]; then run=""; else run="sudo -n"; fi
$run true || exit 5
off=poweroff; command -v poweroff >/dev/null 2>&1 || off="shutdown -h now"
nohup $run sh -c "sleep 1; $off" >/dev/null 2>&1 &
`;
const WINDOWS_SHUTDOWN = "shutdown /s /t 5";

export function sleepScript(url: string, auth: string | null): string {
  const header = auth ? `header = "Authorization: Basic ${auth}"\n` : "";
  return `curl -fsS -m 10 -K - <<'EOF'
url = "${url}"
${header}EOF
`;
}

export interface ActionOptions {
  /** A schedule, not a person: a failed run sends an alert. */
  scheduled?: boolean;
}

export interface PowerManager {
  wake: (hostId: number, options?: ActionOptions) => Promise<void>;
  shutdown: (hostId: number, options?: ActionOptions) => Promise<void>;
  sleep: (hostId: number) => Promise<void>;
  test: (hostId: number, kind: CommandKind) => Promise<TestResult>;
}

export function createPowerManager(
  ctx: PluginContext,
  store: DeviceStore,
  relay: Relay,
  commands: CommandRunner,
  status: StatusTracker,
  bmc?: Bmc,
): PowerManager {
  async function hostOf(hostId: number): Promise<PluginHostSummary> {
    const host = await ctx.hosts.get(hostId);
    if (!host) throw new PowerError("Host not found", 404);
    return host;
  }

  async function macOf(hostId: number) {
    return (
      (await ctx.settings.getHost<string>(hostId, "macAddress"))?.trim() ?? ""
    );
  }

  async function unsealed(sealed: string | null) {
    return sealed ? ((await ctx.secrets.unseal(sealed)) ?? "") : "";
  }

  function alertOnFail(
    host: PluginHostSummary,
    row: DeviceRow,
    action: "wake" | "shutdown",
    options: ActionOptions,
  ) {
    if (!options.scheduled || !row.updatedBy) return undefined;
    const userId = row.updatedBy;
    const name = host.name || host.ip;
    return () => {
      void ctx.notify
        .send({
          title:
            action === "wake"
              ? `${name} did not wake`
              : `${name} did not shut down`,
          severity: "warning",
          category: `wake-on-lan.${action}_failed`,
          audience: { userId },
          context: { hostId: host.id, hostName: name },
        })
        .catch(() => {});
    };
  }

  async function runSaved(
    host: PluginHostSummary,
    row: DeviceRow,
    sealed: string | null,
    timeoutMs?: number,
  ): Promise<TestResult> {
    const command = await unsealed(sealed);
    if (!command) throw new PowerError("No command is saved");
    if (!row.updatedBy) throw new PowerError("No command is saved");
    try {
      return await commands.run({
        command: substitute(command, {
          ip: row.lanIp || host.ip,
          mac: await macOf(host.id),
        }),
        target: row.commandTarget as "host",
        hostId: host.id,
        relayId: row.commandRelay,
        userId: row.updatedBy,
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof CommandError) throw new PowerError(error.message);
      throw error;
    }
  }

  /** Opt in per device, and only when Out-of-band has a BMC for the host. */
  async function viaBmc(
    host: PluginHostSummary,
    row: DeviceRow,
    action: "on" | "graceful-shutdown",
  ): Promise<boolean> {
    if (!bmc || !row.useBmc) return false;
    if (!(await bmc.available(host.id, row.updatedBy))) return false;
    try {
      await bmc.set(host.id, row.updatedBy, action);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      throw new PowerError(message || "The BMC did not accept the change");
    }
    ctx.log.info(`Asked the BMC of host ${host.id} to ${action}`);
    return true;
  }

  async function sendPacket(host: PluginHostSummary, row: DeviceRow) {
    const mac = await macOf(host.id);
    if (!mac || !isValidMac(mac)) {
      throw new PowerError("No valid MAC address configured");
    }
    const saved = (
      await ctx.settings.getHost<string>(host.id, "broadcastAddress")
    )?.trim();
    if (saved && !isValidBroadcastAddress(saved)) {
      throw new PowerError("Invalid broadcast address");
    }
    const address =
      saved || broadcastFor(row.lanIp, row.netmask) || "255.255.255.255";
    const password = await unsealed(row.secureOnSealed);

    if (row.wakeFrom) {
      if (!row.updatedBy) throw new PowerError("Save this device first");
      const result = await relay.run(
        row.wakeFrom,
        row.updatedBy,
        wakeScript(buildMagicPacket(mac, password), address, row.wakePort),
      );
      if (result.code !== 0) {
        throw new PowerError(
          result.stderr.trim() || "The relay could not send the packet",
        );
      }
    } else {
      await ctx.capabilities.require("network:broadcast");
      await sendMagicPacket(mac, address, {
        port: row.wakePort,
        password,
      });
    }
    ctx.log.info(`Wake-on-LAN packet sent to host ${host.id}`);
  }

  async function sshShutdown(host: PluginHostSummary) {
    const options = { purpose: "wake-on-lan", timeoutMs: SSH_TIMEOUT_MS };
    const probe = await ctx.ssh.exec(host.id, "uname -s", options);
    const windows = probe.code !== 0;
    const result = await ctx.ssh.exec(
      host.id,
      windows ? WINDOWS_SHUTDOWN : POSIX_SHUTDOWN,
      options,
    );
    if (result.code === 5 || SUDO_REFUSED_RE.test(result.stderr)) {
      throw new PowerError(
        "This host needs passwordless sudo, or a root login",
      );
    }
    if (result.code !== 0) {
      throw new PowerError(
        result.stderr.trim() || "The shutdown command failed",
      );
    }
  }

  return {
    async wake(hostId, options = {}) {
      const host = await hostOf(hostId);
      const row = await store.read(hostId);
      if (await viaBmc(host, row, "on")) {
        // The BMC powered it on, no packet needed
      } else if (row.wakeMode === "custom") {
        const result = await runSaved(host, row, row.wakeCommandSealed);
        if (!result.ok) {
          throw new PowerError(
            result.output.trim() || "The wake command failed",
          );
        }
      } else {
        await sendPacket(host, row);
      }
      await status.expect(
        hostId,
        "waking",
        row.wakeTimeout,
        alertOnFail(host, row, "wake", options),
      );
    },

    async shutdown(hostId, options = {}) {
      const host = await hostOf(hostId);
      const row = await store.read(hostId);
      if (
        row.shutdownMode === "none" &&
        (await viaBmc(host, row, "graceful-shutdown"))
      ) {
        // Asked the BMC for a clean shutdown
      } else if (row.shutdownMode === "ssh") {
        await sshShutdown(host);
      } else if (row.shutdownMode === "custom") {
        const result = await runSaved(host, row, row.shutdownCommandSealed);
        if (!result.ok) {
          throw new PowerError(
            result.output.trim() || "The shutdown command failed",
          );
        }
      } else {
        throw new PowerError("No shutdown method is set for this device");
      }
      await status.expect(
        hostId,
        "stopping",
        row.shutdownTimeout,
        alertOnFail(host, row, "shutdown", options),
      );
    },

    async sleep(hostId) {
      const host = await hostOf(hostId);
      const row = await store.read(hostId);
      if (!row.solEnabled) {
        throw new PowerError("Sleep-On-LAN is off for this device");
      }
      const address = row.lanIp || host.ip;
      if (!SAFE_ADDRESS.test(address)) {
        throw new PowerError("This device's IP can't be used");
      }
      const url = `http://${address}:${row.solPort}/sleep?format=JSON`;
      const password = await unsealed(row.solPasswordSealed);
      const auth = password
        ? Buffer.from(`${row.solUser}:${password}`).toString("base64")
        : null;

      if (row.wakeFrom && row.updatedBy) {
        const result = await relay.run(
          row.wakeFrom,
          row.updatedBy,
          sleepScript(url, auth),
        );
        if (result.code !== 0) {
          throw new PowerError(
            result.stderr.trim() || "Sleep-On-LAN did not answer",
          );
        }
      } else {
        try {
          const response = await ctx.fetch(url, {
            headers: auth ? { Authorization: `Basic ${auth}` } : {},
            timeoutMs: SLEEP_TIMEOUT_MS,
          });
          if (!response.ok) {
            throw new PowerError(`Sleep-On-LAN answered ${response.status}`);
          }
        } catch (error) {
          if (error instanceof PowerError) throw error;
          const message = error instanceof Error ? error.message : "";
          throw new PowerError(
            /private/i.test(message)
              ? "Termix blocks requests to private addresses. Send from a relay host, or have an admin allow this address."
              : message || "Sleep-On-LAN did not answer",
          );
        }
      }
      await status.expect(hostId, "stopping", row.shutdownTimeout);
    },

    async test(hostId, kind) {
      const host = await hostOf(hostId);
      const row = await store.read(hostId);
      const sealed = {
        wake: row.wakeCommandSealed,
        shutdown: row.shutdownCommandSealed,
        ping: row.pingCommandSealed,
      }[kind];
      return runSaved(host, row, sealed);
    },
  };
}
