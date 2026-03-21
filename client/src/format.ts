/** Format milliseconds as m:ss.mmm */
export function formatTime(ms: number): string {
  if (ms <= 0) return "0:00.000";
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toFixed(3).padStart(6, "0")}`;
}

/** Format epoch ms as M/D H:MM */
export function formatDate(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Best clean lap time in ms, or null */
export function getBestLapTime(laps: { time: number; flag: string }[]): number | null {
  const clean = laps.filter((l) => l.flag === "clean");
  if (clean.length === 0) return null;
  return Math.min(...clean.map((l) => l.time));
}
