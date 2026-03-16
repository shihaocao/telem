import { WalEngine } from "./wal.js";
import { createServer } from "./http.js";

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

  const server = createServer(wal);

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
