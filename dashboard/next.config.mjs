import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pin the tracing/Turbopack root to this directory: otherwise Next walks up looking for a workspace root
// and picks a stray lockfile in a parent (e.g. ~/package-lock.json), which also shifts where standalone/server.js lands.
const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
// A broadcast of up to 5000 recipients travels through one server action call.
export default { output: "standalone", outputFileTracingRoot: root, turbopack: { root }, experimental: { serverActions: { bodySizeLimit: "10mb" } } };
