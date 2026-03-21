import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { WalEngine } from "./wal.js";
import { createServer } from "./http.js";
import { SessionStore } from "./sessions.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "http-test-"));
}

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${port}`);
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode!, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.setHeader("Content-Type", "application/json");
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function sseRequest(
  port: number,
  urlPath: string,
  maxEvents: number,
  timeoutMs = 2000,
): Promise<Array<{ event: string; data: any }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: any }> = [];
    const url = new URL(urlPath, `http://127.0.0.1:${port}`);
    const req = http.request(url, { method: "GET" }, (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        // parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!; // keep incomplete part
        for (const part of parts) {
          if (part.startsWith(":")) continue; // comment/keepalive
          const lines = part.split("\n");
          let event = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (event) {
            try {
              events.push({ event, data: JSON.parse(data) });
            } catch {
              events.push({ event, data });
            }
          }
          if (events.length >= maxEvents) {
            req.destroy();
            resolve(events);
            return;
          }
        }
      });
      res.on("end", () => resolve(events));
    });
    req.on("error", (err) => {
      if ((err as any).code === "ECONNRESET") resolve(events);
      else reject(err);
    });
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

describe("HTTP server", () => {
  let dataDir: string;
  let wal: WalEngine;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    dataDir = tmpDir();
    wal = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 100 });
    await wal.init();
    server = createServer(wal, new SessionStore(dataDir));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wal.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe("GET /health", () => {
    it("returns ok", async () => {
      const res = await request(port, "GET", "/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("includes CORS headers", async () => {
      const res = await request(port, "GET", "/health");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("OPTIONS preflight", () => {
    it("returns 204 with CORS headers", async () => {
      const res = await request(port, "OPTIONS", "/ingest");
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
    });
  });

  describe("POST /ingest", () => {
    it("ingests a single entry", async () => {
      const res = await request(port, "POST", "/ingest", { channel: "speed", value: 142.5 });
      expect(res.status).toBe(200);
      expect(res.body.seq).toBeGreaterThan(0);
    });

    it("ingests a batch", async () => {
      const res = await request(port, "POST", "/ingest", [
        { channel: "rpm", value: 8200 },
        { channel: "speed", value: 145.1 },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      // Batch entries share the same seq
      expect(res.body.seq_start).toBe(res.body.seq_end);
    });

    it("rejects missing channel", async () => {
      const res = await request(port, "POST", "/ingest", { value: 123 });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request(
          new URL("/ingest", `http://127.0.0.1:${port}`),
          { method: "POST" },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () =>
              resolve({
                status: r.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              }),
            );
          },
        );
        req.on("error", reject);
        req.setHeader("Content-Type", "application/json");
        req.write("not json at all");
        req.end();
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid json");
    });

    it("accepts custom timestamp", async () => {
      const res = await request(port, "POST", "/ingest", {
        channel: "speed",
        value: 100,
        ts: 9999999,
      });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /channels", () => {
    it("returns list of known channels", async () => {
      const res = await request(port, "GET", "/channels");
      expect(res.status).toBe(200);
      expect(res.body.channels).toContain("speed");
      expect(res.body.channels).toContain("rpm");
    });
  });

  describe("GET /stats", () => {
    it("returns seq, entries, channel counts, generation", async () => {
      const res = await request(port, "GET", "/stats");
      expect(res.status).toBe(200);
      expect(typeof res.body.seq).toBe("number");
      expect(typeof res.body.total_entries).toBe("number");
      expect(typeof res.body.channels).toBe("object");
      expect(typeof res.body.generation).toBe("number");
    });
  });

  describe("GET /query", () => {
    it("queries entries by channel", async () => {
      const res = await request(port, "GET", "/query?channel=speed");
      expect(res.status).toBe(200);
      expect(res.body.entries.length).toBeGreaterThan(0);
      expect(res.body.entries.every((e: any) => e.channel === "speed")).toBe(true);
    });

    it("requires channel param", async () => {
      const res = await request(port, "GET", "/query");
      expect(res.status).toBe(400);
    });

    it("respects limit", async () => {
      const res = await request(port, "GET", "/query?channel=speed&limit=1");
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
    });

    it("filters by after_seq", async () => {
      const stats = await request(port, "GET", "/stats");
      const currentSeq = stats.body.seq;

      // ingest one more
      await request(port, "POST", "/ingest", { channel: "speed", value: 999 });

      const res = await request(port, "GET", `/query?channel=speed&after_seq=${currentSeq}`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].value).toBe(999);
    });
  });

  describe("GET /stream (SSE)", () => {
    it("replays history and sends caught_up", async () => {
      const events = await sseRequest(port, "/stream?channels=speed&after_seq=0", 50);

      const caughtUp = events.find((e) => e.event === "caught_up");
      expect(caughtUp).toBeDefined();

      const entries = events.filter((e) => e.event === "entry");
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.data.channel === "speed")).toBe(true);

      // caught_up should come after entries
      const caughtUpIdx = events.indexOf(caughtUp!);
      const lastEntryIdx = events.lastIndexOf(entries[entries.length - 1]);
      expect(caughtUpIdx).toBeGreaterThan(lastEntryIdx);
    });

    it("skips history with history=false", async () => {
      const events = await sseRequest(port, "/stream?history=false", 5);

      // first event should be caught_up, no entry events before it
      expect(events[0].event).toBe("caught_up");
    });

    it("receives live events after caught_up", async () => {
      // start SSE, then ingest in background
      const eventPromise = sseRequest(port, "/stream?channels=live_test&history=false", 3, 2000);

      // small delay to let SSE connect
      await new Promise((r) => setTimeout(r, 50));

      await request(port, "POST", "/ingest", { channel: "live_test", value: "hello" });
      await request(port, "POST", "/ingest", { channel: "live_test", value: "world" });

      const events = await eventPromise;

      expect(events[0].event).toBe("caught_up");
      const liveEntries = events.filter((e) => e.event === "entry");
      expect(liveEntries.length).toBeGreaterThanOrEqual(1);
      expect(liveEntries[0].data.channel).toBe("live_test");
    });

    it("filters by channel", async () => {
      await request(port, "POST", "/ingest", { channel: "filter_a", value: 1 });
      await request(port, "POST", "/ingest", { channel: "filter_b", value: 2 });

      const events = await sseRequest(port, "/stream?channels=filter_a&after_seq=0", 10);
      const entries = events.filter((e) => e.event === "entry");
      expect(entries.every((e) => e.data.channel === "filter_a")).toBe(true);
    });
  });

  describe("404", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await request(port, "GET", "/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});
