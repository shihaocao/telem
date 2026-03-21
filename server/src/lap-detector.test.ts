import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WalEngine } from "./wal.js";
import { SessionStore } from "./sessions.js";
import { LapDetector, trackProgress, type LapEvent } from "./lap-detector.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lap-test-"));
}

const SQUARE_TRACK: [number, number][] = [
  [0, 0], [0, 1], [1, 1], [1, 0], [0, 0],
];

function writeTestTrack(tracksDir: string): void {
  fs.mkdirSync(tracksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tracksDir, "test_track.json"),
    JSON.stringify({
      name: "Test Track", track: SQUARE_TRACK, center: [0.5, 0.5],
      zoom: 16, bearing: 0, finishLine: [0, 0], turns: [],
    }),
  );
}

function computeSegDistsHelper(track: [number, number][]): { segDists: number[]; totalDist: number } {
  const segDists = [0];
  let total = 0;
  for (let i = 1; i < track.length; i++) {
    const [lat1, lon1] = track[i - 1];
    const [lat2, lon2] = track[i];
    total += Math.sqrt((lat2 - lat1) ** 2 + (lon2 - lon1) ** 2);
    segDists.push(total);
  }
  return { segDists, totalDist: total };
}

const BEFORE_FINISH: [number, number] = [0.4, -0.1];
const AFTER_FINISH: [number, number] = [0.1, 0.3];
const MIDTRACK: [number, number] = [0.5, 1.1];

describe("trackProgress", () => {
  const { segDists, totalDist } = computeSegDistsHelper(SQUARE_TRACK);

  it("returns 0 at the start of the track", () => {
    expect(trackProgress(SQUARE_TRACK, segDists, totalDist, 0, 0)).toBeCloseTo(0, 5);
  });

  it("returns ~0.25 at the first corner", () => {
    expect(trackProgress(SQUARE_TRACK, segDists, totalDist, 0, 1)).toBeCloseTo(0.25, 2);
  });

  it("returns ~0.5 at the midpoint", () => {
    expect(trackProgress(SQUARE_TRACK, segDists, totalDist, 1, 1)).toBeCloseTo(0.5, 2);
  });

  it("returns ~0.75 at the third corner", () => {
    expect(trackProgress(SQUARE_TRACK, segDists, totalDist, 1, 0)).toBeCloseTo(0.75, 2);
  });

  it("BEFORE_FINISH has progress > 0.85", () => {
    expect(trackProgress(SQUARE_TRACK, segDists, totalDist, ...BEFORE_FINISH)).toBeGreaterThan(0.85);
  });

  it("AFTER_FINISH has progress < 0.15", () => {
    expect(trackProgress(SQUARE_TRACK, segDists, totalDist, ...AFTER_FINISH)).toBeLessThan(0.15);
  });
});

