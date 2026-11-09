import type {
  PluginContext,
  PluginSshHost,
} from "@termix-ssh/plugin-sdk/backend";
import { scriptShell } from "@termix-ssh/plugin-sdk/host-scripts";

const POOL = "wake-on-lan";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
/** A resolved login is reused this long, so polling adds no audit lines. */
const RESOLVED_TTL_MS = 10 * 60_000;

export interface RelayResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

interface ExecStream {
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  stderr: { on: (event: string, listener: (chunk: Buffer) => void) => unknown };
  end: (data?: string) => unknown;
  close: () => void;
}

interface ExecClient {
  exec: (
    command: string,
    callback: (error: Error | undefined, stream: ExecStream) => void,
  ) => unknown;
}

function runOn(
  client: ExecClient,
  command: string,
  stdin: string | undefined,
  timeoutMs: number,
): Promise<RelayResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
      }, timeoutMs);
      stream.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      });
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          code: timedOut ? null : (code ?? null),
          timedOut,
        });
      });
      stream.end(stdin);
    });
  });
}

export interface Relay {
  /** Runs a bash script on an SSH host as `userId`, over a pooled connection. */
  run: (
    hostId: number,
    userId: string,
    script: string,
    timeoutMs?: number,
  ) => Promise<RelayResult>;
  /** Runs a command in the host's own login shell, which may not be bash. */
  command: (
    hostId: number,
    userId: string,
    command: string,
    timeoutMs?: number,
  ) => Promise<RelayResult>;
}

export function createRelay(ctx: PluginContext): Relay {
  const resolved = new Map<string, { host: PluginSshHost; at: number }>();

  async function resolve(hostId: number, userId: string) {
    const key = `${hostId}:${userId}`;
    const cached = resolved.get(key);
    if (cached && Date.now() - cached.at < RESOLVED_TTL_MS) return cached.host;
    // asUser writes an audit line, so it runs once per login, not per check.
    const host = await ctx.asUser(userId, () => ctx.ssh.resolveHost(hostId));
    if (!host) throw new Error("The relay host cannot be reached");
    resolved.set(key, { host, at: Date.now() });
    return host;
  }

  async function exec(
    hostId: number,
    userId: string,
    command: string,
    stdin: string | undefined,
    timeoutMs: number,
  ) {
    const host = await resolve(hostId, userId);
    try {
      return await ctx.ssh.withConnection<RelayResult, ExecClient>(
        host,
        { pool: POOL, purpose: "wake-on-lan" },
        (client) => runOn(client, command, stdin, timeoutMs),
      );
    } catch (error) {
      resolved.delete(`${hostId}:${userId}`);
      throw error;
    }
  }

  return {
    run: (hostId, userId, script, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      exec(hostId, userId, scriptShell("plain"), script, timeoutMs),
    command: (hostId, userId, command, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      exec(hostId, userId, command, undefined, timeoutMs),
  };
}
