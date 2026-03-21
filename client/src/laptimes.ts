import { TelemetryManager } from "./telemetry";
import { getActiveTrack } from "./track";
import { trackProgress } from "./track-utils";
import { formatTime, getBestLapTime } from "./format";
import { unpack } from "@msgpack/msgpack";

interface Lap {
  lap: number;
  time: number;
  flag: "clean" | "yellow" | "pit" | "out" | "in";
  track: string;
  startSeq: number;
  endSeq: number;
}

interface Session {
  id: string;
  track: string;
  driver: string;
  createdAt: number;
  running: boolean;
  lapStartTs: number;
  laps: Lap[];
}

export interface LapTimesPanel {
  update: () => void;
}

export function createLapTimes(
  container: HTMLElement,
  mgr: TelemetryManager,
): LapTimesPanel {
  const serverUrl = mgr.serverUrl;
  const trackId =
    new URLSearchParams(window.location.search).get("track") ?? "sonoma";
  const trackDef = getActiveTrack();

  let session: Session | null = null;
  let sessionEs: EventSource | null = null;
  let saving = false;

  // ── Pace reference: best lap progress→time curve ──
  const finishProgress = trackProgress(trackDef.track, trackDef.finishLine[0], trackDef.finishLine[1]);
  let bestLapIdx = -1;
  // sorted array of { norm: 0-1, elapsed: ms } for the best lap
  let bestCurve: { norm: number; elapsed: number }[] = [];

  // ── DOM ──
  const wrapper = document.createElement("div");
  wrapper.className = "laptimes-wrapper";
  wrapper.innerHTML = `
    <div class="laptimes-header">
      <input class="laptimes-driver" id="laptimes-driver" type="text" placeholder="DRIVER" />
      <button class="laptimes-toggle" id="btn-laptimes-toggle">START</button>
    </div>
    <div class="laptimes-current">
      <span class="laptimes-lap-label">--</span>
      <span class="laptimes-timer">0:00.000</span>
    </div>
    <div class="laptimes-delta" id="laptimes-delta"></div>
    <div class="laptimes-best-row">
      <span class="laptimes-best-label">BEST</span>
      <span class="laptimes-best-time">--</span>
    </div>
    <div class="laptimes-list" id="laptimes-list"></div>
    <a class="laptimes-review nav-link" id="laptimes-review" href="/review.html">REVIEW</a>
  `;
  container.appendChild(wrapper);

  const driverInput = wrapper.querySelector("#laptimes-driver") as HTMLInputElement;
  const lapLabelEl = wrapper.querySelector(".laptimes-lap-label")!;
  const timerEl = wrapper.querySelector(".laptimes-timer")!;
  const deltaEl = wrapper.querySelector("#laptimes-delta")!;
  const toggleBtn = wrapper.querySelector("#btn-laptimes-toggle") as HTMLButtonElement;
  const bestTimeEl = wrapper.querySelector(".laptimes-best-time")!;
  const listEl = wrapper.querySelector("#laptimes-list")!;
  const reviewLink = wrapper.querySelector("#laptimes-review") as HTMLAnchorElement;


  // ── API ──
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`${serverUrl}${path}`, opts);
    return res.json();
  }

  async function saveSession(): Promise<void> {
    if (!session || saving) return;
    saving = true;
    try {
      session = await api("PATCH", `/sessions/${session.id}`, {
        running: session.running,
        laps: session.laps,
        driver: session.driver,
      });
    } finally {
      saving = false;
    }
  }

  // ── Load best lap progress→time curve from WAL ──
  async function loadBestCurve(): Promise<void> {
    if (!session) { bestCurve = []; bestLapIdx = -1; return; }

    const clean = session.laps
      .map((l, i) => ({ ...l, idx: i }))
      .filter((l) => l.flag === "clean");
    if (clean.length === 0) { bestCurve = []; bestLapIdx = -1; return; }

    const best = clean.reduce((a, b) => (a.time < b.time ? a : b));
    if (best.idx === bestLapIdx) return;
    bestLapIdx = best.idx;

    try {
      const res = await fetch(`${serverUrl}/wal/range?start_seq=${best.startSeq}&end_seq=${best.endSeq}`);
      const buf = await res.arrayBuffer();
      const ticks = unpack(new Uint8Array(buf)) as Array<{ ts: number; d: Record<string, number> }>;

      bestCurve = [];
      const startTs = ticks[0]?.ts ?? 0;
      for (const tick of ticks) {
        if (tick.d.gps_lat == null || tick.d.gps_lon == null) continue;
        const p = trackProgress(trackDef.track, tick.d.gps_lat, tick.d.gps_lon);
        const norm = ((p - finishProgress) % 1 + 1) % 1;
        bestCurve.push({ norm, elapsed: tick.ts - startTs });
      }
    } catch {
      bestCurve = [];
      bestLapIdx = -1;
    }
  }

  /** Interpolate best lap's elapsed time at a given normalized progress. */
  function bestTimeAtProgress(norm: number): number | null {
    if (bestCurve.length < 2) return null;
    // Find the two points bracketing this progress
    for (let i = 0; i < bestCurve.length - 1; i++) {
      const a = bestCurve[i];
      const b = bestCurve[i + 1];
      // Handle forward progress (skip wrap-arounds)
      if (a.norm <= norm && b.norm > norm && b.norm - a.norm < 0.5) {
        const frac = (norm - a.norm) / (b.norm - a.norm);
        return a.elapsed + frac * (b.elapsed - a.elapsed);
      }
    }
    // If past all points, return last elapsed
    return bestCurve[bestCurve.length - 1].elapsed;
  }

  // ── SSE ──
  function subscribe(id: string): void {
    unsubscribe();
    sessionEs = new EventSource(`${serverUrl}/sessions/${id}/stream`);
    sessionEs.addEventListener("session", (e) => {
      const updated: Session = JSON.parse(e.data);
      session = updated;
      syncUI();
      renderList();
      loadBestCurve();
    });
  }

  function unsubscribe(): void {
    if (sessionEs) { sessionEs.close(); sessionEs = null; }
  }

  // ── UI sync ──
  function syncUI(): void {
    if (!session) {
      toggleBtn.textContent = "START";
      toggleBtn.classList.remove("active");
      lapLabelEl.textContent = "--";
      timerEl.textContent = "0:00.000";
      deltaEl.textContent = "";
      deltaEl.className = "laptimes-delta";
      reviewLink.style.display = "none";
      return;
    }
    toggleBtn.textContent = session.running ? "STOP" : "START";
    toggleBtn.classList.toggle("active", session.running);
    driverInput.value = session.driver;

    const params = new URLSearchParams(window.location.search);
    const reviewUrl = new URL("/review.html", window.location.origin);
    reviewUrl.searchParams.set("session", session.id);
    reviewUrl.searchParams.set("track", session.track);
    if (params.has("local")) reviewUrl.searchParams.set("local", "");
    reviewLink.href = reviewUrl.toString();
    reviewLink.style.display = session.laps.length > 0 ? "" : "none";
  }

  // ── Driver input — save on Enter ──
  driverInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !session) return;
    e.preventDefault();
    session.driver = driverInput.value;
    driverInput.blur();
    try { await api("PATCH", `/sessions/${session.id}`, { driver: session.driver }); } catch {}
  });

  // ── Start/stop ──
  toggleBtn.addEventListener("click", async () => {
    if (session?.running) {
      session.running = false;
      unsubscribe();
      syncUI();
      await saveSession();
    } else {
      session = await api("POST", "/sessions", { track: trackId, driver: driverInput.value });
      syncUI();
      subscribe(session!.id);
      renderList();
      /* reset */;
    }
  });

  // ── Render ──
  function getBestTime(): number | null {
    return session ? getBestLapTime(session.laps) : null;
  }

  function renderList() {
    listEl.innerHTML = "";
    const laps = session?.laps ?? [];
    const best = getBestTime();
    bestTimeEl.textContent = best !== null ? formatTime(best) : "--";

    for (let i = laps.length - 1; i >= 0; i--) {
      const lap = laps[i];
      const row = document.createElement("div");
      row.className = `laptimes-row${lap.flag !== "clean" ? " flagged" : ""}`;

      const delta = best !== null && lap.flag === "clean" ? lap.time - best : null;
      let deltaStr = "";
      let deltaClass = "laptimes-row-delta";
      if (delta === 0) { deltaStr = "BEST"; deltaClass = "laptimes-row-delta best"; }
      else if (delta !== null && delta > 0) deltaStr = `+${(delta / 1000).toFixed(3)}`;

      const flagText = lap.flag === "yellow" ? "YEL" : lap.flag === "pit" ? "PIT" : lap.flag === "out" ? "OUT" : lap.flag === "in" ? "IN" : "\u00b7";

      row.innerHTML =
        `<span class="laptimes-row-num">L${lap.lap}</span>` +
        `<span class="laptimes-row-time">${formatTime(lap.time)}</span>` +
        `<span class="${deltaClass}">${deltaStr}</span>` +
        `<button class="laptimes-row-flag ${lap.flag}" data-idx="${i}">${flagText}</button>`;
      listEl.appendChild(row);
    }

    listEl.querySelectorAll(".laptimes-row-flag").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!session) return;
        const idx = parseInt((btn as HTMLElement).dataset.idx!);
        const cur = session.laps[idx].flag;
        const flags: Lap["flag"][] = ["clean", "yellow", "pit", "out", "in"];
        session.laps[idx].flag = flags[(flags.indexOf(cur) + 1) % flags.length];
        renderList();
        await saveSession();
        loadBestCurve();
      });
    });
  }

  // ── Frame update — timer + pace delta via progress interpolation ──
  function update() {
    if (!session?.running || !session.lapStartTs) return;

    const currentLap = session.laps.length + 1;
    const elapsed = Date.now() - session.lapStartTs;
    lapLabelEl.textContent = `L${currentLap}`;
    timerEl.textContent = formatTime(elapsed);

    // Need GPS + best curve for pace delta
    if (bestCurve.length < 2 || currentLap <= 1) {
      deltaEl.textContent = "";
      deltaEl.className = "laptimes-delta";
      return;
    }

    const latBuf = mgr.getBuffer("gps_lat");
    const lonBuf = mgr.getBuffer("gps_lon");
    if (!latBuf || !lonBuf || latBuf.values.length === 0) return;

    const lat = latBuf.values[latBuf.values.length - 1];
    const lon = lonBuf.values[lonBuf.values.length - 1];
    if (lat === 0 && lon === 0) return;

    const rawP = trackProgress(trackDef.track, lat, lon);
    const norm = ((rawP - finishProgress) % 1 + 1) % 1;

    // What time was the best lap at this same track position?
    const bestElapsed = bestTimeAtProgress(norm);
    if (bestElapsed === null) return;

    const delta = elapsed - bestElapsed;
    if (delta <= 0) {
      deltaEl.textContent = `${(delta / 1000).toFixed(3)}`;
      deltaEl.className = "laptimes-delta ahead";
    } else {
      deltaEl.textContent = `+${(delta / 1000).toFixed(3)}`;
      deltaEl.className = "laptimes-delta behind";
    }
  }

  // ── Init ──
  async function init() {
    try {
      const sessions: Session[] = await api("GET", `/sessions?track=${trackId}`);
      if (sessions.length > 0) {
        session = sessions[0];
        syncUI();
        renderList();
        await loadBestCurve();
        if (session.running) subscribe(session.id);
      }
    } catch {}
  }
  init();

  return { update };
}
