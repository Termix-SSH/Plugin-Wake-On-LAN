import { describe, it, expect, vi } from "vitest";
import { createFakeContext } from "@termix-ssh/plugin-sdk/testing";
import {
  defaultRow,
  type DeviceRow,
  type DeviceStore,
} from "../../src/backend/devices.js";
import type { Relay } from "../../src/backend/relay.js";
import {
  createStatusTracker,
  parseRelayChecks,
  relayCheckScript,
} from "../../src/backend/status.js";
import { hostOf, targetOf } from "./helpers.js";

function setup(
  rows: Array<Partial<DeviceRow> & { hostId: number }>,
  reachable: (host: string | number, port?: number) => boolean,
) {
  const full = rows.map((row) => ({ ...defaultRow(row.hostId), ...row }));
  const hosts = rows.map((row) => hostOf(row.hostId));
  const fake = createFakeContext({
    hosts,
    probeTargets: hosts.map(targetOf),
    reachable,
  });
  // Core refuses this with no acting user, which a timer doesn't have.
  const probe = fake.ctx.hosts.probeTargets.bind(fake.ctx.hosts);
  const probeTargets = vi
    .spyOn(fake.ctx.hosts, "probeTargets")
    .mockImplementation(async (filter) => {
      if (!fake.ctx.currentActor()) throw new Error("needs an acting user");
      return probe(filter);
    });
  // Core answers with the host's owner; the fake only knows created hosts.
  const values = fake.ctx.settings.listHostValues.bind(fake.ctx.settings);
  vi.spyOn(fake.ctx.settings, "listHostValues").mockImplementation(
    async (key) =>
      (await values(key)).map((row) => ({ ...row, userId: "owner" })) as never,
  );
  const store = {
    all: vi.fn(async () => full),
    save: vi.fn(async () => {}),
  } as unknown as DeviceStore;
  const relay: Relay = {
    run: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      timedOut: false,
    })),
    command: vi.fn(),
  };
  const commands = {
    run: vi.fn(async () => ({ ok: true, code: 0, output: "" })),
  };
  const tracker = createStatusTracker(fake.ctx, store, relay, commands);
  return { fake, store, relay, commands, tracker, probeTargets };
}

async function enable(fake: ReturnType<typeof createFakeContext>, id: number) {
  await fake.ctx.settings.setHost(id, "enablePower", true);
}

describe("relay checks", () => {
  it("builds one script and reads its lines", () => {
    const script = relayCheckScript([
      { hostId: 1, address: "192.168.1.2", ports: [22] },
      { hostId: 2, address: "192.168.1.3", ports: [] },
    ]);
    expect(script).toContain("ping -c 1 -W 1 192.168.1.2");
    expect(script).toContain("/dev/tcp/192.168.1.2/22");
    expect(script).toContain("wait");
    const checks = parseRelayChecks("@1 1 22,80\n@2 0 \nnoise\n");
    expect(checks.get(1)).toEqual({ up: true, ports: [22, 80] });
    expect(checks.get(2)).toEqual({ up: false, ports: [] });
  });
});

