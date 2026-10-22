import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("registers the Wake host action", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.hostActions()).toEqual([
      expect.objectContaining({ id: "wake-on-lan" }),
    ]);
  });

  it("removes the host action on deactivate", async () => {
    const app = await renderWithApp(plugin, { manifest, locales });
    await app.deactivate();
    expect(app.registered.hostActions()).toEqual([]);
  });
});

describe("wake dashboard card", () => {
  it("wakes a host with a MAC address", async () => {
    const api = { post: vi.fn(async () => ({ data: {} })) };
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api as never,
      permissions: ["wake-on-lan.send"],
      hosts: [
        {
          id: "2",
          name: "desk",
          ip: "10.0.0.2",
          port: 22,
          pluginSettings: {
            "wake-on-lan": { macAddress: "AA:BB:CC:DD:EE:FF" },
          },
        },
        { id: "3", name: "nas", ip: "10.0.0.3", port: 22 },
      ],
    });
    expect(rendered.registered.dashboardCards()).toEqual(["wake-on-lan"]);
    rendered.renderDashboardCard("wake-on-lan");
    expect(await screen.findByText("desk")).toBeTruthy();
    expect(screen.queryByText("nas")).toBeNull();
    fireEvent.click(screen.getByLabelText("Wake"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/host/2/wake"));
  });
});
