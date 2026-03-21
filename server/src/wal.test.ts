import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WalEngine, WalEntry } from "./wal.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wal-test-"));
}

describe("WalEngine", () => {
  let dataDir: string;
  let wal: WalEngine;

  beforeEach(async () => {
    dataDir = tmpDir();
    wal = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
    await wal.init();
  });

  afterEach(() => {
    wal.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe("append", () => {
    it("assigns incrementing seq numbers", () => {
      const a = wal.append("speed", 100);
      const b = wal.append("speed", 200);
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
    });

    it("uses provided ts or defaults to now", () => {
      const a = wal.append("speed", 100, 1234567890);
      expect(a.ts).toBe(1234567890);

      const before = Date.now();
      const b = wal.append("speed", 200);
      expect(b.ts).toBeGreaterThanOrEqual(before);
      expect(b.ts).toBeLessThanOrEqual(Date.now());
    });

    it("stores value of any type", async () => {
      const a = wal.append("gps", { lat: 37.7, lon: -122.4 });
      const b = wal.append("flag", true);
      const c = wal.append("label", "pit-in");

      const entries = await wal.getEntriesAfterSeq(0);
      expect(entries[0].value).toEqual({ lat: 37.7, lon: -122.4 });
      expect(entries[1].value).toBe(true);
      expect(entries[2].value).toBe("pit-in");
    });

    it("emits entry event on append", () => {
      const received: WalEntry[] = [];
      wal.on("entry", (e: WalEntry) => received.push(e));

      wal.append("speed", 100);
      wal.append("rpm", 8000);

      expect(received).toHaveLength(2);
      expect(received[0].channel).toBe("speed");
      expect(received[1].channel).toBe("rpm");
    });

    it("updates currentSeq and totalEntries", () => {
      expect(wal.currentSeq).toBe(0);
      expect(wal.totalEntries).toBe(0);

      wal.append("speed", 1);
      wal.append("speed", 2);

      expect(wal.currentSeq).toBe(2);
      expect(wal.totalEntries).toBe(2);
    });
  });

  describe("appendBatch", () => {
    it("appends multiple entries with shared batch seq", () => {
      const entries = wal.appendBatch([
        { channel: "speed", value: 100 },
        { channel: "rpm", value: 8000 },
        { channel: "speed", value: 105 },
      ]);

      expect(entries).toHaveLength(3);
      // All entries in a batch share the same seq
      expect(entries[0].seq).toBe(1);
      expect(entries[1].seq).toBe(1);
      expect(entries[2].seq).toBe(1);
      expect(wal.currentSeq).toBe(1);
    });

    it("emits entry events for each item in batch", () => {
      const received: WalEntry[] = [];
      wal.on("entry", (e: WalEntry) => received.push(e));

      wal.appendBatch([
        { channel: "a", value: 1 },
        { channel: "b", value: 2 },
      ]);

      expect(received).toHaveLength(2);
    });
  });

  describe("WAL file persistence", () => {
    it("writes JSON lines to wal file", () => {
      wal.append("speed", 100);
      wal.append("rpm", 8000);
      wal.close();

      const walFile = path.join(dataDir, "wal", "wal.000001.log");
      const content = fs.readFileSync(walFile, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.seq).toBe(1);
      expect(parsed.channel).toBe("speed");
      expect(parsed.value).toBe(100);
    });
  });

  describe("recovery", () => {
    it("replays WAL entries on restart", async () => {
      wal.append("speed", 100);
      wal.append("rpm", 8000);
      wal.append("speed", 110);
      wal.close();

      // create new engine on same data dir
      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();

      expect(wal2.currentSeq).toBe(3);
      expect(wal2.totalEntries).toBe(3);
      expect(wal2.getChannels().sort()).toEqual(["rpm", "speed"]);

      const speeds = wal2.queryByChannel("speed");
      expect(speeds).toHaveLength(2);
      expect(speeds[0].value).toBe(100);
      expect(speeds[1].value).toBe(110);

      wal2.close();
    });

    it("continues seq numbering after restart", async () => {
      wal.append("speed", 100);
      wal.close();

      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();
      const entry = wal2.append("speed", 200);

      expect(entry.seq).toBe(2);
      wal2.close();
    });

    it("handles corrupt WAL lines gracefully", async () => {
      wal.append("speed", 100);
      wal.close();

      // inject corrupt line
      const walFile = path.join(dataDir, "wal", "wal.000001.log");
      fs.appendFileSync(walFile, "NOT VALID JSON\n");
      fs.appendFileSync(walFile, JSON.stringify({ seq: 2, ts: Date.now(), channel: "rpm", value: 5000 }) + "\n");

      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();

      expect(wal2.currentSeq).toBe(2);
      expect(wal2.totalEntries).toBe(2);
      wal2.close();
    });
  });

  describe("generation rotation", () => {
    it("rotates WAL generation at threshold", async () => {
      const smallWal = new WalEngine({ dataDir: tmpDir(), snapshotThreshold: 5, fsyncBatchSize: 100 });
      const smallDir = (smallWal as any).config.dataDir;
      await smallWal.init();

      for (let i = 0; i < 6; i++) {
        smallWal.append("ch", i);
      }

      expect(smallWal.currentGeneration).toBe(2);

      const walFiles = fs.readdirSync(path.join(smallDir, "wal")).sort();
      expect(walFiles).toContain("wal.000001.log");
      expect(walFiles).toContain("wal.000002.log");

      smallWal.close();
      fs.rmSync(smallDir, { recursive: true, force: true });
    });

    it("recovers correctly from snapshot + WAL replay", async () => {
      const dir = tmpDir();
      const w1 = new WalEngine({ dataDir: dir, snapshotThreshold: 3, fsyncBatchSize: 100 });
      await w1.init();

      // 5 entries: snapshot after 3, gen2 gets entries 4-5
      for (let i = 1; i <= 5; i++) {
        w1.append("ch", i * 10);
      }
      w1.close();

      // recover
      const w2 = new WalEngine({ dataDir: dir, snapshotThreshold: 3, fsyncBatchSize: 100 });
      await w2.init();

      expect(w2.currentSeq).toBe(5);
      expect(w2.totalEntries).toBe(5);

      const all = await w2.getEntriesAfterSeq(0);
      expect(all.map((e) => e.value)).toEqual([10, 20, 30, 40, 50]);

      w2.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("queries", () => {
    beforeEach(() => {
      wal.append("speed", 100, 1000);
      wal.append("rpm", 8000, 1001);
      wal.append("speed", 110, 1002);
      wal.append("rpm", 8500, 1003);
      wal.append("speed", 120, 1004);
      wal.append("gps", { lat: 1 }, 1005);
    });

    it("getChannels returns all known channels", () => {
      expect(wal.getChannels().sort()).toEqual(["gps", "rpm", "speed"]);
    });

    it("getChannelCounts returns per-channel counts", () => {
      expect(wal.getChannelCounts()).toEqual({ speed: 3, rpm: 2, gps: 1 });
    });

    it("queryByChannel returns all entries for a channel", () => {
      const results = wal.queryByChannel("speed");
      expect(results).toHaveLength(3);
      expect(results.map((e) => e.value)).toEqual([100, 110, 120]);
    });

    it("queryByChannel filters by startTs and endTs", () => {
      const results = wal.queryByChannel("speed", { startTs: 1001, endTs: 1003 });
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe(110);
    });

    it("queryByChannel respects afterSeq with binary search", () => {
      const results = wal.queryByChannel("speed", { afterSeq: 3 });
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe(120);
      expect(results[0].seq).toBe(5);
    });

    it("queryByChannel respects limit", () => {
      const results = wal.queryByChannel("speed", { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("queryByChannel returns empty for unknown channel", () => {
      expect(wal.queryByChannel("nonexistent")).toEqual([]);
    });

    it("getEntriesAfterSeq returns entries across channels", async () => {
      const results = await wal.getEntriesAfterSeq(4);
      expect(results).toHaveLength(2);
      expect(results[0].seq).toBe(5);
      expect(results[1].seq).toBe(6);
    });

    it("getEntriesAfterSeq filters by channel set", async () => {
      const results = await wal.getEntriesAfterSeq(0, new Set(["rpm"]));
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.channel === "rpm")).toBe(true);
    });
  });

  describe("nuke", () => {
    it("clears all data and resets state", async () => {
      wal.append("speed", 100);
      wal.append("rpm", 8000);
      expect(wal.currentSeq).toBe(2);
      expect(wal.totalEntries).toBe(2);

      await wal.nuke();

      expect(wal.currentSeq).toBe(0);
      expect(wal.totalEntries).toBe(0);
      expect(wal.getChannels()).toEqual([]);
    });

    it("allows new appends after nuke", async () => {
      wal.append("speed", 100);
      await wal.nuke();

      const entry = wal.append("rpm", 5000);
      expect(entry.seq).toBe(1);
      expect(wal.totalEntries).toBe(1);
    });

    it("removes WAL files", async () => {
      wal.append("speed", 100);
      wal.close();

      const walFiles = fs.readdirSync(path.join(dataDir, "wal"));
      expect(walFiles.length).toBeGreaterThan(0);

      wal = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal.init();
      await wal.nuke();

      // fresh WAL file created by init, but no old data
      expect(wal.totalEntries).toBe(0);
    });
  });
});
