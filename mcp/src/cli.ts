#!/usr/bin/env node
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, type Opts } from "./server.js";

const { values: v } = parseArgs({
  options: { tools: { type: "string" }, "read-only": { type: "boolean" }, http: { type: "boolean" }, port: { type: "string" } },
});
const base = {
  apiUrl: process.env.MAILCRAFT_API_URL ?? "http://localhost:8080",
  readOnly: v["read-only"],
  only: v.tools?.split(",").map((s) => s.trim()).filter(Boolean),
};

if (!v.http) {
  await buildServer({ ...base, apiKey: () => process.env.MAILCRAFT_API_KEY }).connect(new StdioServerTransport());
} else {
  const port = Number(v.port ?? 3333);
  createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) { res.writeHead(404).end(); return; }
    // stateless: fresh server per request; the caller's key is used for that request only
    const auth = req.headers.authorization;
    const key = (auth?.match(/^Bearer\s+(\S+)/i)?.[1]) ?? (req.headers["x-api-key"] as string | undefined);
    if (!key) { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: { code: "unauthenticated", message: "Send Authorization: Bearer mc_... or x-api-key", retryable: false } })); return; }
    const opts: Opts = { ...base, apiKey: () => key };
    const server = buildServer(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port, () => console.error(`mailcraft-mcp listening on :${port}/mcp`));
}
