import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { WalEngine, WalEntry } from "./wal.js";
import { SessionStore, type Lap } from "./sessions.js";
import { LapDetector, type LapEvent } from "./lap-detector.js";

function cors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function createServer(wal: WalEngine, sessions: SessionStore, lapDetector?: LapDetector, tracksDir?: string): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Session SSE stream: /sessions/:id/stream
      const streamMatch = pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)\/stream$/);
      if (streamMatch && req.method === "GET" && lapDetector) {
        handleSessionStream(req, res, sessions, lapDetector, streamMatch[1]);
        return;
      }

      // Session routes: /sessions and /sessions/:id
      const sessionMatch = pathname.match(/^\/sessions(?:\/([a-zA-Z0-9_-]+))?$/);
      if (sessionMatch) {
        await handleSessions(req, res, url, wal, sessions, sessionMatch[1] ?? null);
        return;
      }

      // Guard WAL-dependent routes during compaction
      const walRoutes = ["/ingest", "/stream", "/wal/range", "/nuke"];
      if (wal.compacting && walRoutes.some((r) => pathname === r || pathname.startsWith(r))) {
        json(res, 503, { error: "compaction in progress, retry shortly" });
        return;
      }

      if (req.method === "POST" && pathname === "/ingest") {
        await handleIngest(req, res, wal);
      } else if (req.method === "GET" && pathname === "/stream") {
        handleStream(url, req, res, wal);
      } else if (req.method === "GET" && pathname === "/wal/range") {
        await handleWalRange(url, res, wal);
      } else if (req.method === "GET" && pathname === "/stats") {
        json(res, 200, {
          seq: wal.currentSeq,
          total_entries: wal.totalEntries,
          channels: wal.getChannelCounts(),
          generation: wal.currentGeneration,
        });
      } else if (req.method === "GET" && pathname === "/cam/exposure") {
        json(res, 200, handleCamGetExposure());
      } else if (req.method === "POST" && pathname === "/cam/exposure/up") {
        json(res, 200, handleCamAdjustExposure(1));
      } else if (req.method === "POST" && pathname === "/cam/exposure/down") {
        json(res, 200, handleCamAdjustExposure(-1));
      } else if (req.method === "GET" && pathname === "/services") {
        json(res, 200, handleServicesStatus());
      } else if (req.method === "GET" && pathname.startsWith("/services/") && pathname.endsWith("/logs")) {
        const svc = pathname.split("/")[2];
        json(res, 200, handleServiceLogs(svc));
      } else if (req.method === "POST" && pathname.startsWith("/services/") && pathname.endsWith("/restart")) {
        const svc = pathname.split("/")[2];
        const raw = await readBody(req);
        let body: any = {};
        try { body = JSON.parse(raw); } catch {}
        json(res, 200, handleServiceRestart(svc, body.password));
      } else if (req.method === "POST" && pathname === "/compact") {
        const result = await wal.compact();
        json(res, 200, result);
      } else if (req.method === "POST" && pathname === "/nuke") {
        await wal.nuke();
        json(res, 200, { ok: true });
      } else if (req.method === "GET" && pathname === "/health") {
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "internal error";
      json(res, 500, { error: msg });
    }
  });

  return server;
}

async function handleIngest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  wal: WalEngine,
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: "invalid json" });
    return;
  }

  const items: Array<{ channel: string; value: unknown; ts?: number }> = Array.isArray(body) ? body : [body];
  for (const item of items) {
    if (!item || !item.channel) {
      json(res, 400, { error: "each item must have a channel" });
      return;
    }
  }
  const entries = wal.append(...items);
  json(res, 200, { seq: entries[0].seq, count: entries.length });
}

