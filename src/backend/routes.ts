import type { Request, Response, Router } from "express";
import type {
  PluginContext,
  PluginHostSummary,
} from "@termix-ssh/plugin-sdk/backend";
import type {
  CommandKind,
  DeviceDetail,
  DeviceInput,
  DeviceSummary,
  ScanResponse,
} from "../shared/types.js";
import {
  relaysOf,
  runsOnServer,
  toConfig,
  toPatch,
  validateInput,
  type DeviceRow,
  type DeviceStore,
} from "./devices.js";
import { isValidMac } from "./magic-packet.js";
import { PowerError, type PowerManager } from "./power.js";
import type { Relay } from "./relay.js";
import {
  expandCidr,
  parseRelayOutput,
  relayScanScript,
  serverScan,
  withMatches,
  type Found,
  type KnownHost,
} from "./scan.js";
import type { StatusTracker } from "./status.js";

const SCAN_TIMEOUT_MS = 120_000;
const NEW_HOST_FOLDER = "Power";
const NAME_MAX = 120;

export interface RouteDeps {
  store: DeviceStore;
  status: StatusTracker;
  power: PowerManager;
  relay: Relay;
}

function intParam(value: unknown): number | null {
  const number = Number.parseInt(String(value), 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function fail(res: Response, error: unknown) {
  if (error instanceof PowerError) {
    return res.status(error.status).json({ error: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return res.status(502).json({ error: message });
}

export function registerWakeOnLanRoutes(
  router: Router,
  ctx: PluginContext,
  { store, status, power, relay }: RouteDeps,
): void {
  const allowed = (level: "connect" | "edit", hostId: number) =>
    ctx.hosts.checkAccess(hostId, level).then((access) => {
      if (!access.hasAccess) return false;
      if (level === "connect" || access.isOwner) return true;
      const rank = access.permissionLevel ?? "connect";
      return rank === "edit" || rank === "manage";
    });

  /** Hosts the actor can see with Power on, and their saved rows. */
  async function visible() {
    const [hosts, enabled, macs, rows] = await Promise.all([
      ctx.hosts.list(),
      ctx.settings.listHostValues<boolean>("enablePower"),
      ctx.settings.listHostValues<string>("macAddress"),
      store.all(),
    ]);
    const on = new Set(
      enabled.filter((row) => row.value === true).map((row) => row.hostId),
    );
    return {
      hosts: hosts.filter((host) => on.has(host.id)),
      all: hosts,
      macOf: new Map(macs.map((row) => [row.hostId, row.value ?? ""])),
      rowOf: new Map(rows.map((row) => [row.hostId, row])),
    };
  }

  async function summaryOf(
    host: PluginHostSummary,
    row: DeviceRow | undefined,
    mac: string,
  ): Promise<DeviceSummary> {
    const hasRow = row ?? null;
    const view = status.view(
      host.id,
      hasRow ?? ({ status: "unknown", openPorts: "" } as DeviceRow),
    );
    return {
      hostId: host.id,
      name: host.name || host.ip,
      address: row?.lanIp || host.ip,
      folder: host.folder ?? null,
      macAddress: mac,
      description: row?.description ?? "",
      linkUrl: row?.linkUrl ?? "",
      autoOpenLink: row?.autoOpenLink ?? false,
      status: view.status,
      openPorts: view.openPorts,
      statusChangedAt: view.statusChangedAt,
      lastSeenAt: view.lastSeenAt,
      wakeConfirm: row?.wakeConfirm ?? false,
      shutdownConfirm: row?.shutdownConfirm ?? true,
      canWake: row?.wakeMode === "custom" || isValidMac(mac.trim()),
      canShutdown: (row?.shutdownMode ?? "none") !== "none",
      canSleep: row?.solEnabled ?? false,
      canEdit: await allowed("edit", host.id),
    };
  }

  /**
   * @openapi
   * /plugin-api/wake-on-lan/devices:
   *   get:
   *     summary: List devices with Power on and what the caller may do
   *     tags:
   *       - Wake-on-LAN
   *     responses:
   *       200:
   *         description: Devices and permissions
   */
  router.get("/devices", async (_req: Request, res: Response) => {
    const { hosts, macOf, rowOf } = await visible();
    const devices = await Promise.all(
      hosts.map((host) =>
        summaryOf(host, rowOf.get(host.id), macOf.get(host.id) ?? ""),
      ),
    );
    res.json({
      devices,
      can: {
        wake: await ctx.rbac.has("send"),
        shutdown: await ctx.rbac.has("shutdown"),
        scan: await ctx.rbac.has("scan"),
        server: await ctx.rbac.has("server-commands"),
      },
    });
  });

  /**
   * @openapi
   * /plugin-api/wake-on-lan/status:
   *   get:
   *     summary: Current status of every device the caller can see
   *     tags:
   *       - Wake-on-LAN
   *     responses:
   *       200:
   *         description: Status per device
   */
  router.get("/status", async (_req: Request, res: Response) => {
    const { hosts, rowOf } = await visible();
    res.json({
      statuses: hosts.map((host) =>
        status.view(
          host.id,
          rowOf.get(host.id) ??
            ({ status: "unknown", openPorts: "" } as DeviceRow),
        ),
      ),
    });
  });

  /**
   * @openapi
   * /plugin-api/wake-on-lan/devices/{hostId}:
   *   get:
   *     summary: One device's settings, without its passwords
   *     tags:
   *       - Wake-on-LAN
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Device settings
   *       403:
   *         description: Needs edit access to the host
   *       404:
   *         description: Host not found
   */
  router.get("/devices/:hostId", async (req: Request, res: Response) => {
    const hostId = intParam(req.params.hostId);
    const host = hostId ? await ctx.hosts.get(hostId) : null;
    if (!host) return res.status(404).json({ error: "Host not found" });
    if (!(await allowed("edit", host.id))) {
      return res.status(403).json({ error: "You can't edit this host" });
    }
    const row = await store.read(host.id);
    const macAddress =
      (await ctx.settings.getHost<string>(host.id, "macAddress")) ?? "";
    const detail: DeviceDetail = {
      summary: await summaryOf(host, row, macAddress),
      macAddress,
      broadcastAddress:
        (await ctx.settings.getHost<string>(host.id, "broadcastAddress")) ?? "",
      config: await toConfig(ctx, row),
      secrets: {
        hasSecureOn: row.secureOnSealed !== null,
        hasSolPassword: row.solPasswordSealed !== null,
      },
    };
    res.json(detail);
  });

  /**
   * @openapi
   * /plugin-api/wake-on-lan/devices/{hostId}:
   *   put:
   *     summary: Save a device and turn Power on for its host
   *     tags:
   *       - Wake-on-LAN
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Saved
   *       400:
   *         description: Invalid settings
   *       403:
   *         description: Needs edit access, or access to a relay
   *       404:
   *         description: Host not found
   */
  router.put("/devices/:hostId", async (req: Request, res: Response) => {
    const hostId = intParam(req.params.hostId);
    const host = hostId ? await ctx.hosts.get(hostId) : null;
    if (!host) return res.status(404).json({ error: "Host not found" });
    if (!(await allowed("edit", host.id))) {
      return res.status(403).json({ error: "You can't edit this host" });
    }
    const input = req.body as DeviceInput;
    const problem = validateInput(input);
    if (problem) return res.status(400).json({ error: problem });
    if (runsOnServer(input) && !(await ctx.rbac.has("server-commands"))) {
      return res.status(403).json({
        error: "You can't save commands that run on the Termix server",
      });
    }
    for (const relayId of relaysOf(input)) {
      if (!(await allowed("connect", relayId))) {
        return res.status(403).json({ error: "You can't use that relay host" });
      }
    }
    const userId = ctx.currentActor() as string;
    const current = await store.read(host.id);
    await store.save(host.id, await toPatch(ctx, input, current, userId));
    await ctx.settings.setHost(host.id, "enablePower", true);
    await ctx.settings.setHost(host.id, "macAddress", input.macAddress.trim());
    await ctx.settings.setHost(
      host.id,
      "broadcastAddress",
      input.broadcastAddress.trim(),
    );
    res.json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/wake-on-lan/devices:
   *   post:
   *     summary: Add a new host with Power on
   *     tags:
   *       - Wake-on-LAN
   *     responses:
   *       201:
   *         description: Host created
   *       400:
   *         description: Invalid name, address or MAC
   *       403:
   *         description: Not allowed to add hosts, or to use that relay
   */
  router.post("/devices", async (req: Request, res: Response) => {
    const { name, ip, mac, relayId } = (req.body ?? {}) as {
      name?: string;
      ip?: string;
      mac?: string;
      relayId?: number | null;
    };
    const cleanName = String(name ?? "")
      .trim()
      .slice(0, NAME_MAX);
    const cleanIp = String(ip ?? "").trim();
    const cleanMac = String(mac ?? "").trim();
    if (!cleanName || !/^[A-Za-z0-9.:-]+$/.test(cleanIp)) {
      return res.status(400).json({ error: "Enter a name and an address" });
    }
    if (!isValidMac(cleanMac)) {
      return res.status(400).json({ error: "Invalid MAC address" });
    }
    if (!(await ctx.rbac.has("hosts.create"))) {
      return res.status(403).json({ error: "You can't add hosts" });
    }
    if (relayId && !(await allowed("connect", relayId))) {
      return res.status(403).json({ error: "You can't use that relay host" });
    }
    await ctx.hosts.folders
      .ensure(NEW_HOST_FOLDER, { icon: "Zap" })
      .catch(() => {});
    const host = await ctx.hosts.create({
      name: cleanName,
      ip: cleanIp,
      port: 22,
      username: "",
      authType: "none",
      enableSsh: false,
      statusCheckEnabled: false,
      folder: NEW_HOST_FOLDER,
      pluginSettings: { [ctx.pluginId]: { macAddress: cleanMac } },
      pluginEnable: { [ctx.pluginId]: true },
    });
    await store.save(host.id, {
      lanIp: cleanIp,
      wakeFrom: relayId ?? null,
      statusFrom: relayId ?? null,
      updatedBy: ctx.currentActor() as string,
    });
    res.status(201).json({ hostId: host.id });
  });

  const action =
    (run: (hostId: number) => Promise<void>) =>
    async (req: Request, res: Response) => {
      const hostId = intParam(req.params.hostId);
      if (!hostId) return res.status(400).json({ error: "Invalid host id" });
      if (!(await allowed("connect", hostId))) {
        return res.status(404).json({ error: "Host not found" });
      }
      try {
        await run(hostId);
        res.json({ success: true });
      } catch (error) {
        fail(res, error);
      }
    };

  /**
   * @openapi
   * /plugin-api/wake-on-lan/devices/{hostId}/wake:
   *   post:
   *     summary: Wake a device with its saved method
   *     tags:
   *       - Wake-on-LAN
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Wake started
   *       400:
   *         description: The device can't be woken
   *       404:
   *         description: Host not found
   */
  router.post(
    "/devices/:hostId/wake",
    ctx.rbac.require("send") as never,
    action((hostId) => power.wake(hostId)),
  );

  /**
   * @openapi
   * /plugin-api/wake-on-lan/devices/{hostId}/shutdown:
   *   post:
   *     summary: Shut a device down with its saved method
   *     tags:
   *       - Wake-on-LAN
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Shutdown started
   *       400:
   *         description: No shutdown method is set
   *       404:
   *         description: Host not found
   */
  router.post(
    "/devices/:hostId/shutdown",
    ctx.rbac.require("shutdown") as never,
    action((hostId) => power.shutdown(hostId)),
  );

  /**
   * @openapi
   * /plugin-api/wake-on-lan/devices/{hostId}/sleep:
   *   post:
   *     summary: Put a device to sleep through Sleep-On-LAN
   *     tags:
   *       - Wake-on-LAN
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Sleep started
   *       400:
   *         description: Sleep-On-LAN is off or did not answer
   *       404:
   *         description: Host not found
   */
  router.post(
    "/devices/:hostId/sleep",
    ctx.rbac.require("shutdown") as never,
    action((hostId) => power.sleep(hostId)),
  );

  /**
   * @openapi
   * /plugin-api/wake-on-lan/devices/{hostId}/test:
   *   post:
   *     summary: Run a saved command once and return its output
   *     tags:
   *       - Wake-on-LAN
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               kind:
   *                 type: string
   *                 enum: [wake, shutdown, ping]
   *     responses:
   *       200:
   *         description: Exit code and output
   *       400:
   *         description: No command is saved
   *       403:
   *         description: Needs edit access to the host
   */
  router.post("/devices/:hostId/test", async (req: Request, res: Response) => {
    const hostId = intParam(req.params.hostId);
    const kind = (req.body as { kind?: CommandKind } | undefined)?.kind;
    if (!hostId || !kind || !["wake", "shutdown", "ping"].includes(kind)) {
      return res.status(400).json({ error: "Invalid test" });
    }
    if (!(await allowed("edit", hostId))) {
      return res.status(403).json({ error: "You can't edit this host" });
    }
    try {
      res.json(await power.test(hostId, kind));
    } catch (error) {
      fail(res, error);
    }
  });

  async function knownHosts(): Promise<KnownHost[]> {
    const { all, macOf, rowOf } = await visible();
    return all.map((host) => ({
      id: host.id,
      name: host.name || host.ip,
      ip: host.ip,
      mac: macOf.get(host.id) ?? "",
      lanIp: rowOf.get(host.id)?.lanIp ?? "",
    }));
  }

  /**
   * @openapi
   * /plugin-api/wake-on-lan/scan:
   *   post:
   *     summary: Find machines on a network, from a relay host or the server
   *     tags:
   *       - Wake-on-LAN
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               relayId:
   *                 type: integer
   *               cidr:
   *                 type: string
   *     responses:
   *       200:
   *         description: Machines found, matched against existing hosts
   *       400:
   *         description: Invalid range
   *       403:
   *         description: Not allowed to scan from there
   */
  router.post(
    "/scan",
    ctx.rbac.require("scan") as never,
    async (req: Request, res: Response) => {
      const { relayId, cidr } = (req.body ?? {}) as {
        relayId?: number | null;
        cidr?: string;
      };
      const range = cidr?.trim() || null;
      const addresses = range ? expandCidr(range) : null;
      if (range && !addresses) {
        return res
          .status(400)
          .json({ error: "Enter a range like 192.168.1.0/24, /22 at most" });
      }
      let found: Found[];
      if (relayId) {
        if (!(await allowed("connect", relayId))) {
          return res.status(403).json({ error: "You can't use that host" });
        }
        try {
          const result = await relay.run(
            relayId,
            ctx.currentActor() as string,
            relayScanScript(range),
            SCAN_TIMEOUT_MS,
          );
          if (result.timedOut) {
            return res.status(400).json({
              error: "The scan took too long. Try a smaller range.",
            });
          }
          if (result.code !== 0) {
            return res.status(400).json({
              error: result.stderr.trim() || "The scan failed on that host",
            });
          }
          const wanted = addresses ? new Set(addresses) : null;
          found = parseRelayOutput(result.stdout).filter(
            (entry) => !wanted || wanted.has(entry.ip),
          );
        } catch (error) {
          return fail(res, error);
        }
      } else {
        if (!(await ctx.rbac.has("server-commands"))) {
          return res
            .status(403)
            .json({ error: "Only admins can scan from the Termix server" });
        }
        if (!addresses) {
          return res
            .status(400)
            .json({ error: "Enter a range to scan from the server" });
        }
        found = await serverScan(addresses);
      }
      const response: ScanResponse = {
        results: withMatches(found, await knownHosts()),
        hint:
          !relayId && found.length <= 1
            ? "bridge"
            : found.some((entry) => !entry.mac)
              ? "no-mac"
              : null,
      };
      res.json(response);
    },
  );

  /**
   * @openapi
   * /plugin-api/wake-on-lan/scan/attach:
   *   post:
   *     summary: Attach a scan result to an existing host
   *     tags:
   *       - Wake-on-LAN
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               hostId:
   *                 type: integer
   *               ip:
   *                 type: string
   *               mac:
   *                 type: string
   *               relayId:
   *                 type: integer
   *     responses:
   *       200:
   *         description: Attached, no new host was made
   *       400:
   *         description: Invalid address or MAC
   *       403:
   *         description: Needs edit access to the host and connect to the relay
   */
  router.post("/scan/attach", async (req: Request, res: Response) => {
    const { hostId, ip, mac, relayId } = (req.body ?? {}) as {
      hostId?: number;
      ip?: string;
      mac?: string;
      relayId?: number | null;
    };
    const id = intParam(hostId);
    if (!id || !isValidMac(String(mac ?? "").trim())) {
      return res.status(400).json({ error: "Invalid MAC address" });
    }
    if (!/^[A-Za-z0-9.:-]+$/.test(String(ip ?? ""))) {
      return res.status(400).json({ error: "Invalid address" });
    }
    if (!(await allowed("edit", id))) {
      return res.status(403).json({ error: "You can't edit this host" });
    }
    if (relayId && !(await allowed("connect", relayId))) {
      return res.status(403).json({ error: "You can't use that relay host" });
    }
    await store.save(id, {
      lanIp: String(ip),
      wakeFrom: relayId ?? null,
      updatedBy: ctx.currentActor() as string,
    });
    await ctx.settings.setHost(id, "enablePower", true);
    await ctx.settings.setHost(id, "macAddress", String(mac).trim());
    res.json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/wake-on-lan/host/{id}/wake:
   *   post:
   *     summary: Send a Wake-on-LAN magic packet to a host
   *     tags:
   *       - Wake-on-LAN
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Packet sent
   *       400:
   *         description: No valid MAC address configured
   *       404:
   *         description: Host not found
   */
  router.post(
    "/host/:id/wake",
    ctx.rbac.require("send") as never,
    async (req: Request, res: Response) => {
      const hostId = Number.parseInt(String(req.params.id), 10);
      if (!Number.isInteger(hostId)) {
        return res.status(400).json({ error: "Invalid host id" });
      }
      try {
        await power.wake(hostId);
        res.json({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message === "Host not found" ? 404 : 400;
        res.status(code).json({ error: message });
      }
    },
  );
}
