/**
 * Live HTTP round-trip smoke — drives the built MCP server (subprocess, stdio)
 * against a local conformance mock of `/api/v1` that mirrors the real API's
 * contract (Bearer auth, camelCase bodies, `{ error: { type, message } }`
 * envelope). Proves the client's real HTTP path: auth header, method/path/query,
 * JSON body, idempotency-on-issue, and success + error-envelope parsing.
 *
 * The real `/api/v1` server side is covered by app/api/v1/v1-flow.test.ts;
 * this covers the wire contract of THIS package's client end-to-end.
 *
 * Run: `node live-smoke.mjs` after `npm run build`.
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KEY = "dsc_live_conformance";
const seen = [];
let fail = null;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    let bodyJson = null;
    try { bodyJson = body ? JSON.parse(body) : null; } catch { /* non-JSON bodies are asserted elsewhere */ }
    seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, idem: req.headers["idempotency-key"], bodyJson });
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // Every real request must carry the bearer key.
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      fail ??= `missing/wrong auth header: ${req.headers.authorization}`;
      return json(401, { error: { type: "invalid_api_key", message: "bad key" } });
    }
    if (url.pathname === "/api/v1/business-profile") {
      return json(200, { name: "Conformance Lda", nif: "500000000", regime: "simplificado" });
    }
    if (url.pathname === "/api/v1/customers" && req.method === "GET") {
      return json(200, { data: [{ id: "c1", name: url.searchParams.get("q") ?? "all" }], next_cursor: null });
    }
    if (url.pathname === "/api/v1/invoices" && req.method === "POST") {
      const parsed = bodyJson ?? {};
      // /api/v1 requires unitPriceMicros. The tool surface takes decimal euros,
      // so the wrapper must convert — a regression here is a 10_000x error on a
      // signed document, which is why it is asserted on the wire, not in a unit test.
      const line = parsed.items?.[0] ?? {};
      if ("unitPrice" in line) fail ??= "raw unitPrice leaked to the API; it only accepts unitPriceMicros";
      if (typeof line.unitPriceMicros !== "number") {
        fail ??= `expected a numeric unitPriceMicros, got ${JSON.stringify(line.unitPriceMicros)}`;
      }
      if (parsed.action === "issue") {
        if (!req.headers["idempotency-key"]) fail ??= "issue POST missing Idempotency-Key header";
        if (line.unitPriceMicros !== 10_000_000) {
          fail ??= `expected unitPriceMicros 10000000 for "10.00", got ${JSON.stringify(line.unitPriceMicros)}`;
        }
        return json(201, { id: "inv1", status: "issued", invoiceNumber: "FT 2026/1", atcud: "ABC-1" });
      }
      return json(201, { id: "inv2", status: "draft", invoiceNumber: null });
    }
    if (url.pathname === "/api/v1/products" && req.method === "POST") {
      return json(201, { id: "prd1", name: bodyJson?.name ?? "p", unitPrice: bodyJson?.unitPrice });
    }
    if (url.pathname === "/api/v1/customers/nope") {
      return json(403, { error: { type: "insufficient_scope", message: "needs customers:read", details: ["customers:read"] } });
    }
    return json(404, { error: { type: "not_found", message: "no route" } });
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, DESCODIFY_API_KEY: KEY, DESCODIFY_BASE_URL: base },
  stderr: "inherit",
});
const client = new Client({ name: "live-smoke", version: "0.0.0" });
await client.connect(transport);

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
};
const textOf = (r) => r.content?.[0]?.text ?? "";

// 1) Business profile — success envelope parsed.
const profile = await client.callTool({ name: "get_business_profile", arguments: {} });
assert(!profile.isError && textOf(profile).includes("Conformance Lda"), `business profile: ${textOf(profile)}`);
console.log("OK get_business_profile → parsed issuer identity");

// 2) List customers with q — query serialized, page shape returned.
const list = await client.callTool({ name: "list_customers", arguments: { q: "acme", limit: 10 } });
assert(!list.isError && textOf(list).includes("acme"), `list_customers: ${textOf(list)}`);
console.log("OK list_customers → query serialized, page returned");

// 3) The issuing gate. Deterministic and model-independent: issuing is the one
//    irreversible act here, so the server must refuse it until confirmed rather
//    than relying on a tool description the model may ignore.
const issueArgs = {
  invoiceType: "invoice",
  action: "issue",
  items: [{ description: "x", quantity: 1, unitPrice: "10.00", vatRate: 23, itemType: "services" }],
};

