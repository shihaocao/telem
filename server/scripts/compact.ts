/**
 * Compact WAL: repack entries with per-batch seq numbering + range footers.
 * Runs directly against the data directory — no server needed.
 *
 * Usage: tsx scripts/compact.ts [--data-dir ./data]
 *
 * WARNING: Stop the telem-server before running this.
 */

import { WalEngine } from "../src/wal.js";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const DATA_DIR = arg("data-dir", "./data");

async function main() {
  console.log(`compacting WAL in ${DATA_DIR}...`);

  const wal = new WalEngine({
    dataDir: DATA_DIR,
    snapshotThreshold: 5_000,
    fsyncBatchSize: 100,
  });

  await wal.init();
  console.log(`  current seq: ${wal.currentSeq}`);
  console.log(`  total entries: ${wal.totalEntries}`);

  const result = await wal.compact();
  console.log(`done:`);
  console.log(`  old files:      ${result.oldFiles}`);
  console.log(`  old entries:    ${result.oldEntries}`);
  console.log(`  new entries:    ${result.newEntries}`);
  console.log(`  new max seq:    ${result.newSeq}`);
  console.log(`  sessions fixed: ${result.sessionsRepaired}`);

  wal.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
