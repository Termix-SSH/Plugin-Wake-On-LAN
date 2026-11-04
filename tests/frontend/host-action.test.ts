import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { toast } from "sonner";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import { initApi } from "../../src/frontend/api.js";
import { timeAgo } from "../../src/frontend/format.js";
import {
  hasMacAddress,
  macAddressOf,
  powerAction,
} from "../../src/frontend/host-action.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

function stubApi(overrides: Partial<PluginApiClient> = {}): PluginApiClient {
  return {
    get: vi.fn(async () => ({ data: { devices: [], can: {} } })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    ...overrides,
  } as PluginApiClient;
}

const t = (key: string) => key;
const device = {
  hostId: 7,
  name: "zeus",
  wakeConfirm: false,
  shutdownConfirm: true,
};

describe("macAddressOf", () => {
  it("reads the trimmed MAC from plugin settings", () => {
    expect(
      macAddressOf({
        pluginSettings: { "wake-on-lan": { macAddress: " aa:bb " } },
      }),
    ).toBe("aa:bb");
  });

  it("is null for a blank or missing MAC", () => {
    expect(macAddressOf(null)).toBeNull();
    expect(macAddressOf({ pluginSettings: {} })).toBeNull();
    expect(
      hasMacAddress({
        pluginSettings: { "wake-on-lan": { macAddress: "  " } },
      }),
    ).toBe(false);
  });
});

describe("powerAction", () => {
  let api: PluginApiClient;

  beforeEach(() => {
    api = stubApi();
    initApi(api);
  });

  it("wakes with no question when the device doesn't ask", async () => {
    const confirm = vi.fn();
    expect(await powerAction(device, "wake", t as never, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith("/devices/7/wake");
    expect(toast.success).toHaveBeenCalled();
  });

  it("asks first when the device wants that, and stops on no", async () => {
    const confirm = vi.fn(async () => false);
    expect(await powerAction(device, "shutdown", t as never, confirm)).toBe(
      false,
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("shows the server's error", async () => {
    initApi(
      stubApi({
        post: vi.fn(async () => {
          throw { response: { data: { error: "No route" } } };
        }) as never,
      }),
    );
    expect(await powerAction(device, "wake", t as never, vi.fn())).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("No route");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");

  it("says how long ago", () => {
    expect(timeAgo("2026-11-03T10:00:00Z", "en", now)).toBe("2 hours ago");
    expect(timeAgo("2026-11-03T11:55:00Z", "en", now)).toBe("5 minutes ago");
  });

  it("handles a language written with an underscore", () => {
    expect(timeAgo("2026-11-03T10:00:00Z", "pt_BR", now)).toContain("2");
  });

  it("is null with no time", () => {
    expect(timeAgo(null, "en", now)).toBeNull();
  });
});