function handleStream(url: URL, req: http.IncomingMessage, res: http.ServerResponse, wal: WalEngine): void {
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const channelsParam = url.searchParams.get("channels");
  const channelFilter = channelsParam ? new Set(channelsParam.split(",")) : null;

  function sendEvent(name: string, data: unknown): void {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // live tail
  const onEntry = (entry: WalEntry): void => {
    if (channelFilter && !channelFilter.has(entry.channel)) return;
    sendEvent("entry", entry);
  };

  wal.on("entry", onEntry);

  // keepalive every 15s
  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  // cleanup on disconnect
  const cleanup = (): void => {
    wal.off("entry", onEntry);
    clearInterval(keepalive);
  };

  req?.socket?.on("close", cleanup);
  res.on("close", cleanup);
}

async function handleWalRange(url: URL, res: http.ServerResponse, wal: WalEngine): Promise<void> {
  const startSeq = parseInt(url.searchParams.get("start_seq") ?? "", 10);
  const endSeq = parseInt(url.searchParams.get("end_seq") ?? "", 10);
  if (isNaN(startSeq) || isNaN(endSeq)) {
    json(res, 400, { error: "start_seq and end_seq are required" });
    return;
  }
  // Stream NDJSON — pipes raw WAL lines directly, zero serialization
  cors(res);
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  await wal.streamTicksInRange(startSeq, endSeq, (line) => {
    res.write(line);
    res.write("\n");
  });
  res.end();
}

// --- Session SSE stream ---

function handleSessionStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SessionStore,
  detector: LapDetector,
  sessionId: string,
): void {
  const session = store.get(sessionId);
  if (!session) {
    json(res, 404, { error: "session not found" });
    return;
  }

  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function sendEvent(name: string, data: unknown): void {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // send current state immediately
  sendEvent("session", store.get(sessionId));

  // forward lap events for this session
  const onLap = (e: LapEvent): void => {
    if (e.sessionId === sessionId) {
      sendEvent("lap", e.lap);
      sendEvent("session", e.session);
    }
  };
  detector.on("lap", onLap);

  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  const cleanup = (): void => {
    detector.off("lap", onLap);
    clearInterval(keepalive);
  };
  req?.socket?.on("close", cleanup);
  res.on("close", cleanup);
}

// --- Session CRUD ---

async function handleSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  wal: WalEngine,
  store: SessionStore,
  id: string | null,
): Promise<void> {
  if (!id) {
    // /sessions
    if (req.method === "GET") {
      const track = url.searchParams.get("track") ?? undefined;
      json(res, 200, store.list(track));
    } else if (req.method === "POST") {
      const raw = await readBody(req);
      let body: any;
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: "invalid json" }); return; }
      if (!body.track) { json(res, 400, { error: "track is required" }); return; }
      json(res, 201, store.create(body.track, wal.currentSeq, body.driver));
    } else {
      json(res, 405, { error: "method not allowed" });
    }
  } else {
    // /sessions/:id
    if (req.method === "GET") {
      const session = store.get(id);
      if (!session) { json(res, 404, { error: "session not found" }); return; }
      json(res, 200, session);
    } else if (req.method === "PATCH") {
      const raw = await readBody(req);
      let body: any;
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: "invalid json" }); return; }

      // When stopping a session, record the in-progress lap as "in" lap
      if (body.running === false) {
        const current = store.get(id);
        if (current?.running) {
          const now = Date.now();
          const elapsed = now - current.lapStartTs;
          if (elapsed > 5000) {
            // Record the incomplete lap as an in-lap
            const inLap: Lap = {
              lap: current.laps.length + 1,
              time: elapsed,
              flag: "in",
              track: current.track,
              startSeq: current.lapStartSeq,
              endSeq: wal.currentSeq,
            };
            current.laps.push(inLap);
          }
          body.laps = current.laps;
        }
      }

      const session = store.update(id, body);
      if (!session) { json(res, 404, { error: "session not found" }); return; }
      json(res, 200, session);
    } else if (req.method === "DELETE") {
      if (!store.delete(id)) { json(res, 404, { error: "session not found" }); return; }
      json(res, 200, { ok: true });
    } else {
      json(res, 405, { error: "method not allowed" });
    }
  }
}

// --- Systemctl service management ---

const MANAGED_SERVICES = [
  "racebox-connect",
  "telem-server",
  "racebox-bridge",
  "serial-bridge",
  "video-streaming",
];

