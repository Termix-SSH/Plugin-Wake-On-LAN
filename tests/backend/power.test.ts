import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeContext } from "@termix-ssh/plugin-sdk/testing";
import { createCommandRunner, substitute } from "../../src/backend/commands.js";
import {
  defaultRow,
  type DeviceRow,
  type DeviceStore,
} from "../../src/backend/devices.js";
import { buildMagicPacket } from "../../src/backend/magic-packet.js";
import { createPowerManager, wakeScript } from "../../src/backend/power.js";
import type { Relay } from "../../src/backend/relay.js";
import type { StatusTracker } from "../../src/backend/status.js";
import { hostOf } from "./helpers.js";

const MAC = "aa:bb:cc:dd:ee:ff";

function sealed(value: string) {
  return createFakeContext().ctx.secrets.seal(value);
}

function setup(row: Partial<DeviceRow>, sshResult = { code: 0, stderr: "" }) {
  const fake = createFakeContext({
    hosts: [hostOf(1, "zeus"), hostOf(2, "apollo")],
    actor: "presser",
  });
  const ctx = fake.ctx;
  const saved = { ...defaultRow(1), ...row };
  const store = { read: vi.fn(async () => saved) } as unknown as DeviceStore;
  const relay: Relay = {
    run: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      timedOut: false,
    })),
    command: vi.fn(async () => ({
      stdout: "ok",
      stderr: "",
      code: 0,
      timedOut: false,
    })),
  };
  const status = {
    expect: vi.fn(async () => {}),
  } as unknown as StatusTracker;
  const exec = vi.spyOn(ctx.ssh, "exec").mockResolvedValue({
    stdout: "Linux",
    truncated: false,
    timedOut: false,
    ...sshResult,
  });
  const power = createPowerManager(
    ctx,
    store,
    relay,
    createCommandRunner(ctx, relay),
    status,
  );
  return { ctx, fake, relay, status, exec, power };
}

describe("substitute", () => {
  it("fills in both names, with or without spaces", () => {
    expect(
      substitute("wol {{DEVICE_MAC}} {{ DEVICE_IP }}", {
        ip: "10.0.0.1",
        mac: MAC,
      }),
    ).toBe(`wol ${MAC} 10.0.0.1`);
  });

  it("refuses an address that could run something", () => {
    expect(() =>
      substitute("ping {{ DEVICE_IP }}", { ip: "1.1.1.1; rm -rf /", mac: MAC }),
    ).toThrow(/can't be used/);
    expect(() =>
      substitute("ping {{ DEVICE_IP }}", { ip: "$(reboot)", mac: MAC }),
    ).toThrow();
  });

  it("does not care about a value the command doesn't use", () => {
    expect(substitute("true", { ip: "$(reboot)", mac: "" })).toBe("true");
  });
});

describe("wake", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends through the relay as the saver, not the presser", async () => {
    const { ctx, power, relay, status } = setup({
      wakeFrom: 2,
      updatedBy: "saver",
      lanIp: "192.168.1.2",
      netmask: "255.255.255.0",
    });
    await ctx.settings.setHost(1, "macAddress", MAC);
    await power.wake(1);
    expect(relay.run).toHaveBeenCalledWith(
      2,
      "saver",
      wakeScript(buildMagicPacket(MAC), "192.168.1.255", 9),
    );
    expect(status.expect).toHaveBeenCalledWith(1, "waking", 120, undefined);
  });

  it("explains a relay with no way to send", async () => {
    const { ctx, power, relay } = setup({ wakeFrom: 2, updatedBy: "saver" });
    await ctx.settings.setHost(1, "macAddress", MAC);
    vi.mocked(relay.run).mockResolvedValue({
      stdout: "",
      stderr: "This relay needs python3 or perl to send the packet",
      code: 4,
      timedOut: false,
    });
    await expect(power.wake(1)).rejects.toThrow(/python3 or perl/);
  });

  it("runs a stored command as the saver", async () => {
    const { ctx, power, relay } = setup({
      wakeMode: "custom",
      wakeCommandSealed: await sealed("wol {{ DEVICE_MAC }}"),
      commandTarget: "relay",
      commandRelay: 2,
      updatedBy: "saver",
    });
    await ctx.settings.setHost(1, "macAddress", MAC);
    await power.wake(1);
    expect(relay.command).toHaveBeenCalledWith(
      2,
      "saver",
      `wol ${MAC}`,
      expect.any(Number),
    );
  });
});

describe("shutdown", () => {
  it("uses the host's SSH login on Linux", async () => {
    const { power, exec, status } = setup({ shutdownMode: "ssh" });
    await power.shutdown(1);
    expect(exec.mock.calls[1]![1]).toContain("poweroff");
    expect(status.expect).toHaveBeenCalledWith(1, "stopping", 120, undefined);
  });

  it("uses shutdown.exe when uname isn't there", async () => {
    const { power, exec } = setup({ shutdownMode: "ssh" });
    exec.mockResolvedValueOnce({
      stdout: "",
      stderr: "not recognized",
      code: 1,
      truncated: false,
      timedOut: false,
    });
    await power.shutdown(1);
    expect(exec.mock.calls[1]![1]).toBe("shutdown /s /t 5");
  });

  it("says when sudo needs a password", async () => {
    const { power } = setup({ shutdownMode: "ssh" }, { code: 5, stderr: "" });
    await expect(power.shutdown(1)).rejects.toThrow(/passwordless sudo/);
  });

  it("refuses with no method set", async () => {
    const { power } = setup({});
    await expect(power.shutdown(1)).rejects.toThrow(/No shutdown method/);
  });

  it("refuses server commands while the setting is off", async () => {
    const { power, fake } = setup({
      shutdownMode: "custom",
      shutdownCommandSealed: await sealed("poweroff"),
      commandTarget: "server",
      updatedBy: "saver",
    });
    await expect(power.shutdown(1)).rejects.toThrow(/turned off/);
    expect(fake.processRuns).toHaveLength(0);
  });
});

describe("sleep", () => {
  it("uses the relay's curl with the password off argv", async () => {
    const { power, relay } = setup({
      solEnabled: true,
      solUser: "me",
      solPasswordSealed: await sealed("pw"),
      wakeFrom: 2,
      updatedBy: "saver",
      lanIp: "192.168.1.2",
    });
    await power.sleep(1);
    const script = vi.mocked(relay.run).mock.calls[0]![2];
    expect(script).toContain(
      'url = "http://192.168.1.2:8009/sleep?format=JSON"',
    );
    expect(script).toContain(
      `Authorization: Basic ${Buffer.from("me:pw").toString("base64")}`,
    );
    expect(script).toContain("-K -");
    expect(script).not.toContain("me:pw");
  });

  it("refuses when Sleep-On-LAN is off", async () => {
    const { power } = setup({});
    await expect(power.sleep(1)).rejects.toThrow(/Sleep-On-LAN is off/);
  });
});
