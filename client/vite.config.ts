import { defineConfig, Plugin } from "vite";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "../tracks");

function trackApiPlugin(): Plugin {
  return {
    name: "track-api",
    configureServer(server) {
      // GET /api/tracks — list all tracks
      server.middlewares.use("/api/tracks", (req, res, next) => {
        if (req.method === "GET" && (req.url === "/" || req.url === "")) {
          const files = readdirSync(TRACKS_DIR).filter((f) => f.endsWith(".json"));
          const tracks: Record<string, unknown> = {};
          for (const f of files) {
            const id = f.replace(".json", "");
            tracks[id] = JSON.parse(readFileSync(resolve(TRACKS_DIR, f), "utf-8"));
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(tracks));
          return;
        }

        // PUT /api/tracks/:id — save a track
        if (req.method === "PUT" && req.url) {
          const id = req.url.replace(/^\//, "").replace(/\.json$/, "");
          if (!id) { next(); return; }
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const data = JSON.parse(body);
              writeFileSync(resolve(TRACKS_DIR, `${id}.json`), JSON.stringify(data, null, 2) + "\n");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 5173,
  },
  plugins: [trackApiPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        debug: resolve(__dirname, "debug.html"),
        editor: resolve(__dirname, "editor.html"),
      },
    },
  },
});
