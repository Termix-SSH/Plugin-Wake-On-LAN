import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { activate, deactivate } from "../../src/frontend/index";
import { runAction } from "../../src/frontend/api";

const state = vi.hoisted(() => ({
  desktop: true,
  defaultOrigin: "remote",
  remoteId: vi.fn(async (_syncId?: string | null) => 42 as number | null),
  host: {
    id: 7,
    syncId: "host-sync-id",
    connectionOrigin: null,
    localOnly: false,
  } as {
    id: number;
    syncId: string | null;
    connectionOrigin: "local" | "remote" | null;
    localOnly: boolean;
  } | null,
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isElectron: () => state.desktop,
  resolveConnectionOrigin: async (host: { connectionOrigin?: string | null }) =>
    host.connectionOrigin ?? state.defaultOrigin,
  resolveRemoteHostId: state.remoteId,
}));

const local = {
  get: vi.fn(async () => ({ data: { devices: [], can: {} } })),
  post: vi.fn(async () => ({ data: {} })),
};
const remote = { post: vi.fn(async () => ({ data: {} })) };
const apiFor = vi.fn(() => remote);

beforeEach(() => {
  vi.clearAllMocks();
  state.desktop = true;
  state.defaultOrigin = "remote";
  state.host = {
    id: 7,
    syncId: "host-sync-id",
    connectionOrigin: null,
    localOnly: false,
  };
  state.remoteId.mockResolvedValue(42);
  apiFor.mockReturnValue(remote);
  remote.post.mockResolvedValue({ data: {} });
  activate({
    t: (key: string) => key,
    api: local,
    apiFor,
    getHost: () => state.host,
    registerTab: vi.fn(),
    registerRailItem: vi.fn(),
    registerHostAction: vi.fn(),
    registerDashboardCard: vi.fn(),
    registerSlotContribution: vi.fn(),
    registerExtension: vi.fn(),
    registerAction: vi.fn(),
  } as unknown as TermixApp);
});
afterEach(deactivate);

describe("manual wake connection origin", () => {
  it("uses the server default and resolves the server ID instead of the desktop ID", async () => {
    await runAction(7, "wake");
    expect(state.remoteId).toHaveBeenCalledWith("host-sync-id");
    expect(apiFor).toHaveBeenCalledWith("remote");
    expect(remote.post).toHaveBeenCalledWith("/devices/42/wake");
    expect(local.post).not.toHaveBeenCalled();
  });

  it("honors a host's remote override of a local default", async () => {
    state.defaultOrigin = "local";
    state.host!.connectionOrigin = "remote";
    await runAction(7, "wake");
    expect(remote.post).toHaveBeenCalledWith("/devices/42/wake");
    expect(local.post).not.toHaveBeenCalled();
  });

  it.each(["override", "local-only", "web"])(
    "keeps %s wakes local",
    async (mode) => {
      if (mode === "override") state.host!.connectionOrigin = "local";
      if (mode === "local-only") state.host!.localOnly = true;
      if (mode === "web") state.desktop = false;
      await runAction(7, "wake");
      expect(local.post).toHaveBeenCalledWith("/devices/7/wake");
      expect(state.remoteId).not.toHaveBeenCalled();
      expect(apiFor).not.toHaveBeenCalled();
    },
  );

  it.each(["host", "mapping", "lookup", "api", "request"])(
    "does not fall back locally on a missing or failed %s",
    async (failure) => {
      if (failure === "host") state.host = null;
      if (failure === "mapping") state.remoteId.mockResolvedValue(null);
      if (failure === "lookup")
        state.remoteId.mockRejectedValueOnce(new Error("Offline"));
      if (failure === "api")
        apiFor.mockImplementationOnce(() => {
          throw new Error("Unlinked");
        });
      if (failure === "request")
        remote.post.mockRejectedValueOnce(new Error("Forbidden"));
      await expect(runAction(7, "wake")).rejects.toThrow();
      expect(local.post).not.toHaveBeenCalled();
      if (failure !== "request") expect(remote.post).not.toHaveBeenCalled();
    },
  );

  it("does not reroute other power actions", async () => {
    await runAction(7, "shutdown");
    expect(local.post).toHaveBeenCalledWith("/devices/7/shutdown");
    expect(apiFor).not.toHaveBeenCalled();
  });
});
