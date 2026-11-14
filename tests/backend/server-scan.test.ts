import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { readServerArpTable, serverScan } from "../../src/backend/scan.js";
import { createBmc } from "../../src/backend/bmc.js";

const ARP = [
  "IP address       HW type     Flags       HW address            Mask     Device",
  "127.0.0.1        0x1         0x2         38:05:25:34:3c:c1     *        eth0",
].join("\n");

function processCtx(output: string, code = 0) {
  const run = vi.fn(async () => ({
    pid: 1,
    onStdout: (listener: (chunk: string) => void) => listener(output),
    onStderr: () => undefined,
    kill: () => undefined,
    exited: Promise.resolve({ code }),
  }));
  return { ctx: { process: { run } } as unknown as PluginContext, run };
}

describe("server scan", () => {
  it("reads the ARP table through a child process", async () => {
    const { ctx, run } = processCtx(ARP);
    expect(await readServerArpTable(ctx)).toBe(ARP);
    expect(run).toHaveBeenCalledWith("cat", ["/proc/net/arp"], {
      timeoutMs: 5000,
    });
  });

  it("gives an empty table when the read fails", async () => {
    const { ctx } = processCtx("partial", 1);
    expect(await readServerArpTable(ctx)).toBe("");
  });

  it("keeps only the addresses asked for", async () => {
    const found = await serverScan(["127.0.0.1"], async () => ARP);
    expect(found).toEqual([
      expect.objectContaining({ ip: "127.0.0.1", mac: "38:05:25:34:3c:c1" }),
    ]);
  });
});

describe("out-of-band power", () => {
  // In a plugin process every services call answers through a promise.
  it("finds the service when services answer through promises", async () => {
    const has = vi.fn(async () => true);
    const ctx = {
      services: {
        providers: async () => [""],
        get: async () => ({ has, set: vi.fn() }),
      },
      asUser: (_user: string, fn: () => Promise<unknown>) => fn(),
    } as unknown as PluginContext;
    expect(await createBmc(ctx).available(4, "user-1")).toBe(true);
    expect(has).toHaveBeenCalledWith(4);
  });

  it("is unavailable without the Out-of-band plugin", async () => {
    const ctx = {
      services: { providers: async () => [], get: vi.fn() },
    } as unknown as PluginContext;
    expect(await createBmc(ctx).available(4, null)).toBe(false);
  });
});
