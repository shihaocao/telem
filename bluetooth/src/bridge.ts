import { createBluetooth } from "node-ble";

const MAC = process.env.RACEBOX_MAC ?? "F0:3A:C0:59:48:B7";
const INGEST_URL = process.env.INGEST_URL ?? "http://localhost:4400/ingest";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// UBX framing
const SYNC_1 = 0xb5;
const SYNC_2 = 0x62;
const MSG_CLASS = 0xff;
const MSG_ID = 0x01;
const HEADER_LEN = 6;
const PAYLOAD_LEN = 80;
const PACKET_LEN = HEADER_LEN + PAYLOAD_LEN + 2; // 88

function log(msg: string): void {
  console.log(`[bridge] ${new Date().toISOString()} ${msg}`);
}

// fletcher-8 checksum over class, id, length, payload
function checksum(cls: number, id: number, payload: Buffer): [number, number] {
  let a = 0;
  let b = 0;
  a = (a + cls) & 0xff;
  b = (b + a) & 0xff;
  a = (a + id) & 0xff;
  b = (b + a) & 0xff;
  a = (a + (payload.length & 0xff)) & 0xff;
  b = (b + a) & 0xff;
  a = (a + (payload.length >> 8)) & 0xff;
  b = (b + a) & 0xff;
  for (let i = 0; i < payload.length; i++) {
    a = (a + payload[i]) & 0xff;
    b = (b + a) & 0xff;
  }
  return [a, b];
}

function parsePayload(p: Buffer): Array<{ channel: string; value: number; ts: number }> {
  const ts = Date.now();
  const lon = p.readInt32LE(24) * 1e-7;
  const lat = p.readInt32LE(28) * 1e-7;
  const altitudeMsl = p.readInt32LE(36) / 1000; // mm → m
  const groundSpeed = (p.readInt32LE(48) / 1000) * 3.6; // mm/s → km/h
  const heading = p.readInt32LE(52) * 1e-5; // deg
  const satellites = p.readUInt8(23);
  const fixType = p.readUInt8(20);
  const gX = p.readInt16LE(68) / 1000; // milli-g → g
  const gY = p.readInt16LE(70) / 1000;
  const gZ = p.readInt16LE(72) / 1000;
  const gyroX = p.readInt16LE(74) / 100; // centi-deg/s → deg/s
  const gyroY = p.readInt16LE(76) / 100;
  const gyroZ = p.readInt16LE(78) / 100;
  const battery = p.readUInt8(67);

  return [
    { channel: "gps_lat", value: Math.round(lat * 1e7) / 1e7, ts },
    { channel: "gps_lon", value: Math.round(lon * 1e7) / 1e7, ts },
    { channel: "gps_speed", value: Math.round(groundSpeed * 10) / 10, ts },
    { channel: "gps_heading", value: Math.round(heading * 10) / 10, ts },
    { channel: "gps_altitude", value: Math.round(altitudeMsl * 10) / 10, ts },
    { channel: "gps_satellites", value: satellites, ts },
    { channel: "gps_fix", value: fixType, ts },
    { channel: "g_force_x", value: Math.round(gX * 1000) / 1000, ts },
    { channel: "g_force_y", value: Math.round(gY * 1000) / 1000, ts },
    { channel: "g_force_z", value: Math.round(gZ * 1000) / 1000, ts },
    { channel: "gyro_x", value: Math.round(gyroX * 10) / 10, ts },
    { channel: "gyro_y", value: Math.round(gyroY * 10) / 10, ts },
    { channel: "gyro_z", value: Math.round(gyroZ * 10) / 10, ts },
    { channel: "racebox_battery", value: battery, ts },
  ];
}

// packet reassembly buffer (BLE notifications may split packets)
let buf = Buffer.alloc(0);
let lastPacketTime = Date.now();
let packetCount = 0;

function onData(chunk: Buffer): void {
  buf = Buffer.concat([buf, chunk]);

  while (buf.length >= PACKET_LEN) {
    // scan for sync
    let syncIdx = -1;
    for (let i = 0; i <= buf.length - 2; i++) {
      if (buf[i] === SYNC_1 && buf[i + 1] === SYNC_2) {
        syncIdx = i;
        break;
      }
    }

    if (syncIdx === -1) {
      buf = Buffer.alloc(0);
      return;
    }
    if (syncIdx > 0) {
      buf = buf.subarray(syncIdx);
    }
    if (buf.length < PACKET_LEN) return;

    // validate class/id
    if (buf[2] !== MSG_CLASS || buf[3] !== MSG_ID) {
      buf = buf.subarray(1);
      continue;
    }

    const payload = buf.subarray(HEADER_LEN, HEADER_LEN + PAYLOAD_LEN);
    const [ckA, ckB] = checksum(MSG_CLASS, MSG_ID, payload);
    if (buf[HEADER_LEN + PAYLOAD_LEN] !== ckA || buf[HEADER_LEN + PAYLOAD_LEN + 1] !== ckB) {
      log("checksum mismatch, skipping");
      buf = buf.subarray(1);
      continue;
    }

    const entries = parsePayload(payload);
    ingest(entries);
    lastPacketTime = Date.now();
    packetCount++;

    buf = buf.subarray(PACKET_LEN);
  }
}

async function ingest(
  entries: Array<{ channel: string; value: number; ts: number }>,
): Promise<void> {
  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entries),
    });
    if (!res.ok) {
      log(`ingest error: ${res.status}`);
    }
  } catch (err) {
    log(`ingest failed: ${err}`);
  }
}

async function main(): Promise<void> {
  const { bluetooth, destroy } = createBluetooth();

  // watchdog: exit if no packets for 30s (systemd will restart)
  const watchdog = setInterval(() => {
    if (Date.now() - lastPacketTime > 30_000 && packetCount > 0) {
      log("no packets for 30s, exiting for restart");
      destroy();
      process.exit(1);
    }
  }, 10_000);

  // rate logging
  let lastLogCount = 0;
  const rateLog = setInterval(() => {
    if (packetCount > 0) {
      const delta = packetCount - lastLogCount;
      log(`${delta} packets in last 10s (${packetCount} total)`);
      lastLogCount = packetCount;
    }
  }, 10_000);

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  function shutdown(): void {
    log("shutting down");
    clearInterval(watchdog);
    clearInterval(rateLog);
    destroy();
    process.exit(0);
  }

  try {
    const adapter = await bluetooth.defaultAdapter();
    log("adapter ready");

    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery();
    }

    log(`waiting for ${MAC}...`);
    const device = await adapter.waitDevice(MAC);
    log("device found");

    if (!(await device.isConnected())) {
      log("connecting...");
      await device.connect();
    }
    log("connected");

    const gatt = await device.gatt();
    const service = await gatt.getPrimaryService(NUS_SERVICE);
    const txChar = await service.getCharacteristic(NUS_TX);

    await txChar.startNotifications();
    log("subscribed to NUS TX, streaming data");

    lastPacketTime = Date.now();
    txChar.on("valuechanged", (b: Buffer) => onData(b));

    // block until disconnect or error
    await new Promise<void>(() => {});
  } catch (err) {
    log(`fatal: ${err}`);
    destroy();
    process.exit(1);
  }
}

main();
