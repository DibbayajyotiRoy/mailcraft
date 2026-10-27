import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({ plugins: [react()], resolve: { alias: { "@": new URL(".", import.meta.url).pathname } }, test: { globals: true, environment: "jsdom", include: ["tests/**/*.test.{ts,tsx}"] } });
