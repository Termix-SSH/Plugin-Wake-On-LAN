import { promises as fs } from "fs";
import net from "net";
import type { ScanMatch, ScanResult } from "../shared/types.js";

/** Biggest range one scan may cover, a /22. */
export const MAX_SCAN_ADDRESSES = 1024;
const SWEEP_CONCURRENCY = 64;
const SWEEP_TIMEOUT_MS = 400;

const MAC_RE = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i;
const IPV4_RE = /(?:\d{1,3}\.){3}\d{1,3}/;

export interface Found {
  ip: string;
  mac: string;
  name: string;
  vendor: string;
}

function ipToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}

/** Host addresses in a CIDR, or null when it is invalid or too wide. */
export function expandCidr(cidr: string): string[] | null {
  const match = /^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!match || !net.isIPv4(match[1]!)) return null;
  const bits = Number(match[2]);
  if (bits > 32) return null;
  const size = 2 ** (32 - bits);
  if (size > MAX_SCAN_ADDRESSES) return null;
  const start = ipToInt(match[1]!) - (ipToInt(match[1]!) % size);
  if (size <= 2) {
    return Array.from({ length: size }, (_, i) => intToIp(start + i));
  }
  return Array.from({ length: size - 2 }, (_, i) => intToIp(start + 1 + i));
}

/** `ip neigh` lines: `192.168.1.2 dev eth0 lladdr aa:.. REACHABLE`. */
export function parseIpNeigh(text: string): Found[] {
  const found: Found[] = [];
  for (const line of text.split("\n")) {
    if (/FAILED|INCOMPLETE/.test(line)) continue;
    const ip = IPV4_RE.exec(line)?.[0];
    const mac = /lladdr\s+(\S+)/.exec(line)?.[1];
    if (ip && mac && MAC_RE.test(mac)) {
      found.push({ ip, mac: mac.toLowerCase(), name: "", vendor: "" });
    }
  }
  return found;
}

/** /proc/net/arp. Flags 0x0 is an entry that never resolved. */
export function parseProcArp(text: string): Found[] {
  const found: Found[] = [];
  for (const line of text.split("\n").slice(1)) {
    const [ip, , flags, mac] = line.trim().split(/\s+/);
    if (!ip || !mac || flags === "0x0") continue;
    if (mac === "00:00:00:00:00:00") continue;
    found.push({ ip, mac: mac.toLowerCase(), name: "", vendor: "" });
  }
  return found;
}

/** `nmap -sn` normal output. */
export function parseNmap(text: string): Found[] {
  const found: Found[] = [];
  let current: Found | null = null;
  for (const line of text.split("\n")) {
    const report = /^Nmap scan report for (.+)$/.exec(line.trim());
    if (report) {
      const named = /^(.+) \(([\d.]+)\)$/.exec(report[1]!);
      current = {
        ip: named ? named[2]! : report[1]!,
        mac: "",
        name: named ? named[1]! : "",
        vendor: "",
      };
      found.push(current);
      continue;
    }
    const mac = /^MAC Address: (\S+)(?: \((.*)\))?$/.exec(line.trim());
    if (mac && current) {
      current.mac = mac[1]!.toLowerCase();
      current.vendor = mac[2] === "Unknown" ? "" : (mac[2] ?? "");
    }
  }
  return found;
}

