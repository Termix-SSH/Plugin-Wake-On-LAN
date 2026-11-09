import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DeviceInput } from "../../src/shared/types.js";
import {
  ALL_PERMISSIONS,
  fakeSshClient,
  hostOf,
  startServer,
  type TestServer,
} from "./helpers.js";
import { sendMagicPacket } from "../../src/backend/magic-packet.js";

vi.mock("../../src/backend/magic-packet.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/backend/magic-packet.js")
  >("../../src/backend/magic-packet.js");
  return { ...actual, sendMagicPacket: vi.fn().mockResolvedValue(undefined) };
});

const MAC = "aa:bb:cc:dd:ee:ff";

function input(patch: Partial<DeviceInput> = {}): DeviceInput {
  return {
    macAddress: MAC,
    broadcastAddress: "",
    lanIp: "",
    netmask: "",
    description: "",
    linkUrl: "",
    autoOpenLink: false,
    wakeFrom: null,
    wakePort: 9,
    wakeMode: "magic",
    wakeCommand: "",
    wakeTimeout: 120,
    wakeConfirm: false,
    wakeCron: "",
    statusFrom: null,
    ports: "",
    pingCommand: "",
    shutdownMode: "none",
    shutdownCommand: "",
    shutdownTimeout: 120,
    shutdownConfirm: true,
    shutdownCron: "",
    commandTarget: "host",
    commandRelay: null,
    solEnabled: false,
    solPort: 8009,
    solUser: "",
    useBmc: false,
    ...patch,
  };
}

