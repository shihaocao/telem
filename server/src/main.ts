import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WalEngine } from "./wal.js";
import { createServer } from "./http.js";
import { SessionStore } from "./sessions.js";
import { LapDetector } from "./lap-detector.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "../../tracks");

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const PORT = parseInt(process.env.PORT ?? "4400", 10);
const SNAPSHOT_THRESHOLD = parseInt(process.env.SNAPSHOT_THRESHOLD ?? "50000", 10);
const FSYNC_BATCH_SIZE = parseInt(process.env.FSYNC_BATCH_SIZE ?? "100", 10);

async function main(): Promise<void> {
  const wal = new WalEngine({
    dataDir: DATA_DIR,
    snapshotThreshold: SNAPSHOT_THRESHOLD,
    fsyncBatchSize: FSYNC_BATCH_SIZE,
  });

  await wal.init();
  console.log(
    `WAL initialized: seq=${wal.currentSeq} gen=${wal.currentGeneration} entries=${wal.totalEntries}`,
  );

  const sessions = new SessionStore(DATA_DIR);
  const lapDetector = new LapDetector(TRACKS_DIR, sessions, wal);
  const server = createServer(wal, sessions, lapDetector);

  // Wire GPS data to lap detector
  let lastLat = 0;
  let lastLon = 0;
  let lastGpsTs = 0;

  wal.on("entry", (entry) => {
    if (entry.channel === "gps_lat") {
      lastLat = entry.value as number;
      lastGpsTs = entry.ts;
    } else if (entry.channel === "gps_lon") {
      lastLon = entry.value as number;
      // trigger detection when we have both lat+lon (they come in the same batch)
      if (lastLat !== 0 && lastLon !== 0 && entry.ts === lastGpsTs) {
        lapDetector.onGps(lastLat, lastLon, entry.ts);
      }
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`telemetry server listening on 0.0.0.0:${PORT}`);
  });

  const shutdown = (): void => {
    console.log("shutting down...");
    server.close(() => {
      wal.close();
      console.log("shutdown complete");
      process.exit(0);
    });

    // force exit after 5s if connections don't drain
    setTimeout(() => {
      wal.close();
      process.exit(1);
    }, 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
