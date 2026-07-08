/**
 * In-process MCP handshake smoke test — no network, no DB.
 * Boots the built server over stdio, lists tools, and exercises one call
 * against an unreachable base URL (so it fails as a graceful network error,
 * never a live production hit). Run: `node smoke.mjs` after `npm run build`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = [
  "get_business_profile",
  "list_customers", "get_customer", "create_customer", "update_customer", "delete_customer",
  "list_products", "get_product", "create_product", "update_product", "delete_product",
  "list_invoices", "get_invoice", "create_invoice", "issue_invoice", "cancel_invoice", "get_invoice_pdf",
];

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, DESCODIFY_API_KEY: "dsc_live_smoke", DESCODIFY_BASE_URL: "http://127.0.0.1:1" },
  stderr: "inherit",
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const missing = EXPECTED.filter((n) => !names.includes(n));
const extra = names.filter((n) => !EXPECTED.includes(n));
if (missing.length || extra.length) {
  console.error("FAIL tools mismatch:", { missing, extra });
  process.exit(1);
}
console.log(`OK: ${tools.length} tools registered.`);

// A call must degrade gracefully to an isError result, not crash the server.
const res = await client.callTool({ name: "get_business_profile", arguments: {} });
if (!res.isError || !/network_error|Could not reach/i.test(res.content?.[0]?.text ?? "")) {
  console.error("FAIL expected a graceful network error, got:", JSON.stringify(res));
  process.exit(1);
}
console.log("OK: failing call returned a graceful tool error.");

await client.close();
console.log("SMOKE PASSED");
process.exit(0);
