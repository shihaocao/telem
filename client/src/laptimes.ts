import { TelemetryManager } from "./telemetry";

interface Lap {
  lap: number;
  time: number;
  flag: "clean" | "yellow" | "pit";
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

  let session: Session | null = null;
  let sessionEs: EventSource | null = null;
  let saving = false;

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
  const toggleBtn = wrapper.querySelector("#btn-laptimes-toggle") as HTMLButtonElement;
  const bestTimeEl = wrapper.querySelector(".laptimes-best-time")!;
  const listEl = wrapper.querySelector("#laptimes-list")!;
  const reviewLink = wrapper.querySelector("#laptimes-review") as HTMLAnchorElement;

  function formatTime(ms: number): string {
    if (ms <= 0) return "0:00.000";
    const totalSec = ms / 1000;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toFixed(3).padStart(6, "0")}`;
  }

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

  // ── SSE ──
  function subscribe(id: string): void {
    unsubscribe();
    sessionEs = new EventSource(`${serverUrl}/sessions/${id}/stream`);
    sessionEs.addEventListener("session", (e) => {
      const updated: Session = JSON.parse(e.data);
      session = updated;
      syncUI();
      renderList();
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

  // ── Driver input ──
  let driverDebounce: ReturnType<typeof setTimeout> | null = null;
  driverInput.addEventListener("input", () => {
    if (!session) return;
    session.driver = driverInput.value;
    if (driverDebounce) clearTimeout(driverDebounce);
    driverDebounce = setTimeout(() => saveSession(), 500);
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
    }
  });

  // ── Render ──
  function getBestTime(): number | null {
    if (!session) return null;
    const clean = session.laps.filter((l) => l.flag === "clean");
    if (clean.length === 0) return null;
    return Math.min(...clean.map((l) => l.time));
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

      const flagText = lap.flag === "yellow" ? "YEL" : lap.flag === "pit" ? "PIT" : "\u00b7";

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
        session.laps[idx].flag = cur === "clean" ? "yellow" : cur === "yellow" ? "pit" : "clean";
        renderList();
        await saveSession();
      });
    });
  }

  // ── Frame update — tick the timer ──
  function update() {
    if (session?.running && session.lapStartTs) {
      const currentLap = session.laps.length + 1;
      const elapsed = Date.now() - session.lapStartTs;
      lapLabelEl.textContent = `L${currentLap}`;
      timerEl.textContent = formatTime(elapsed);
    }
  }

  // ── Init — auto-load latest session for this track ──
  async function init() {
    try {
      const sessions: Session[] = await api("GET", `/sessions?track=${trackId}`);
      if (sessions.length > 0) {
        session = sessions[0];
        syncUI();
        renderList();
        if (session.running) subscribe(session.id);
      }
    } catch {}
  }
  init();

  return { update };
}