describe("LapDetector", () => {
  let dataDir: string;
  let tracksDir: string;
  let wal: WalEngine;
  let sessions: SessionStore;
  let detector: LapDetector;

  beforeEach(async () => {
    dataDir = tmpDir();
    tracksDir = path.join(dataDir, "tracks");
    writeTestTrack(tracksDir);
    wal = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
    await wal.init();
    sessions = new SessionStore(dataDir);
    detector = new LapDetector(tracksDir, sessions, wal);
  });

  afterEach(() => {
    wal.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("does not detect a lap on the first GPS point", () => {
    sessions.create("test_track", 0);
    const events: LapEvent[] = [];
    detector.on("lap", (e: LapEvent) => events.push(e));
    detector.onGps(...MIDTRACK, Date.now());
    expect(events).toHaveLength(0);
  });

  it("ignores crossings shorter than MIN_LAP_MS", () => {
    const now = Date.now();
    const sess = sessions.create("test_track", 0);
    const events: LapEvent[] = [];
    detector.on("lap", (e: LapEvent) => events.push(e));

    detector.onGps(...BEFORE_FINISH, now);
    detector.onGps(...AFTER_FINISH, now + 1000);

    expect(events).toHaveLength(0);
    const updated = sessions.get(sess.id)!;
    expect(updated.lapStartTs).toBe(now + 1000);
  });

  it("detects a lap when progress wraps around finish", () => {
    const now = Date.now();
    const sess = sessions.create("test_track", 0);
    sessions.update(sess.id, { lapStartTs: now - 60_000 });

    wal.append(
      { channel: "speed", value: 100 },
      { channel: "gps_lat", value: 0.5 },
      { channel: "gps_lon", value: 0.5 },
    );

    const events: LapEvent[] = [];
    detector.on("lap", (e: LapEvent) => events.push(e));

    detector.onGps(...BEFORE_FINISH, now - 1000);
    detector.onGps(...AFTER_FINISH, now);

    expect(events).toHaveLength(1);
    const lap = events[0].lap;
    expect(lap.lap).toBe(1);
    expect(lap.time).toBeGreaterThan(10_000);
    expect(lap.flag).toBe("out");
    expect(lap.startSeq).toBe(0);
    expect(lap.endSeq).toBe(wal.currentSeq);
  });

  it("records correct startSeq/endSeq for successive laps", () => {
    const now = Date.now();
    const sess = sessions.create("test_track", 5);
    sessions.update(sess.id, { lapStartTs: now - 120_000 });

    wal.append({ channel: "speed", value: 100 });
    const seqAfterLap1 = wal.currentSeq;

    const events: LapEvent[] = [];
    detector.on("lap", (e: LapEvent) => events.push(e));

    detector.onGps(...BEFORE_FINISH, now - 60_000);
    detector.onGps(...AFTER_FINISH, now - 60_000 + 100);

    expect(events).toHaveLength(1);
    expect(events[0].lap.startSeq).toBe(5);
    expect(events[0].lap.endSeq).toBe(seqAfterLap1);

    wal.append({ channel: "speed", value: 120 });
    wal.append({ channel: "speed", value: 130 });
    const seqAfterLap2 = wal.currentSeq;

    detector.onGps(...BEFORE_FINISH, now - 1000);
    detector.onGps(...AFTER_FINISH, now);

    expect(events).toHaveLength(2);
    expect(events[1].lap.lap).toBe(2);
    expect(events[1].lap.startSeq).toBe(seqAfterLap1);
    expect(events[1].lap.endSeq).toBe(seqAfterLap2);
  });

  it("emits session with updated laps in the event", () => {
    const now = Date.now();
    const sess = sessions.create("test_track", 0);
    sessions.update(sess.id, { lapStartTs: now - 60_000 });

    const events: LapEvent[] = [];
    detector.on("lap", (e: LapEvent) => events.push(e));

    detector.onGps(...BEFORE_FINISH, now - 1000);
    detector.onGps(...AFTER_FINISH, now);

    expect(events).toHaveLength(1);
    expect(events[0].session.laps).toHaveLength(1);
    expect(events[0].sessionId).toBe(sess.id);
  });

  it("only detects for running sessions", () => {
    const now = Date.now();
    const sess = sessions.create("test_track", 0);
    sessions.update(sess.id, { running: false, lapStartTs: now - 60_000 });

    const events: LapEvent[] = [];
    detector.on("lap", (e: LapEvent) => events.push(e));

    detector.onGps(...BEFORE_FINISH, now - 1000);
    detector.onGps(...AFTER_FINISH, now);

    expect(events).toHaveLength(0);
  });

  it("clearSession removes tracking state so next point is treated as first", () => {
    const now = Date.now();
    const sess = sessions.create("test_track", 0);
    sessions.update(sess.id, { lapStartTs: now - 60_000 });

    detector.onGps(...BEFORE_FINISH, now - 2000);
    detector.clearSession(sess.id);

    const events: LapEvent[] = [];
    detector.on("lap", (e: LapEvent) => events.push(e));

    detector.onGps(...AFTER_FINISH, now);
    expect(events).toHaveLength(0);
  });
});
