import dgram from "dgram";
import { isIPv4 } from "net";

const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

function parseMac(mac: string): Buffer {
  return Buffer.from(mac.replace(/[:-]/g, ""), "hex");
}

export function buildMagicPacket(mac: string): Buffer {
  const macBytes = parseMac(mac);
  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBytes.copy(packet, 6 + i * 6);
  }
  return packet;
}

export function isValidMac(mac: string): boolean {
  return MAC_REGEX.test(mac);
}

export function isValidBroadcastAddress(address: string): boolean {
  return isIPv4(address);
}

export function sendMagicPacket(
  mac: string,
  broadcastAddress = "255.255.255.255",
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isValidMac(mac)) {
      return reject(new Error("Invalid MAC address"));
    }
    if (!isValidBroadcastAddress(broadcastAddress)) {
      return reject(new Error("Invalid broadcast address"));
    }

    const packet = buildMagicPacket(mac);
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
      socket.send(packet, 0, packet.length, 9, broadcastAddress, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}
