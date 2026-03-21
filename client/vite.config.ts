import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        debug: resolve(__dirname, "debug.html"),
        editor: resolve(__dirname, "editor.html"),
        review: resolve(__dirname, "review.html"),
        "stream-map": resolve(__dirname, "stream/map.html"),
        "stream-car-data": resolve(__dirname, "stream/car_data.html"),
        "stream-lap-data": resolve(__dirname, "stream/lap_data.html"),
      },
    },
  },
});
