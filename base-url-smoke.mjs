/**
 * Guard: the package's DEFAULT_BASE_URL must actually serve the API.
 *
 * v0.1.0 shipped with a default base of `app.descodify.pt` — a host with no DNS
 * record — so the server was broken for anyone who didn't set DESCODIFY_BASE_URL.
 * Every other smoke overrode the base URL, so nothing caught it. This one asserts
 * the real default resolves and serves the public, no-key OpenAPI document.
 *
 * Requires network. Run: `node base-url-smoke.mjs` after `npm run build`.
 */
import { DEFAULT_BASE_URL } from "./dist/client.js";

const url = `${DEFAULT_BASE_URL}/api/v1/openapi.json`;
console.log(`checking default base: ${url}`);

let res;
try {
  res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
} catch (err) {
  console.error(`FAIL: DEFAULT_BASE_URL is unreachable (${err.message}). Does the host resolve?`);
  process.exit(1);
}

if (!res.ok) {
  console.error(`FAIL: ${url} returned HTTP ${res.status}`);
  process.exit(1);
}

const doc = await res.json();
if (!doc.openapi || !doc.paths?.["/invoices"]) {
  console.error("FAIL: response is not the expected Descodify OpenAPI document");
  process.exit(1);
}

// Drift check: the served contract should agree with our default, or clients
// generated from the published spec point somewhere else than this server does.
// A warning, not a failure — the spec's `servers` entry is fixed in the app repo
// and lands on its own deploy cadence.
const declared = doc.servers?.[0]?.url;
if (declared && !declared.startsWith(DEFAULT_BASE_URL)) {
  console.warn(`WARN: served OpenAPI declares servers[0]=${declared}, which disagrees with DEFAULT_BASE_URL=${DEFAULT_BASE_URL}`);
}

console.log(`OK: default base serves the API (openapi ${doc.openapi}, servers[0]=${declared ?? "n/a"})`);
console.log("BASE URL SMOKE PASSED");
process.exit(0);
