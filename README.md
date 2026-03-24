# Telem

Racing telemetry system for a 1992 Honda Accord EX (F22A4, H2U5 5-speed manual). Captures sensor data, GPS/IMU, and multi-camera video during track days. Runs headless on a Jetson Nano with a web-based dashboard accessible over Tailscale.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│  Arduino Mega   │     │  RaceBox Micro   │
│  ECT TPS MAP    │     │  GPS/IMU @ 25Hz  │
│  Brake Vbatt    │     │  (BLE / UBX)     │
│  RPM VSS @ 25Hz │     └────────┬─────────┘
└────────┬────────┘              │
         │ serial 115200         │ BLE
         ▼                       ▼
┌─────────────────────────────────────────┐
│            Jetson Nano                  │
│                                         │
│  serial-bridge ──┐                      │
│  racebox-bridge ─┤──► telem-server      │
│                  │    (WAL engine)       │
│                  │       │               │
│  video-streaming │    HTTP :4400         │
│  (GStreamer/SRT) │    SSE /stream        │
│  cam1 :9000      │    msgpack /wal/range │
│  cam2 :9001      │                      │
│  audio :9002     │                      │
└─────────────────────────────────────────┘
         │ Tailscale
         ▼
┌─────────────────────────────────────────┐
│  Browser (Vite client)                  │
│  Dashboard · Review · Debug · Editor    │
│  Stream overlays (OBS browser source)   │
└─────────────────────────────────────────┘
```

## Directory Structure

```
src/              Arduino Mega firmware (PlatformIO)
server/           Node.js telemetry server + WAL engine
  src/            Core: wal.ts, http.ts, sessions.ts, lap-detector.ts, gear.ts, sensors.ts
  scripts/        serial-bridge.ts, gen-data.ts, compact.ts, repair-sessions.ts
client/           Vite multi-page web app
  src/            TypeScript sources for each page
bluetooth/        RaceBox BLE bridge (node-ble, UBX protocol)
streaming/        GStreamer video/audio capture scripts
tracks/           Track geometry JSON files (Sonoma, Sharon, etc.)
fonts/            Berkeley Mono
```

## Hardware

| Component | Role | Interface |
|---|---|---|
| Arduino Mega 2560 | Sensor ADC + pulse counting | Serial 115200 baud |
| RaceBox Micro | GPS + 3-axis accel + 3-axis gyro | BLE (Nordic NUS) |
| Jetson Nano | Server, bridges, video encoding | USB/GPIO |
| Logitech C930e | Primary camera (1080p) | USB → H.264 (nvv4l2h264enc) |
| Secondary webcam | Rear/cockpit view (720p) | USB → H.264 |
| Rode LavMicro-U | In-car audio | USB → Opus 64kbps |

### Sensors (Mega)

| Pin | Sensor | Signal | Conversion |
|---|---|---|---|
| A8 | ECT | NTC thermistor, 6.65kΩ pullup | Voltage → resistance → °C (Honda FSM table) |
| A9 | TPS | Linear 0.5–4.5V | `(v - 0.5) / 4.0 * 100` → 0–100% |
| A10 | MAP | Honda 1-bar Denso | `(v - 0.5) * 32.4 + 20` → kPa |
| A5 | Brake | 12V circuit, 4.3× divider | Binary threshold at ~6V |
| A6 | Vbatt | 12V, 4.3× divider | `v * 4.3` → volts |
| D18 | RPM tach | 5V square wave, ~5 pulses/rev | Ring buffer frequency averaging |
| D19 | VSS | 5V square wave | Hz → km/h (needs calibration) |

## WAL Engine

Custom append-only write-ahead log designed for low memory usage on the Jetson.

- **Disk format**: NDJSON with merged channels per line: `{"seq":1,"ts":...,"d":{"rpm":3500,"speed":65}}`
- **Per-batch seq**: One sequence number per ingest call (not per channel)
- **File rotation**: 5,000 ticks per file (~200s of data), range footer on each file (`#range:min,max`)
- **In-memory index**: `{file, minSeq, maxSeq}[]` built on startup for fast range queries
- **Ring buffers**: Per-channel in-memory (6,000 entries) for live SSE streaming
- **Compaction**: Merges same-timestamp lines within 50ms buckets, reassigns sequential seqs, repairs session pointers
- **Locking**: `wal.lock` file prevents concurrent servers and protects during compaction. Server returns 503 on WAL routes while compacting.
- **Wire format**: MessagePack via `msgpackr` (~40% smaller than JSON)

