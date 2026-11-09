import dgram from "dgram";
import { isIPv4 } from "net";

const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const DEFAULT_BROADCAST = "255.255.255.255";

function parseMac(mac: string): Buffer {
  return Buffer.from(mac.replace(/[:-]/g, ""), "hex");
}

/**
 * SecureON password bytes. Six hex pairs like a MAC are read as bytes, anything
 * else of 4 or 6 characters as text. Null when it is not a valid password.
 */
export function parseSecureOn(password: string): Buffer | null {
  if (password === "") return Buffer.alloc(0);
  if (MAC_REGEX.test(password)) return parseMac(password);
  const bytes = Buffer.from(password, "utf8");
  return bytes.length === 4 || bytes.length === 6 ? bytes : null;
}

export function buildMagicPacket(mac: string, password = ""): Buffer {
  const macBytes = parseMac(mac);
  const secureOn = parseSecureOn(password) ?? Buffer.alloc(0);
  const packet = Buffer.alloc(102 + secureOn.length);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBytes.copy(packet, 6 + i * 6);
  }
  secureOn.copy(packet, 102);
  return packet;
}

export function isValidMac(mac: string): boolean {
  return MAC_REGEX.test(mac);
}

export function isValidBroadcastAddress(address: string): boolean {
  return isIPv4(address);
}

function octets(ip: string): number[] {
  return ip.split(".").map(Number);
}

/** A subnet's broadcast address, or null without a valid ip and mask. */
export function broadcastFor(ip: string, netmask: string): string | null {
  if (!isIPv4(ip) || !isIPv4(netmask)) return null;
  const mask = octets(netmask);
  return octets(ip)
    .map((octet, i) => (octet | (~mask[i]! & 255)) & 255)
    .join(".");
}

export interface MagicPacketOptions {
  port?: number;
  password?: string;
}

export function sendMagicPacket(
  mac: string,
  broadcastAddress = DEFAULT_BROADCAST,
  options: MagicPacketOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isValidMac(mac)) {
      return reject(new Error("Invalid MAC address"));
    }
    if (!isValidBroadcastAddress(broadcastAddress)) {
      return reject(new Error("Invalid broadcast address"));
    }

    const packet = buildMagicPacket(mac, options.password);
    const socket = dgram.createSocket("udp4");

    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        socket.close();
        return reject(err);
      }
      socket.send(
        packet,
        0,
        packet.length,
        options.port ?? 9,
        broadcastAddress,
        (err) => {
          socket.close();
          if (err) reject(err);
          else resolve();
        },
      );
    });
  });
}