function handleServicesStatus(): Record<string, unknown>[] {
  return MANAGED_SERVICES.map((svc) => {
    try {
      const raw = execSync(`systemctl is-active ${svc} 2>/dev/null`, { encoding: "utf-8" }).trim();
      return { name: svc, status: raw };
    } catch {
      return { name: svc, status: "unknown" };
    }
  });
}

function handleServiceLogs(svc: string): Record<string, unknown> {
  if (!MANAGED_SERVICES.includes(svc)) return { error: "unknown service" };
  try {
    const logs = execSync(`journalctl -u ${svc} -n 50 --no-pager --output=short-iso 2>/dev/null`, { encoding: "utf-8" });
    return { name: svc, logs };
  } catch (err: any) {
    return { name: svc, logs: "", error: err.message };
  }
}

function handleServiceRestart(svc: string, password?: string): Record<string, unknown> {
  if (!MANAGED_SERVICES.includes(svc)) return { error: "unknown service" };
  try {
    if (password) {
      execSync(`echo ${JSON.stringify(password)} | sudo -S systemctl restart ${svc} 2>&1`, { encoding: "utf-8" });
    } else {
      execSync(`sudo systemctl restart ${svc} 2>&1`, { encoding: "utf-8" });
    }
    return { name: svc, ok: true };
  } catch (err: any) {
    return { name: svc, ok: false, error: err.message };
  }
}

// --- Camera controls (v4l2-ctl) ---

let camDevice: string | null = null;

function findCamDevice(): string | null {
  if (camDevice) return camDevice;
  try {
    const devs = execSync("ls /dev/video* 2>/dev/null", { encoding: "utf-8" }).trim().split("\n");
    for (const dev of devs) {
      try {
        const info = execSync(`v4l2-ctl -d ${dev} --all 2>/dev/null`, { encoding: "utf-8" });
        if (info.includes("C930e")) {
          camDevice = dev;
          return dev;
        }
      } catch {}
    }
  } catch {}
  return null;
}

function getCamCtrl(dev: string, ctrl: string): number {
  const out = execSync(`v4l2-ctl -d ${dev} --get-ctrl=${ctrl}`, { encoding: "utf-8" });
  return parseInt(out.replace(/.*:\s*/, ""), 10);
}

function handleCamGetExposure(): Record<string, unknown> {
  const dev = findCamDevice();
  if (!dev) return { error: "camera not found" };
  try {
    return {
      exposure_auto: getCamCtrl(dev, "exposure_auto"),
      exposure_absolute: getCamCtrl(dev, "exposure_absolute"),
      gain: getCamCtrl(dev, "gain"),
      brightness: getCamCtrl(dev, "brightness"),
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

// Exposure steps: raise/lower exposure_absolute and gain together
// exposure_absolute: 3–2047, gain: 0–255
const EXPOSURE_STEPS = [3, 5, 10, 20, 40, 80, 150, 250, 500, 1000, 2047];
const GAIN_STEPS = [0, 32, 64, 96, 128, 160, 192, 224, 255];

function stepValue(steps: number[], current: number, dir: number): number {
  let closest = 0;
  let minDist = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const d = Math.abs(steps[i] - current);
    if (d < minDist) { minDist = d; closest = i; }
  }
  const next = Math.max(0, Math.min(steps.length - 1, closest + dir));
  return steps[next];
}

function handleCamAdjustExposure(dir: number): Record<string, unknown> {
  const dev = findCamDevice();
  if (!dev) return { error: "camera not found" };
  try {
    const curExp = getCamCtrl(dev, "exposure_absolute");
    const curGain = getCamCtrl(dev, "gain");

    const newExp = stepValue(EXPOSURE_STEPS, curExp, dir);
    const newGain = stepValue(GAIN_STEPS, curGain, dir);

    execSync(`v4l2-ctl -d ${dev} --set-ctrl=exposure_absolute=${newExp}`);
    execSync(`v4l2-ctl -d ${dev} --set-ctrl=gain=${newGain}`);

    return { exposure_absolute: newExp, gain: newGain };
  } catch (err: any) {
    return { error: err.message };
  }
}
