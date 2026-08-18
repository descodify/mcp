/**
 * Contract conformance against the LIVE `/api/v1` OpenAPI document.
 *
 * Why this exists: on 2026-08-12 the API renamed invoice line prices from cents
 * to `unitPriceMicros` (PR #1243). This package kept sending `unitPrice`, so
 * every create_invoice call against production failed — and nothing caught it,
 * because smoke.mjs and live-smoke.mjs both run against mocks written from THIS
 * package's own idea of the contract. They agreed with each other and with
 * nothing real.
 *
 * So: drive the built server against a recording mock, then validate the bodies
 * it actually sends against the published schema. The spec is the authority;
 * this package tracks it and never leads it.
 *
 * Network-dependent by design. Skips loudly if the spec cannot be fetched.
 * Run: `node conformance.mjs` after `npm run build`.
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KEY = "dsc_live_conformance";
const SPEC_URL = `${process.env.DESCODIFY_BASE_URL ?? "https://descodify.pt"}/api/v1/openapi.json`;

let spec;
try {
  const res = await fetch(SPEC_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  spec = await res.json();
} catch (err) {
  console.error(`SKIPPED: could not fetch ${SPEC_URL} (${err.message}). Conformance needs the published spec.`);
  process.exit(0);
}

const deref = (ref) => ref.replace("#/", "").split("/").reduce((o, k) => o?.[k], spec);

/** Flattens $ref and allOf into one { properties, required } view. */
function flatten(schema) {
  if (!schema) return { properties: {}, required: [] };
  if (schema.$ref) return flatten(deref(schema.$ref));
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map(flatten).reduce(
      (acc, s) => ({ properties: { ...acc.properties, ...s.properties }, required: [...acc.required, ...s.required] }),
      { properties: {}, required: [] },
    );
  }
  return { properties: schema.properties ?? {}, required: schema.required ?? [] };
}

const problems = [];
function check(label, schema, body) {
  const { properties, required } = flatten(schema);
  const keys = Object.keys(body ?? {});
  for (const r of required) {
    if (!keys.includes(r)) problems.push(`${label}: missing required field "${r}" (sent: ${keys.join(", ") || "nothing"})`);
  }
  for (const k of keys) {
    if (!(k in properties)) problems.push(`${label}: sends "${k}", which the published schema does not define`);
  }
  // Line items carry their own schema; the cents/micros break lived here.
  if (Array.isArray(body?.items) && properties.items?.items) {
    body.items.forEach((it, i) => check(`${label} items[${i}]`, properties.items.items, it));
  }
}

// ── Recording mock ────────────────────────────────────────────────────────────
const seen = [];
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { /* asserted below */ }
    seen.push({ method: req.method, path: url.pathname.replace(/^\/api\/v1/, ""), body: parsed });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "x1", name: "x", status: "draft", items: [] }));
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${api.address().port}`;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, DESCODIFY_API_KEY: KEY, DESCODIFY_BASE_URL: baseUrl },
  stderr: "ignore",
});
const client = new Client({ name: "conformance", version: "0.0.0" });
await client.connect(transport);

// Representative payloads — every mutating tool that sends a JSON body.
const CALLS = [
  ["create_customer", { customerType: "business", name: "Acme Lda", country: "PT", vatNumber: "500000000" }],
  ["update_customer", { id: "cus_1", customerType: "business", name: "Acme Lda", country: "PT" }],
  ["create_product", { name: "Consulting", unitPrice: "80.00", unit: "hour", vatTier: "normal", itemType: "services" }],
  ["update_product", { id: "prd_1", name: "Consulting", unitPrice: "80.00", unit: "hour", vatTier: "normal", itemType: "services" }],
  ["create_invoice", { invoiceType: "invoice", customerId: "cus_1", items: [{ description: "Consulting", quantity: 10, unitPrice: "80.00", vatRate: 23, itemType: "services" }] }],
];

for (const [name, args] of CALLS) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) problems.push(`${name}: tool refused a representative payload — ${r.content?.[0]?.text ?? ""}`);
}

await client.close();
api.close();

// ── Validate what actually went on the wire ───────────────────────────────────
const METHOD = { POST: "post", PATCH: "patch", PUT: "put" };
for (const req of seen) {
  if (!req.body) continue;
  const specPath = req.path.replace(/\/(cus|prd|inv)_[^/]+/g, "/{id}").replace(/\/x1(?=\/|$)/, "/{id}");
  const op = spec.paths?.[specPath]?.[METHOD[req.method]];
  if (!op) {
    problems.push(`${req.method} ${req.path}: no such operation in the published spec (path drift?)`);
    continue;
  }
  const schema = op.requestBody?.content?.["application/json"]?.schema;
  if (!schema) continue;
  check(`${req.method} ${specPath}`, schema, req.body);
}

console.log(`Checked ${seen.filter((s) => s.body).length} request bodies against ${SPEC_URL}\n`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error(`\nCONFORMANCE FAILED — ${problems.length} mismatch(es) with the published API contract.`);
  process.exit(1);
}
console.log("CONFORMANCE PASSED — every field sent is one the published schema defines, and nothing required is missing.");
process.exit(0);
