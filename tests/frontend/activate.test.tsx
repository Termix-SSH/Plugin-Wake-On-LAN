import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import type { DeviceSummary } from "../../src/shared/types";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  plugin.deactivate();
});

function device(patch: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    hostId: 2,
    name: "desk",
    address: "10.0.0.2",
    folder: null,
    macAddress: "AA:BB:CC:DD:EE:FF",
    description: "",
    linkUrl: "",
    autoOpenLink: false,
    status: "offline",
    openPorts: [],
    statusChangedAt: null,
    lastSeenAt: null,
    wakeConfirm: false,
    shutdownConfirm: true,
    canWake: true,
    canShutdown: false,
    canSleep: false,
    canEdit: true,
    ...patch,
  };
}

function stubApi(devices: DeviceSummary[]) {
  return {
    get: vi.fn(async (path: string) => ({
      data:
        path === "/status"
          ? { statuses: devices }
          : {
              devices,
              can: { wake: true, shutdown: true, scan: true, server: false },
            },
    })),
    post: vi.fn(async () => ({ data: {} })),
  };
}

describe(`${manifest.id} activate`, () => {
  it("registers the host actions", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi([]) as never,
    });
    expect(rendered.registered.hostActions().map((a) => a.id)).toEqual([
      "wake-on-lan",
      "wake-on-lan.shutdown",
      "wake-on-lan.settings",
    ]);
  });

  it("removes the host actions on deactivate", async () => {
    const app = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi([]) as never,
    });
    await app.deactivate();
    expect(app.registered.hostActions()).toEqual([]);
  });

  it("offers a homepage widget", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi([]) as never,
    });
    expect(rendered.registered.extensions("homepage.widgets")).toEqual([
      "power",
    ]);
  });
});

describe("power dashboard card", () => {
  it("wakes a device that is off", async () => {
    const api = stubApi([device()]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api as never,
    });
    rendered.renderDashboardCard("wake-on-lan");
    expect(await screen.findByText("desk")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText("Wake"));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/devices/2/wake"),
    );
  });

  it("offers shut down once a device is on", async () => {
    const api = stubApi([device({ status: "online", canShutdown: true })]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api as never,
    });
    rendered.renderDashboardCard("wake-on-lan");
    expect(await screen.findByLabelText("Shut down")).toBeTruthy();
  });

  it("disables the button with nothing it can do", async () => {
    const api = stubApi([device({ status: "online" })]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api as never,
    });
    rendered.renderDashboardCard("wake-on-lan");
    const labelled = await screen.findAllByLabelText("Online");
    const button = labelled.find((node) => node.tagName === "BUTTON");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("power tab", () => {
  it("shows devices with their folder and a scan button", async () => {
    const api = stubApi([device({ folder: "Home", openPorts: [22] })]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api as never,
    });
    rendered.renderTab("power", { isVisible: true, tab: {} });
    expect(await screen.findByText("desk")).toBeTruthy();
    expect(await screen.findByText("Home")).toBeTruthy();
    expect(await screen.findByText("22")).toBeTruthy();
    expect(await screen.findByText("Scan")).toBeTruthy();
    expect(await screen.findByText("Wake all")).toBeTruthy();
  });
});
