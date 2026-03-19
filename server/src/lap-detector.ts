import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { SessionStore, type Lap, type Session } from "./sessions.js";
import { WalEngine } from "./wal.js";

interface TrackDef {
  name: string;
  track: [number, number][];
  finishLine: [number, number];
}

interface TrackInfo {
  def: TrackDef;
  segDists: number[];
  totalDist: number;
  finishProgress: number;
}

function computeSegDists(track: [number, number][]): { segDists: number[]; totalDist: number } {
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

/** Exported for testing. */
export function trackProgress(
  track: [number, number][],
  segDists: number[],
  totalDist: number,
  lat: number,
  lon: number,
): number {
  let bestDist = Infinity;
  let bestProgress = 0;

  for (let i = 0; i < track.length - 1; i++) {
    const [aLat, aLon] = track[i];
    const [bLat, bLon] = track[i + 1];
    const dx = bLon - aLon;
    const dy = bLat - aLat;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;

    const t = Math.max(0, Math.min(1, ((lon - aLon) * dx + (lat - aLat) * dy) / lenSq));
    const pLat = aLat + t * dy;
    const pLon = aLon + t * dx;
    const dist = (lat - pLat) ** 2 + (lon - pLon) ** 2;

    if (dist < bestDist) {
      bestDist = dist;
      bestProgress = (segDists[i] + t * (segDists[i + 1] - segDists[i])) / totalDist;
    }
  }
  return bestProgress;
}

const MIN_LAP_MS = 10_000;

export interface LapEvent {
  sessionId: string;
  session: Session;
  lap: Lap;
}

export class LapDetector extends EventEmitter {
  private tracks = new Map<string, TrackInfo>();
  private prevNorm = new Map<string, number>();
  private sessions: SessionStore;
  private wal: WalEngine;

  constructor(tracksDir: string, sessions: SessionStore, wal: WalEngine) {
    super();
    this.sessions = sessions;
    this.wal = wal;

    const files = fs.readdirSync(tracksDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const def: TrackDef = JSON.parse(fs.readFileSync(path.join(tracksDir, f), "utf-8"));
        const id = f.replace(/\.json$/, "");
        const { segDists, totalDist } = computeSegDists(def.track);
        const finishProgress = trackProgress(def.track, segDists, totalDist, def.finishLine[0], def.finishLine[1]);
        this.tracks.set(id, { def, segDists, totalDist, finishProgress });
      } catch {}
    }
  }

  onGps(lat: number, lon: number, ts: number): void {
    const running = this.sessions.list().filter((s) => s.running);
    for (const sess of running) {
      const info = this.tracks.get(sess.track);
      if (!info) continue;

      const progress = trackProgress(info.def.track, info.segDists, info.totalDist, lat, lon);
      const norm = ((progress - info.finishProgress) % 1 + 1) % 1;
      const prev = this.prevNorm.get(sess.id);
      this.prevNorm.set(sess.id, norm);

      if (prev === undefined) continue;

      if (prev > 0.85 && norm < 0.15) {
        const elapsed = ts - sess.lapStartTs;
        const endSeq = this.wal.currentSeq;

        if (elapsed < MIN_LAP_MS) {
          this.sessions.update(sess.id, { lapStartTs: ts, lapStartSeq: endSeq });
          continue;
        }

        const lapNum = sess.laps.length + 1;
        const lap: Lap = {
          lap: lapNum,
          time: elapsed,
          flag: lapNum === 1 ? "out" : "clean",
          track: sess.track,
          startSeq: sess.lapStartSeq,
          endSeq,
        };

        sess.laps.push(lap);
        const updated = this.sessions.update(sess.id, {
          laps: sess.laps,
          lapStartTs: ts,
          lapStartSeq: endSeq,
        })!;
        console.log(`lap ${lap.lap}: ${(elapsed / 1000).toFixed(3)}s [${sess.track}]`);

        this.emit("lap", { sessionId: sess.id, session: updated, lap } as LapEvent);
      }
    }
  }

  clearSession(id: string): void {
    this.prevNorm.delete(id);
  }
}