// 3a) Unconfirmed — must be refused, and must not reach the API at all.
const unconfirmed = await client.callTool({ name: "create_invoice", arguments: issueArgs });
assert(unconfirmed.isError, `unconfirmed issue should be refused: ${textOf(unconfirmed)}`);
assert(/CONFIRMATION REQUIRED/.test(textOf(unconfirmed)), `expected a confirmation prompt: ${textOf(unconfirmed)}`);
assert(
  !seen.some((s) => s.method === "POST" && s.path === "/api/v1/invoices"),
  "unconfirmed issue reached the API — a certified invoice could have been minted",
);
console.log("OK create_invoice action:issue unconfirmed → refused, nothing sent to the API");

const token = textOf(unconfirmed).match(/confirmationToken: "([^"]+)"/)?.[1];
assert(token, `no confirmationToken handed back: ${textOf(unconfirmed)}`);

// 3b) Wrong token — still refused. Guards against accepting any non-empty string.
const wrongToken = await client.callTool({
  name: "create_invoice",
  arguments: { ...issueArgs, confirmationToken: "not-the-token" },
});
assert(wrongToken.isError, `a wrong confirmationToken must not issue: ${textOf(wrongToken)}`);
assert(
  !seen.some((s) => s.method === "POST" && s.path === "/api/v1/invoices"),
  "a wrong confirmationToken reached the API",
);
console.log("OK create_invoice action:issue wrong token → still refused");

// 3c) Correct token — issues, with action:issue and a generated Idempotency-Key.
//     Note the token from 3a still applies: 3b was refused, so it was not spent.
const issued = await client.callTool({ name: "create_invoice", arguments: { ...issueArgs, confirmationToken: token } });
assert(!issued.isError && textOf(issued).includes("FT 2026/1"), `confirmed issue: ${textOf(issued)}`);
console.log("OK create_invoice action:issue confirmed → certified invoice, idempotency sent");

// 3d) One-shot — replaying the same token must not mint a second invoice.
const replay = await client.callTool({ name: "create_invoice", arguments: { ...issueArgs, confirmationToken: token } });
assert(replay.isError, `a spent confirmationToken must not issue again: ${textOf(replay)}`);
console.log("OK spent token → refused, cannot mint twice");

// 3e) Products take CENTS, not micros — the wrapper must not confuse the two.
const prod = await client.callTool({
  name: "create_product",
  arguments: { name: "Consulting", unitPrice: "80.00", unit: "hour", vatTier: "normal", itemType: "services" },
});
assert(!prod.isError, `create_product: ${textOf(prod)}`);
const prodPost = seen.find((s) => s.method === "POST" && s.path === "/api/v1/products");
assert(prodPost?.bodyJson?.unitPrice === 8000, `expected 8000 cents for "80.00", got ${prodPost?.bodyJson?.unitPrice}`);
console.log("OK create_product → euros converted to cents, not micros");

// 3f) Sub-cent precision survives to micros — the case micro-euros exist for.
const precise = await client.callTool({
  name: "create_invoice",
  arguments: { invoiceType: "invoice", items: [{ description: "fuel", quantity: 100, unitPrice: "1.789", vatRate: 23, itemType: "goods" }] },
});
assert(!precise.isError, `sub-cent create_invoice: ${textOf(precise)}`);
const draftPost = seen.filter((s) => s.method === "POST" && s.path === "/api/v1/invoices").pop();
assert(
  draftPost?.bodyJson?.items?.[0]?.unitPriceMicros === 1_789_000,
  `expected 1789000 micros for "1.789", got ${draftPost?.bodyJson?.items?.[0]?.unitPriceMicros}`,
);
console.log("OK create_invoice → sub-cent unit price survives as micro-euros");

// 3g) A malformed amount is refused as a tool error, never sent.
const bad = await client.callTool({
  name: "create_invoice",
  arguments: { invoiceType: "invoice", items: [{ description: "x", quantity: 1, unitPrice: "80 euros", vatRate: 23, itemType: "services" }] },
});
assert(bad.isError && /decimal amount in euros/.test(textOf(bad)), `bad amount: ${textOf(bad)}`);
console.log("OK malformed amount → refused with a readable error");

// 4) Error envelope — 403 surfaced verbatim as a tool error.
const err = await client.callTool({ name: "get_customer", arguments: { id: "nope" } });
assert(err.isError && /insufficient_scope/.test(textOf(err)) && /customers:read/.test(textOf(err)), `error envelope: ${textOf(err)}`);
console.log("OK get_customer 403 → error envelope surfaced with scope + details");

await client.close();
server.close();

assert(!fail, `server-side assertion: ${fail}`);
const issuePost = seen.find((s) => s.method === "POST" && s.path === "/api/v1/invoices");
assert(issuePost?.idem, "issue POST did not carry an Idempotency-Key");
assert(seen.every((s) => s.auth === `Bearer ${KEY}`), "a request was missing the bearer header");
console.log("LIVE SMOKE PASSED");
process.exit(0);
