import { defineConfig } from "vite";
export default defineConfig({
  root: "client",
  publicDir: "../public",
  build: { outDir: "../dist", emptyOutDir: true },
  server: { allowedHosts: ["localhost", "127.0.0.1"] },
});
