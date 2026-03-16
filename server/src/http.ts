import * as http from "node:http";
import { WalEngine, WalEntry } from "./wal.js";

function cors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

export function createServer(wal: WalEngine): http.Server {
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
      if (req.method === "POST" && pathname === "/ingest") {
        await handleIngest(req, res, wal);
      } else if (req.method === "GET" && pathname === "/stream") {
        handleStream(url, req, res, wal);
      } else if (req.method === "GET" && pathname === "/query") {
        handleQuery(url, res, wal);
      } else if (req.method === "GET" && pathname === "/channels") {
        json(res, 200, { channels: wal.getChannels() });
      } else if (req.method === "GET" && pathname === "/stats") {
        json(res, 200, {
          seq: wal.currentSeq,
          total_entries: wal.totalEntries,
          channels: wal.getChannelCounts(),
          generation: wal.currentGeneration,
        });
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

  if (Array.isArray(body)) {
    // batch ingest
    const items = body as Array<{ channel: string; value: unknown; ts?: number }>;
    for (const item of items) {
      if (!item.channel) {
        json(res, 400, { error: "each item must have a channel" });
        return;
      }
    }
    const entries = wal.appendBatch(items);
    json(res, 200, { seq_start: entries[0].seq, seq_end: entries[entries.length - 1].seq, count: entries.length });
  } else if (body && typeof body === "object") {
    const item = body as { channel: string; value: unknown; ts?: number };
    if (!item.channel) {
      json(res, 400, { error: "channel is required" });
      return;
    }
    const entry = wal.append(item.channel, item.value, item.ts);
    json(res, 200, { seq: entry.seq });
  } else {
    json(res, 400, { error: "expected object or array" });
  }
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
  const afterSeq = parseInt(url.searchParams.get("after_seq") ?? "0", 10) || 0;
  const skipHistory = url.searchParams.get("history") === "false";

  function sendEvent(name: string, data: unknown): void {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // replay historical entries
  if (!skipHistory && afterSeq >= 0) {
    const historical = wal.getEntriesAfterSeq(afterSeq, channelFilter ?? undefined);
    for (const entry of historical) {
      sendEvent("entry", entry);
    }
  }

  sendEvent("caught_up", { seq: wal.currentSeq });

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

function handleQuery(url: URL, res: http.ServerResponse, wal: WalEngine): void {
  const channel = url.searchParams.get("channel");
  if (!channel) {
    json(res, 400, { error: "channel param required" });
    return;
  }

  const startTs = url.searchParams.has("start_ts")
    ? parseInt(url.searchParams.get("start_ts")!, 10)
    : undefined;
  const endTs = url.searchParams.has("end_ts")
    ? parseInt(url.searchParams.get("end_ts")!, 10)
    : undefined;
  const afterSeq = url.searchParams.has("after_seq")
    ? parseInt(url.searchParams.get("after_seq")!, 10)
    : undefined;
  const limit = url.searchParams.has("limit")
    ? parseInt(url.searchParams.get("limit")!, 10)
    : 10_000;

  const entries = wal.queryByChannel(channel, { startTs, endTs, afterSeq, limit });
  json(res, 200, { entries, count: entries.length });
}
