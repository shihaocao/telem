/**
 * Compact WAL: repack entries with per-batch seq numbering + range footers.
 *
 * Usage: tsx scripts/compact.ts [--url http://localhost:4400]
 */

const args = process.argv.slice(2);
const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:4400";

async function main() {
  console.log(`compacting WAL on ${url}...`);
  const res = await fetch(`${url}/compact`, {
    method: "POST",
    signal: AbortSignal.timeout(300_000), // 5 min timeout
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  console.log(`done:`);
  console.log(`  old files:   ${data.oldFiles}`);
  console.log(`  old entries: ${data.oldEntries}`);
  console.log(`  new entries: ${data.newEntries}`);
  console.log(`  new max seq: ${data.newSeq}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
