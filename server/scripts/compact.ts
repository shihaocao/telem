/**
 * Compact WAL: repack entries with per-batch seq numbering + range footers.
 * If the server is running (lock held), delegates to POST /compact.
 * Otherwise runs directly against the data directory.
 *
 * Usage: tsx scripts/compact.ts [--data-dir ./data] [--server-url http://...]
 */

import * as http from "node:http";
import { WalEngine } from "../src/wal.js";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const DATA_DIR = arg("data-dir", "./data");
const SERVER_URL = arg("server-url", "http://127.0.0.1:4400");

function compactViaServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL("/compact", SERVER_URL);
    const req = http.request(url, { method: "POST" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          console.log("done (via server):");
          console.log(`  old files:      ${result.oldFiles}`);
          console.log(`  old entries:    ${result.oldEntries}`);
          console.log(`  new entries:    ${result.newEntries}`);
          console.log(`  new max seq:    ${result.newSeq}`);
          console.log(`  sessions fixed: ${result.sessionsRepaired}`);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function compactDirect() {
  const wal = new WalEngine({
    dataDir: DATA_DIR,
    snapshotThreshold: 5_000,
    fsyncBatchSize: 100,
  });

  await wal.init();
  console.log(`  current seq: ${wal.currentSeq}`);
  console.log(`  total entries: ${wal.totalEntries}`);

  const result = await wal.compact();
  console.log("done (direct):");
  console.log(`  old files:      ${result.oldFiles}`);
  console.log(`  old entries:    ${result.oldEntries}`);
  console.log(`  new entries:    ${result.newEntries}`);
  console.log(`  new max seq:    ${result.newSeq}`);
  console.log(`  sessions fixed: ${result.sessionsRepaired}`);

  wal.close();
}

async function main() {
  console.log(`compacting WAL in ${DATA_DIR}...`);

  try {
    await compactDirect();
  } catch (err: any) {
    if (err.message?.includes("WAL is locked")) {
      console.log("lock held — delegating to server...");
      await compactViaServer();
    } else {
      throw err;
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
