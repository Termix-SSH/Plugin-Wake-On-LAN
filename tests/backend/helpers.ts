import http from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import path from "node:path";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type {
  PluginHostProbeTarget,
  PluginHostSummary,
  PluginSshHost,
} from "@termix-ssh/plugin-sdk/backend";
import manifestJson from "../../manifest.json";

export const manifest = manifestJson as unknown as PluginManifest;

export const ALL_PERMISSIONS = [
  "wake-on-lan.send",
  "wake-on-lan.shutdown",
  "wake-on-lan.scan",
  "wake-on-lan.server-commands",
];

export interface FakeSshRun {
  command: string;
  stdin: string | undefined;
}

/** An ssh2 client that records what it runs and answers from `reply`. */
export function fakeSshClient(
  reply: (run: FakeSshRun) => {
    stdout?: string;
    stderr?: string;
    code?: number;
  },
) {
  const runs: FakeSshRun[] = [];
  return {
    runs,
    exec(
      command: string,
      callback: (error: undefined, stream: unknown) => void,
    ) {
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        close: () => void;
        end: (data?: string) => void;
      };
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      stream.end = (stdin) => {
        const run = { command, stdin };
        runs.push(run);
        const answer = reply(run);
        queueMicrotask(() => {
          if (answer.stdout) stream.emit("data", Buffer.from(answer.stdout));
          if (answer.stderr) {
            stream.stderr.emit("data", Buffer.from(answer.stderr));
          }
          stream.emit("close", answer.code ?? 0);
        });
      };
      callback(undefined, stream);
    },
  };
}

export function hostOf(id: number, name = `host-${id}`): PluginHostSummary {
  return {
    id,
    userId: "user-1",
    name,
    ip: `10.0.0.${id}`,
    port: 22,
    username: "root",
    tags: null,
    folder: null,
    authType: "password",
  };
}

export function targetOf(host: PluginHostSummary): PluginHostProbeTarget {
  return {
    id: host.id,
    ownerUserId: "user-1",
    ip: host.ip,
    port: host.port,
    connectionType: "ssh",
    jumpHosts: [],
    statusCheckEnabled: true,
    statusCheckInterval: null,
  };
}

export function sshHostOf(host: PluginHostSummary): PluginSshHost {
  return { ...host };
}

export interface TestServer {
  mock: MockPluginContext;
  request: (
    method: string,
    path: string,
    options?: { user?: string; body?: unknown },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

export async function startServer(
  options: {
    permissions?: string[];
    hosts?: PluginHostSummary[];
    capabilities?: string[];
    sshClient?: unknown;
    settings?: Record<string, unknown>;
  } = {},
): Promise<TestServer> {
  let router: Router | null = null;
  const hosts = options.hosts ?? [];
  const db = await createTestDb(path.resolve(__dirname, "../.."));
  // The fake hosts API has no ssh_data rows, so the foreign key needs them.
  const addRow = db.sqlite.prepare(
    "INSERT OR IGNORE INTO ssh_data (id) VALUES (?)",
  );
  for (const host of hosts) addRow.run(host.id);
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: options.capabilities ?? manifest.capabilities,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ["wake-on-lan.send"],
    hosts,
    sshHosts: hosts.map(sshHostOf),
    probeTargets: hosts.map(targetOf),
    sshClient: options.sshClient,
    settings: options.settings,
    db: db.database,
    actor: "user-1",
  });

  const create = mock.ctx.hosts.create.bind(mock.ctx.hosts);
  mock.ctx.hosts.create = async (input) => {
    const host = await create(input);
    addRow.run(host.id);
    return host;
  };

  const { activate } = await import("../../src/backend/index.js");
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") ?? undefined);
    next();
  });
  app.use((req, res, next) => router!(req, res, next));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    mock,
    async request(method, path, { user = "user-1", body: given } = {}) {
      const body = method === "GET" ? undefined : given;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          "x-test-user": user,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