describe("tracker", () => {
  it("marks a device online and saves only changes", async () => {
    const { fake, store, tracker } = setup([{ hostId: 1 }], () => true);
    await enable(fake, 1);
    await tracker.tick();
    expect(tracker.current(1)).toBe("online");
    expect(store.save).toHaveBeenCalledTimes(1);
    await fake.ctx.settings.set("statusInterval", 0);
    await tracker.tick();
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("reads hosts as their owner, and only once in a while", async () => {
    const { fake, tracker, probeTargets } = setup([{ hostId: 1 }], () => true);
    await enable(fake, 1);
    await fake.ctx.settings.set("statusInterval", 0);
    const asUser = vi.spyOn(fake.ctx, "asUser");
    await tracker.tick();
    await tracker.tick();
    await tracker.tick();
    expect(tracker.current(1)).toBe("online");
    expect(probeTargets).toHaveBeenCalledTimes(1);
    expect(asUser).toHaveBeenCalledTimes(1);
  });

  it("logs a failed read instead of throwing", async () => {
    const { fake, tracker, probeTargets } = setup([{ hostId: 1 }], () => true);
    await enable(fake, 1);
    probeTargets.mockRejectedValue(new Error("nope"));
    await expect(tracker.tick()).resolves.toBeUndefined();
    expect(tracker.current(1)).toBeNull();
  });

  it("forgets a wake on a host with Power off", async () => {
    const { tracker, probeTargets } = setup([{ hostId: 1 }], () => true);
    await tracker.expect(1, "waking", 60);
    await tracker.fastTick();
    expect(probeTargets).not.toHaveBeenCalled();
  });

  it("needs two misses to go from online to offline", async () => {
    let up = true;
    const { fake, tracker } = setup([{ hostId: 1 }], () => up);
    await enable(fake, 1);
    await fake.ctx.settings.set("statusInterval", 0);
    await tracker.tick();
    up = false;
    await tracker.tick();
    expect(tracker.current(1)).toBe("online");
    await tracker.tick();
    expect(tracker.current(1)).toBe("offline");
  });

  it("stays waking until the device answers", async () => {
    let up = false;
    const { fake, tracker } = setup([{ hostId: 1 }], () => up);
    await enable(fake, 1);
    await tracker.expect(1, "waking", 60);
    await tracker.fastTick();
    expect(tracker.current(1)).toBe("waking");
    up = true;
    await tracker.fastTick();
    expect(tracker.current(1)).toBe("online");
  });

  it("fails and calls back after the timeout", async () => {
    const { fake, tracker } = setup([{ hostId: 1 }], () => false);
    await enable(fake, 1);
    const onFail = vi.fn();
    await tracker.expect(1, "waking", 0, onFail);
    await tracker.fastTick();
    expect(tracker.current(1)).toBe("failed");
    expect(onFail).toHaveBeenCalledOnce();
  });

  it("groups a relay's devices by login and uses the LAN IP", async () => {
    const { fake, relay, tracker } = setup(
      [
        { hostId: 1, statusFrom: 9, updatedBy: "a", lanIp: "192.168.1.2" },
        { hostId: 2, statusFrom: 9, updatedBy: "a" },
        { hostId: 3, statusFrom: 9, updatedBy: "b" },
      ],
      () => false,
    );
    for (const id of [1, 2, 3]) await enable(fake, id);
    vi.mocked(relay.run).mockImplementation(async (_relay, user) => ({
      stdout: user === "a" ? "@1 1 \n@2 0 \n" : "@3 1 \n",
      stderr: "",
      code: 0,
      timedOut: false,
    }));
    await tracker.tick();
    expect(relay.run).toHaveBeenCalledTimes(2);
    expect(vi.mocked(relay.run).mock.calls[0]![2]).toContain("192.168.1.2");
    expect(tracker.current(1)).toBe("online");
    expect(tracker.current(3)).toBe("online");
  });

  it("keeps the last status when a relay is down", async () => {
    const { fake, relay, tracker } = setup(
      [{ hostId: 1, statusFrom: 9, updatedBy: "a" }],
      () => false,
    );
    await enable(fake, 1);
    vi.mocked(relay.run).mockRejectedValue(new Error("no route"));
    await tracker.tick();
    expect(tracker.current(1)).toBeNull();
  });

  it("lets a custom check decide", async () => {
    const pingCommandSealed = await createFakeContext().ctx.secrets.seal(
      "check {{ DEVICE_IP }}",
    );
    const { fake, commands, tracker } = setup(
      [{ hostId: 1, pingCommandSealed, updatedBy: "a" }],
      () => false,
    );
    await enable(fake, 1);
    await tracker.tick();
    expect(commands.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: "check 10.0.0.1", userId: "a" }),
    );
    expect(tracker.current(1)).toBe("online");
  });
});