describe("routes", () => {
  let server: TestServer;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await server?.close();
  });

  describe("POST /host/:id/wake, used by Mobile", () => {
    it("sends the packet for a configured host", async () => {
      server = await startServer({ hosts: [hostOf(1)] });
      await server.mock.ctx.settings.setHost(1, "macAddress", MAC);
      const response = await server.request("POST", "/host/1/wake");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(sendMagicPacket).toHaveBeenCalledWith(MAC, "255.255.255.255", {
        port: 9,
        password: "",
      });
    });

    it("404s for an unknown host", async () => {
      server = await startServer({ hosts: [] });
      const response = await server.request("POST", "/host/999/wake");
      expect(response.status).toBe(404);
    });

    it("400s when no MAC address is configured", async () => {
      server = await startServer({ hosts: [hostOf(1)] });
      const response = await server.request("POST", "/host/1/wake");
      expect(response.status).toBe(400);
    });

    it("denies a caller without wake-on-lan.send", async () => {
      server = await startServer({ hosts: [hostOf(1)], permissions: [] });
      const response = await server.request("POST", "/host/1/wake");
      expect(response.status).toBe(403);
    });
  });

  describe("permissions", () => {
    it("needs shutdown for shutdown and sleep", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ["wake-on-lan.send"],
      });
      for (const action of ["shutdown", "sleep"]) {
        const response = await server.request("POST", `/devices/1/${action}`);
        expect(response.status).toBe(403);
      }
    });

    it("needs scan to scan", async () => {
      server = await startServer({ hosts: [hostOf(1)], permissions: [] });
      const response = await server.request("POST", "/scan", {
        body: { relayId: 1 },
      });
      expect(response.status).toBe(403);
    });

    it("keeps server scans to server-commands", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ["wake-on-lan.scan"],
      });
      const response = await server.request("POST", "/scan", {
        body: { cidr: "192.168.1.0/30" },
      });
      expect(response.status).toBe(403);
    });

    it("hides a host the caller can't see", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ALL_PERMISSIONS,
      });
      const response = await server.request("POST", "/devices/9/wake");
      expect(response.status).toBe(404);
    });

    it("needs edit access to read or save settings", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ALL_PERMISSIONS,
      });
      vi.spyOn(server.mock.ctx.hosts, "checkAccess").mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isShared: true,
        permissionLevel: "view",
      });
      expect((await server.request("GET", "/devices/1")).status).toBe(403);
      const saved = await server.request("PUT", "/devices/1", {
        body: input(),
      });
      expect(saved.status).toBe(403);
    });
  });

  describe("saving", () => {
    it("lists a device once it is saved, without its passwords", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ALL_PERMISSIONS,
      });
      const saved = await server.request("PUT", "/devices/1", {
        body: input({
          secureOn: "abcd",
          solPassword: "hunter2",
          ports: "22 80",
        }),
      });
      expect(saved.status).toBe(200);

      const list = await server.request("GET", "/devices");
      expect(list.body.devices).toHaveLength(1);
      expect(list.body.devices[0]).toMatchObject({
        hostId: 1,
        macAddress: MAC,
        canWake: true,
        canShutdown: false,
      });

      const detail = await server.request("GET", "/devices/1");
      expect(detail.body.secrets).toEqual({
        hasSecureOn: true,
        hasSolPassword: true,
      });
      expect(detail.body.config.ports).toBe("22,80");
      const raw = JSON.stringify(detail.body);
      expect(raw).not.toContain("hunter2");
      expect(raw).not.toContain("abcd");
    });

    it("keeps a password left out, and clears an empty one", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ALL_PERMISSIONS,
      });
      await server.request("PUT", "/devices/1", {
        body: input({ secureOn: "abcd" }),
      });
      await server.request("PUT", "/devices/1", { body: input() });
      let detail = await server.request("GET", "/devices/1");
      expect(detail.body.secrets.hasSecureOn).toBe(true);
      await server.request("PUT", "/devices/1", {
        body: input({ secureOn: "" }),
      });
      detail = await server.request("GET", "/devices/1");
      expect(detail.body.secrets.hasSecureOn).toBe(false);
    });

    it.each([
      ["a bad MAC", { macAddress: "nope" }],
      ["a bad link", { linkUrl: "javascript:alert(1)" }],
      ["a bad cron", { wakeCron: "not cron" }],
      ["a bad wake port", { wakePort: 1234 }],
      ["a bad SecureON", { secureOn: "abc" }],
      ["a LAN IP with shell in it", { lanIp: "1.2.3.4;reboot" }],
      ["an empty wake command", { wakeMode: "custom" as const }],
    ])("refuses %s", async (_name, patch) => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ALL_PERMISSIONS,
      });
      const response = await server.request("PUT", "/devices/1", {
        body: input(patch),
      });
      expect(response.status).toBe(400);
    });

    it("refuses server commands without server-commands", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ["wake-on-lan.send"],
      });
      const response = await server.request("PUT", "/devices/1", {
        body: input({
          commandTarget: "server",
          wakeMode: "custom",
          wakeCommand: "true",
        }),
      });
      expect(response.status).toBe(403);
    });

    it("refuses a relay the saver can't reach", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ALL_PERMISSIONS,
      });
      const response = await server.request("PUT", "/devices/1", {
        body: input({ wakeFrom: 99 }),
      });
      expect(response.status).toBe(403);
    });
  });

  describe("adding and attaching", () => {
    it("attaching keeps the host's address and makes no new host", async () => {
      server = await startServer({
        hosts: [hostOf(1, "zeus"), hostOf(2, "apollo")],
        permissions: ALL_PERMISSIONS,
      });
      const create = vi.spyOn(server.mock.ctx.hosts, "create");
      const response = await server.request("POST", "/scan/attach", {
        body: { hostId: 1, ip: "192.168.1.2", mac: MAC, relayId: 2 },
      });
      expect(response.status).toBe(200);
      expect(create).not.toHaveBeenCalled();

      const list = await server.request("GET", "/devices");
      expect(list.body.devices).toHaveLength(1);
      expect(list.body.devices[0]).toMatchObject({
        name: "zeus",
        address: "192.168.1.2",
      });
      const detail = await server.request("GET", "/devices/1");
      expect(detail.body.config.wakeFrom).toBe(2);
      expect(detail.body.config.statusFrom).toBeNull();
      expect((await server.mock.ctx.hosts.get(1))?.ip).toBe("10.0.0.1");
    });

    it("adds a new host with SSH off in the Power folder", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: [...ALL_PERMISSIONS, "hosts.create"],
      });
      const create = vi.spyOn(server.mock.ctx.hosts, "create");
      const response = await server.request("POST", "/devices", {
        body: { name: "desk", ip: "192.168.1.3", mac: MAC, relayId: 1 },
      });
      expect(response.status).toBe(201);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "desk",
          enableSsh: false,
          statusCheckEnabled: false,
          folder: "Power",
          pluginEnable: { "wake-on-lan": true },
        }),
      );
    });
  });

  describe("scan", () => {
    it("matches results against existing hosts", async () => {
      const sshClient = fakeSshClient(() => ({
        stdout: [
          "@NMAP",
          "@NEIGH",
          `192.168.1.2 dev eth0 lladdr ${MAC} REACHABLE`,
          "192.168.1.3 dev eth0 lladdr 11:22:33:44:55:66 STALE",
          "@NAME 192.168.1.3 desk.lan",
        ].join("\n"),
      }));
      server = await startServer({
        hosts: [hostOf(1, "zeus"), hostOf(2, "apollo")],
        permissions: ALL_PERMISSIONS,
        sshClient,
      });
      await server.mock.ctx.settings.setHost(1, "macAddress", MAC);
      const response = await server.request("POST", "/scan", {
        body: { relayId: 2 },
      });
      expect(response.status).toBe(200);
      expect(response.body.results).toEqual([
        expect.objectContaining({
          ip: "192.168.1.2",
          match: expect.objectContaining({ hostId: 1, by: "mac" }),
        }),
        expect.objectContaining({
          ip: "192.168.1.3",
          name: "desk.lan",
          match: null,
        }),
      ]);
    });

    it("refuses a range wider than a /22", async () => {
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ALL_PERMISSIONS,
      });
      const response = await server.request("POST", "/scan", {
        body: { relayId: 1, cidr: "10.0.0.0/16" },
      });
      expect(response.status).toBe(400);
    });

    it("never puts an unchecked range in a script", async () => {
      const sshClient = fakeSshClient(() => ({ stdout: "@NMAP\n@NEIGH\n" }));
      server = await startServer({
        hosts: [hostOf(1)],
        permissions: ALL_PERMISSIONS,
        sshClient,
      });
      const response = await server.request("POST", "/scan", {
        body: { relayId: 1, cidr: "10.0.0.0/24'; reboot; '" },
      });
      expect(response.status).toBe(400);
      expect(sshClient.runs).toHaveLength(0);
    });
  });

  it("turns Power on once for hosts with a saved MAC", async () => {
    server = await startServer({ hosts: [hostOf(1)] });
    await server.mock.ctx.settings.setHost(1, "macAddress", MAC);
    await server.mock.ctx.kv.delete("enabled-saved-macs");
    const { activate } = await import("../../src/backend/index.js");
    await activate(server.mock.ctx);
    expect(await server.mock.ctx.settings.getHost(1, "enablePower")).toBe(true);
    expect(await server.mock.ctx.kv.get("enabled-saved-macs")).toBe(true);
  });
});
