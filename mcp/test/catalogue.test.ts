// The dashboard assistant reuses these tool names, descriptions and schemas instead of re-describing the API.
// dashboard/lib/assistant/mcp-catalogue.json is generated from TOOLS (the dashboard has no zod and its Docker
// build context excludes mcp/). `UPDATE_CATALOGUE=1 npm test -- catalogue` rewrites it; otherwise it must match.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import { TOOLS, inputShape } from "../src/tools.js";

const file = new URL("../../dashboard/lib/assistant/mcp-catalogue.json", import.meta.url);
const catalogue = TOOLS.map((t) => ({
  name: t.name, description: t.description, method: t.method, path: t.path, mutating: t.mutating,
  parameters: z.toJSONSchema(z.object(inputShape(t)), { io: "input", unrepresentable: "any" }),
}));
const text = JSON.stringify(catalogue, null, 1) + "\n";

test("dashboard assistant catalogue is in sync with the MCP tools", () => {
  if (process.env.UPDATE_CATALOGUE) writeFileSync(file, text);
  expect(readFileSync(file, "utf8")).toBe(text);
});
