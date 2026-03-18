import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "./sessions.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sessions-test-"));
}

describe("SessionStore", () => {
  let dataDir: string;
  let store: SessionStore;

  beforeEach(() => {
    dataDir = tmpDir();
    store = new SessionStore(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a session with correct defaults", () => {
      const s = store.create("sonoma", 42);
      expect(s.id).toBeTruthy();
      expect(s.track).toBe("sonoma");
      expect(s.running).toBe(true);
      expect(s.laps).toEqual([]);
      expect(s.lapStartSeq).toBe(42);
      expect(s.lapStartTs).toBeGreaterThan(0);
      expect(s.createdAt).toBe(s.lapStartTs);
    });

    it("persists to disk", () => {
      const s = store.create("sonoma", 0);
      const files = fs.readdirSync(path.join(dataDir, "sessions"));
      expect(files).toHaveLength(1);

      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "sessions", files[0]), "utf-8"));
      expect(raw.id).toBe(s.id);
    });
  });

  describe("get", () => {
    it("returns the session by id", () => {
      const s = store.create("sonoma", 0);
      const got = store.get(s.id);
      expect(got).toEqual(s);
    });

    it("returns null for unknown id", () => {
      expect(store.get("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all sessions", () => {
      const a = store.create("sonoma", 0);
      const b = store.create("sf_block", 10);
      const list = store.list();
      expect(list).toHaveLength(2);
      expect(new Set(list.map((s) => s.id))).toEqual(new Set([a.id, b.id]));
    });

    it("filters by track", () => {
      store.create("sonoma", 0);
      store.create("sf_block", 0);
      store.create("sonoma", 0);
      expect(store.list("sonoma")).toHaveLength(2);
      expect(store.list("sf_block")).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("updates running state", () => {
      const s = store.create("sonoma", 0);
      const updated = store.update(s.id, { running: false });
      expect(updated!.running).toBe(false);
      expect(store.get(s.id)!.running).toBe(false);
    });

    it("updates laps with seq pointers", () => {
      const s = store.create("sonoma", 100);
      const laps = [{ lap: 1, time: 60000, flag: "clean" as const, track: "sonoma", startSeq: 100, endSeq: 200 }];
      store.update(s.id, { laps });
      expect(store.get(s.id)!.laps).toEqual(laps);
    });

    it("updates lapStartSeq and lapStartTs", () => {
      const s = store.create("sonoma", 0);
      store.update(s.id, { lapStartSeq: 500, lapStartTs: 9999999 });
      const got = store.get(s.id)!;
      expect(got.lapStartSeq).toBe(500);
      expect(got.lapStartTs).toBe(9999999);
    });

    it("returns null for unknown id", () => {
      expect(store.update("nonexistent", { running: false })).toBeNull();
    });
  });

  describe("delete", () => {
    it("removes the session", () => {
      const s = store.create("sonoma", 0);
      expect(store.delete(s.id)).toBe(true);
      expect(store.get(s.id)).toBeNull();
      expect(store.list()).toHaveLength(0);
    });

    it("returns false for unknown id", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });
});