## Client Pages

| Page | Path | Purpose |
|---|---|---|
| Dashboard | `/` | Live gauges (speed/RPM/TPS/brake), GPS maps (follow + overview), g-force dial, diagnostics, lap times with pace delta |
| Review | `/review.html` | Session/lap browser, seekable replay, trail color modes (speed/throttle/RPM/brake), IndexedDB cache |
| Debug | `/debug.html` | Auto-discovered channels with sparklines, systemd service management, camera controls |
| Editor | `/editor.html` | Track polyline editor with Leaflet, toolbar modes, bearing slider, satellite toggle |
| Stream: Map | `/stream/map.html` | Transparent overlay — track + car position (for OBS) |
| Stream: Car Data | `/stream/car_data.html` | Transparent overlay — value + sparkline gauges |
| Stream: Lap Data | `/stream/lap_data.html` | Transparent overlay — driver, lap count, timer, delta |

## Video/Audio Streaming

GStreamer pipelines on the Jetson, SRT over Tailscale:

- **Video**: `v4l2src → jpegdec → nvvidconv → nvv4l2h264enc (4Mbps, GOP 15) → MPEG-TS → SRT`
- **Audio**: `alsasrc (40ms buffer) → Opus (64kbps, 10ms frames) → MPEG-TS → SRT`
- **SRT latency**: 100ms (tuned for ~150ms Tailscale RTT)
- C930e always pinned to port 9000 regardless of USB enumeration

## Lap Detection

GPS-based — no trackside hardware needed.

1. Project GPS position onto track centerline polyline → normalized progress 0–1
2. Detect finish line crossing: `prevProgress > 0.85 && currentProgress < 0.15`
3. First lap auto-flagged as out lap, session stop flags current lap as in lap
4. Pace delta: progress-vs-time curve from best lap, interpolated at current position

## Setup

On the Jetson:

```bash
# Install deps + systemd services
./setup.sh

# Check service status
./status.sh

# View logs
journalctl -u telem-server -u serial-bridge -u racebox-bridge -u video-streaming -f
```

### Services

| Service | Description |
|---|---|
| `racebox-connect` | BLE connection to RaceBox Micro |
| `telem-server` | WAL telemetry server (port 4400) |
| `racebox-bridge` | RaceBox BLE → telem ingest |
| `serial-bridge` | Arduino Mega serial → telem ingest |
| `video-streaming` | GStreamer camera streams over SRT |

## Development

```bash
# Client (Vite dev server)
cd client && npm run dev

# Server
cd server && npx tsx src/main.ts

# Tests
cd server && npx vitest run

# Generate synthetic data
cd server && npx tsx scripts/gen-data.ts

# Compact WAL (run offline or delegates to server if running)
cd server && npx tsx scripts/compact.ts --data-dir ./data

# Firmware upload
pio run -e mega_serial -t upload
```

## Embedded

```bash
# Upload Arduino Mega firmware
pio run -e mega_serial -t upload

# Other targets
pio run -e teensy_blink -t upload
pio run -e teensy_serial -t upload
```

### udev rules (for Arduino on Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/platformio/platformio-core/develop/platformio/assets/system/99-platformio-udev.rules | sudo tee /etc/udev/rules.d/99-platformio-udev.rules
sudo service udev restart
```
