import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { CommandTarget, TestResult } from "../shared/types.js";
import type { Relay } from "./relay.js";

const SAFE_IP = /^[A-Za-z0-9.:-]+$/;
const SAFE_MAC = /^[0-9A-Fa-f:-]+$/;
const OUTPUT_LIMIT = 4000;
const COMMAND_TIMEOUT_MS = 30_000;

export class CommandError extends Error {}

/**
 * Fills in {{ DEVICE_IP }} and {{ DEVICE_MAC }}. A host's address is user
 * input and ends up in a shell, so anything unusual is refused, not escaped.
 */
export function substitute(
  command: string,
  values: { ip: string; mac: string },
): string {
  const usesIp = /\{\{\s*DEVICE_IP\s*\}\}/.test(command);
  const usesMac = /\{\{\s*DEVICE_MAC\s*\}\}/.test(command);
  if (usesIp && !SAFE_IP.test(values.ip)) {
    throw new CommandError("This device's IP can't be used in a command");
  }
  if (usesMac && !SAFE_MAC.test(values.mac)) {
    throw new CommandError("This device's MAC can't be used in a command");
  }
  return command
    .replace(/\{\{\s*DEVICE_IP\s*\}\}/g, values.ip)
    .replace(/\{\{\s*DEVICE_MAC\s*\}\}/g, values.mac);
}

export interface CommandRun {
  command: string;
  target: CommandTarget;
  hostId: number;
  relayId: number | null;
  /** The user who saved the command, never whoever pressed the button. */
  userId: string;
  timeoutMs?: number;
}

export interface CommandRunner {
  run: (run: CommandRun) => Promise<TestResult>;
}

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

export function createCommandRunner(
  ctx: PluginContext,
  relay: Relay,
): CommandRunner {
  async function onServer(run: CommandRun): Promise<TestResult> {
    const allowed = await ctx.settings.get<boolean>("allowServerCommands");
    if (allowed !== true) {
      throw new CommandError(
        "Commands on the Termix server are turned off. An admin can allow them in the plugin settings.",
      );
    }
    const child = await ctx.process.run("/bin/sh", ["-c", run.command], {
      timeoutMs: run.timeoutMs ?? COMMAND_TIMEOUT_MS,
    });
    let output = "";
    child.onStdout((chunk) => (output = clip(output + chunk)));
    child.onStderr((chunk) => (output = clip(output + chunk)));
    const { code } = await child.exited;
    return { ok: code === 0, code, output };
  }

  async function onHost(hostId: number, run: CommandRun): Promise<TestResult> {
    const result = await relay.command(
      hostId,
      run.userId,
      run.command,
      run.timeoutMs ?? COMMAND_TIMEOUT_MS,
    );
    return {
      ok: result.code === 0,
      code: result.code,
      output: clip(result.stdout + result.stderr),
    };
  }

  return {
    run(run) {
      if (run.target === "server") return onServer(run);
      if (run.target === "relay") {
        if (!run.relayId) {
          throw new CommandError("Pick a relay host for this command");
        }
        return onHost(run.relayId, run);
      }
      return onHost(run.hostId, run);
    },
  };
}
