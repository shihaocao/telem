/**
 * Repair session seq pointers by scanning WAL for matching timestamps.
 * Run after compaction or if session lap replay is broken.
 *
 * Usage: tsx scripts/repair-sessions.ts [--data-dir ./data]
 */

import { WalEngine } from "../src/wal.js";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const DATA_DIR = arg("data-dir", "./data");

async function main() {
  const wal = new WalEngine({
    dataDir: DATA_DIR,
    snapshotThreshold: 50_000,
    fsyncBatchSize: 100,
  });

  await wal.init();
  console.log(`WAL seq: ${wal.currentSeq}`);

  const repaired = await wal.repairSessions();
  console.log(`done: ${repaired} sessions repaired`);

  wal.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