/** The output of relayScanScript: `@NMAP`, `@NEIGH` and `@NAME ip name` blocks. */
export function parseRelayOutput(text: string): Found[] {
  const [, afterNmap = ""] = text.split("@NMAP\n");
  const [nmapText = "", afterNeigh = ""] = afterNmap.split("@NEIGH\n");
  const neighText = afterNeigh.split("@NAME")[0] ?? "";
  const byIp = new Map<string, Found>();
  for (const entry of parseNmap(nmapText)) byIp.set(entry.ip, entry);
  for (const entry of parseIpNeigh(neighText)) {
    const known = byIp.get(entry.ip);
    if (!known) byIp.set(entry.ip, entry);
    else if (!known.mac) known.mac = entry.mac;
  }
  for (const line of text.split("\n")) {
    const named = /^@NAME (\S+) (\S+)$/.exec(line.trim());
    const entry = named && byIp.get(named[1]!);
    if (entry && !entry.name) entry.name = named[2]!;
  }
  return [...byIp.values()].sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

/**
 * Runs on a relay. nmap when it exists (with sudo when allowed, since it only
 * sees MACs as root), else a ping sweep, then the neighbour table for MACs.
 * `cidr` is checked by expandCidr before it gets here. With none it only
 * covers private networks, so it never sweeps a provider's public range.
 */
export function relayScanScript(cidr: string | null): string {
  const target = cidr ? `'${cidr}'` : "";
  return `set +e
targets=${target}
devs=""
if [ -z "$targets" ]; then
  nets=$(ip -o -4 addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|tailscale|virbr|cni|flannel|wg)/ {print $2, $4}' | grep -E '/(2[2-9]|30)$' | grep -E ' (10|192[.]168|172[.](1[6-9]|2[0-9]|3[01]))[.]')
  targets=$(echo "$nets" | awk '{print $2}' | tr '\n' ' ')
  devs=$(echo "$nets" | awk '{print $1}' | tr '\n' ' ')
fi
if [ -z "$targets" ]; then echo "No local network found on this host" >&2; exit 3; fi
echo "@NMAP"
if command -v nmap >/dev/null 2>&1; then
  if [ "$(id -u)" = "0" ]; then nmap -sn $targets 2>/dev/null
  elif sudo -n true 2>/dev/null; then sudo -n nmap -sn $targets 2>/dev/null
  else nmap -sn $targets 2>/dev/null; fi
else
  for net in $targets; do
    base=\${net%/*}; prefix=\${base%.*}
    bits=\${net#*/}; hosts=$(( bits >= 24 ? 254 : 1016 ))
    i=0
    while [ "$i" -lt "$hosts" ]; do
      i=$((i + 1))
      if [ "$bits" -ge 24 ]; then ip="$prefix.$i"; else
        ip="\${prefix%.*}.$(( \${prefix##*.} + i / 256 )).$(( i % 256 ))"; fi
      echo "$ip"
    done
  done | xargs -P 64 -I{} ping -c 1 -W 1 {} >/dev/null 2>&1
fi
echo "@NEIGH"
if [ -n "$devs" ]; then
  neigh=$(for dev in $devs; do ip neigh show dev "$dev" 2>/dev/null; done)
else
  neigh=$(ip neigh show 2>/dev/null)
fi
echo "$neigh"
echo "$neigh" | grep lladdr | awk '{print $1}' | grep -E '^[0-9.]+$' | {
  while read -r ip; do
    (
      name=$(timeout 2 getent hosts "$ip" 2>/dev/null | awk '{print $2}' | head -1)
      [ -n "$name" ] && echo "@NAME $ip $name"
    ) &
  done
  wait
}
exit 0
`;
}

/**
 * From the server: a TCP connect makes the kernel ARP each address, whatever
 * the port answers. Then the table holds everything that replied. On Linux only.
 */
export async function serverScan(addresses: string[]): Promise<Found[]> {
  const queue = [...addresses];
  const touch = (ip: string) =>
    new Promise<void>((resolve) => {
      const socket = net.connect({ host: ip, port: 9, timeout: 300 });
      const done = () => {
        socket.destroy();
        resolve();
      };
      socket.once("connect", done);
      socket.once("error", done);
      socket.once("timeout", done);
      setTimeout(done, SWEEP_TIMEOUT_MS).unref();
    });
  await Promise.all(
    Array.from({ length: SWEEP_CONCURRENCY }, async () => {
      for (let ip = queue.shift(); ip; ip = queue.shift()) await touch(ip);
    }),
  );
  const table = await fs.readFile("/proc/net/arp", "utf8").catch(() => "");
  const wanted = new Set(addresses);
  return parseProcArp(table).filter((entry) => wanted.has(entry.ip));
}

export interface KnownHost {
  id: number;
  name: string;
  ip: string;
  mac: string;
  lanIp: string;
}

function shortName(name: string): string {
  return name.split(".")[0]!.toLowerCase();
}

/** The existing host a result belongs to: by MAC, then IP, then name. */
export function matchHost(found: Found, hosts: KnownHost[]): ScanMatch | null {
  const result = (host: KnownHost, by: ScanMatch["by"]): ScanMatch => ({
    hostId: host.id,
    name: host.name,
    by,
    hasMac: host.mac !== "",
  });
  const mac = found.mac.toLowerCase().replace(/-/g, ":");
  const byMac =
    mac && hosts.find((h) => h.mac.toLowerCase().replace(/-/g, ":") === mac);
  if (byMac) return result(byMac, "mac");
  const byIp = hosts.find((h) => h.lanIp === found.ip || h.ip === found.ip);
  if (byIp) return result(byIp, "ip");
  const wanted = found.name ? shortName(found.name) : "";
  const byName = wanted && hosts.find((h) => shortName(h.name) === wanted);
  return byName ? result(byName, "name") : null;
}

export function withMatches(found: Found[], hosts: KnownHost[]): ScanResult[] {
  return found.map((entry) => ({ ...entry, match: matchHost(entry, hosts) }));
}
