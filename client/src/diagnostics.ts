import { TelemetryManager } from "./telemetry";

export interface DiagPanel {
  update: () => void;
}

export function createDiagnostics(
  container: HTMLElement,
  mgr: TelemetryManager,
): DiagPanel {
  container.innerHTML = `
    <div class="diag-container">
      <div class="diag-title">DIAGNOSTICS</div>
      <div class="diag-row">
        <div class="diag-item">
          <span class="diag-value" id="diag-ect">--</span>
          <span class="diag-unit">&deg;C</span>
          <span class="diag-label">Coolant</span>
        </div>
        <div class="diag-item">
          <span class="diag-value" id="diag-map">--</span>
          <span class="diag-unit">kPa</span>
          <span class="diag-label">MAP</span>
        </div>
      </div>
    </div>
  `;

  const ectEl = container.querySelector("#diag-ect")!;
  const mapEl = container.querySelector("#diag-map")!;

  function update(): void {
    const ectBuf = mgr.getBuffer("coolant_temp");
    if (ectBuf && ectBuf.values.length > 0) {
      const temp = ectBuf.values[ectBuf.values.length - 1];
      ectEl.textContent = String(Math.round(temp));
    }

    const mapBuf = mgr.getBuffer("manifold_pressure");
    if (mapBuf && mapBuf.values.length > 0) {
      const kpa = mapBuf.values[mapBuf.values.length - 1];
      mapEl.textContent = String(Math.round(kpa));
    }
  }

  return { update };
}
