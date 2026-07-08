#!/usr/bin/env node
/**
 * @descodify/mcp — Model Context Protocol server for Descodify.
 *
 * Exposes the public `/api/v1` surface as MCP tools so any MCP client (Claude
 * Desktop, Claude Code, Cursor, …) can drive certified Portuguese invoicing by
 * natural language. Runs locally over stdio; the org is resolved from the API
 * key, so no Descodify-hosted surface or OAuth is involved.
 *
 * Configuration (env):
 *   DESCODIFY_API_KEY   required — a `dsc_live_…` key from Settings → Developers
 *   DESCODIFY_BASE_URL  optional — defaults to https://descodify.pt
 *
 * All diagnostics go to stderr — stdout is reserved for the MCP protocol stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiError, DescodifyClient } from "./client.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const apiKey = process.env.DESCODIFY_API_KEY;
  if (!apiKey) {
    console.error(
      "DESCODIFY_API_KEY is not set. Create an org-scoped key in Descodify → Settings → Developers " +
        "and pass it as the DESCODIFY_API_KEY env var.",
    );
    process.exit(1);
  }

  const baseUrl = process.env.DESCODIFY_BASE_URL;
  const client = new DescodifyClient({ apiKey, baseUrl });

  // Confirm auth once on startup so a bad key fails loudly rather than on the
  // first tool call. A transient network error only warns — tools still work
  // once connectivity returns.
  try {
    const profile = (await client.request<{ name?: string }>("/business-profile")) ?? {};
    console.error(`Descodify MCP: authenticated${profile.name ? ` as ${profile.name}` : ""}.`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.error("Descodify MCP: the DESCODIFY_API_KEY was rejected (401). Check the key in Settings → Developers.");
      process.exit(1);
    }
    console.error(`Descodify MCP: startup profile check failed (${(err as Error).message}); continuing.`);
  }

  const server = new McpServer({ name: "descodify", version: "0.1.0" });
  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Descodify MCP: ready.");
}

main().catch((err) => {
  console.error(`Descodify MCP: fatal — ${(err as Error).message}`);
  process.exit(1);
});
