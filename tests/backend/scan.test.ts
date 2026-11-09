import { describe, it, expect } from "vitest";
import {
  expandCidr,
  matchHost,
  parseIpNeigh,
  parseNmap,
  parseProcArp,
  parseRelayOutput,
  relayScanScript,
} from "../../src/backend/scan.js";

const ZEUS = {
  id: 1,
  name: "Zeus",
  ip: "100.120.96.31",
  mac: "38:05:25:34:3C:C1",
  lanIp: "",
};

describe("expandCidr", () => {
  it("lists the usable addresses", () => {
    const list = expandCidr("192.168.1.0/24")!;
    expect(list).toHaveLength(254);
    expect(list[0]).toBe("192.168.1.1");
    expect(list.at(-1)).toBe("192.168.1.254");
  });

  it("starts at the network, whatever address was given", () => {
    expect(expandCidr("192.168.1.77/30")).toEqual([
      "192.168.1.77",
      "192.168.1.78",
    ]);
  });

  it("refuses wide or invalid ranges", () => {
    expect(expandCidr("10.0.0.0/16")).toBeNull();
    expect(expandCidr("999.0.0.0/24")).toBeNull();
    expect(expandCidr("10.0.0.0/24; reboot")).toBeNull();
    expect(expandCidr("10.0.0.0")).toBeNull();
  });
});

describe("parsers", () => {
  it("reads ip neigh and skips failed entries", () => {
    const found = parseIpNeigh(
      [
        "192.168.1.2 dev eth0 lladdr 38:05:25:34:3C:C1 REACHABLE",
        "192.168.1.9 dev eth0  FAILED",
        "fe80::1 dev eth0 lladdr 00:11:22:33:44:55 router STALE",
      ].join("\n"),
    );
    expect(found).toEqual([
      expect.objectContaining({
        ip: "192.168.1.2",
        mac: "38:05:25:34:3c:c1",
      }),
    ]);
  });

  it("reads /proc/net/arp and skips unresolved entries", () => {
    const found = parseProcArp(
      [
        "IP address       HW type     Flags       HW address            Mask     Device",
        "192.168.1.2      0x1         0x2         38:05:25:34:3c:c1     *        eth0",
        "192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0",
      ].join("\n"),
    );
    expect(found.map((entry) => entry.ip)).toEqual(["192.168.1.2"]);
  });

  it("reads nmap output with vendors and names", () => {
    const found = parseNmap(
      [
        "Nmap scan report for zeus.lan (192.168.1.2)",
        "Host is up (0.00030s latency).",
        "MAC Address: 38:05:25:34:3C:C1 (Super Micro Computer)",
        "Nmap scan report for 192.168.1.3",
        "MAC Address: D8:43:AE:BC:03:97 (Unknown)",
      ].join("\n"),
    );
    expect(found).toEqual([
      {
        ip: "192.168.1.2",
        mac: "38:05:25:34:3c:c1",
        name: "zeus.lan",
        vendor: "Super Micro Computer",
      },
      { ip: "192.168.1.3", mac: "d8:43:ae:bc:03:97", name: "", vendor: "" },
    ]);
  });

  it("merges nmap, the neighbour table and names", () => {
    const found = parseRelayOutput(
      [
        "@NMAP",
        "Nmap scan report for 192.168.1.5",
        "Host is up.",
        "@NEIGH",
        "192.168.1.5 dev eth0 lladdr aa:bb:cc:dd:ee:ff STALE",
        "192.168.1.4 dev eth0 lladdr 11:22:33:44:55:66 STALE",
        "@NAME 192.168.1.5 nas.lan",
      ].join("\n"),
    );
    expect(found.map((entry) => entry.ip)).toEqual([
      "192.168.1.4",
      "192.168.1.5",
    ]);
    expect(found[1]).toMatchObject({
      mac: "aa:bb:cc:dd:ee:ff",
      name: "nas.lan",
    });
  });
});

describe("matchHost", () => {
  const found = { ip: "192.168.1.2", mac: "", name: "", vendor: "" };

  it("finds Zeus by MAC even though its address is Tailscale", () => {
    expect(
      matchHost({ ...found, mac: "38-05-25-34-3c-c1" }, [ZEUS]),
    ).toMatchObject({ hostId: 1, by: "mac" });
  });

  it("finds it by name when it has no MAC yet", () => {
    expect(
      matchHost({ ...found, mac: "aa:aa:aa:aa:aa:aa", name: "zeus.lan" }, [
        { ...ZEUS, mac: "" },
      ]),
    ).toMatchObject({ hostId: 1, by: "name", hasMac: false });
  });

  it("finds it by a saved LAN IP", () => {
    expect(matchHost(found, [{ ...ZEUS, lanIp: "192.168.1.2" }])).toMatchObject(
      { by: "ip" },
    );
  });

  it("answers null for a new machine", () => {
    expect(matchHost(found, [ZEUS])).toBeNull();
  });
});

describe("relayScanScript", () => {
  it("quotes the range and leaves virtual networks out", () => {
    expect(relayScanScript("192.168.1.0/24")).toContain(
      "targets='192.168.1.0/24'",
    );
    expect(relayScanScript(null)).toContain("docker");
    expect(relayScanScript(null)).toContain("tailscale");
  });

  it("keeps a blank range to private networks", () => {
    expect(relayScanScript(null)).toContain("192[.]168");
  });
});
