# @descodify/mcp

Model Context Protocol server for [Descodify](https://descodify.pt) — drive
**certified Portuguese invoicing**, customers and products from your AI (Claude
Desktop, Claude Code, Cursor, or any MCP client), by natural language.

It's a thin, open-source wrapper over Descodify's public `/api/v1`. The server
runs locally over stdio; your org is resolved from the API key, so there is no
extra hosting or OAuth — calls land on the same certified path as the app UI.

MCP is an open, vendor-neutral protocol, so the **same server works in any MCP
client** — Claude Desktop, Claude Code, Gemini CLI, Cursor, Windsurf, VS Code
(Copilot agent), Cline, Zed. Only *where* you put the config differs; the
`{ command, args, env }` block is the same everywhere.

> Prefer not to use npm? `github:descodify/mcp` works anywhere `@descodify/mcp`
> does — it's the same code and builds on install.

## Setup

**1. Create an API key.** In Descodify → **Settings → Developers**, create a key
(`dsc_live_…`) with the scopes you need (`customers`, `products`, `invoices`,
read and/or write). Copy the secret — it's shown once.

**2. Add the server to your client.**

<details open>
<summary><b>Claude Desktop</b></summary>

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "descodify": {
      "command": "npx",
      "args": ["-y", "@descodify/mcp"],
      "env": { "DESCODIFY_API_KEY": "dsc_live_..." }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add descodify --env DESCODIFY_API_KEY=dsc_live_... -- npx -y @descodify/mcp
```
</details>

<details>
<summary><b>Gemini CLI</b></summary>

Add to `~/.gemini/settings.json` (same block as Claude Desktop):

```json
{
  "mcpServers": {
    "descodify": {
      "command": "npx",
      "args": ["-y", "@descodify/mcp"],
      "env": { "DESCODIFY_API_KEY": "dsc_live_..." }
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) — same block
as Claude Desktop.
</details>

`DESCODIFY_BASE_URL` is optional (defaults to `https://descodify.pt`); set it
to point at a self-hosted or dev instance.

## Tools

Field names and VAT-in-percent match the API's OpenAPI document
(`GET /api/v1/openapi.json`).

**Money is `unitPrice`, a decimal string** — `"80.00"`, `"1.789"` — on every
tool that takes a price, and it is passed to `/api/v1` verbatim. The API accepts
that field directly and converts to its own stored unit, so this wrapper does no
money arithmetic and has none to get wrong.

**The currency is the invoice's, not the euro.** `currencyCode` (default `EUR`)
sets it once for the whole document: on a USD invoice `unitPrice: "80.00"` means
80.00 USD, and the server derives the euro figures the document is signed and
reported in, printing the euro equivalent and the exchange rate on the invoice
as Portuguese law requires. The catalogue is priced in EUR — only a document
carries a currency — and a product added to a foreign-currency invoice is
converted at that document's rate.

| Tool | Endpoint |
|---|---|
| `get_business_profile` | `GET /business-profile` |
| `list_customers` `get_customer` `create_customer` `update_customer` `delete_customer` | `/customers*` |
| `list_products` `get_product` `create_product` `update_product` `delete_product` | `/products*` |
| `list_invoices` `get_invoice` | `/invoices*` |
| `create_invoice` | `POST /invoices` (draft; `action:"issue"` to create-and-issue) |
| `issue_invoice` | `POST /invoices/{id}/issue` |
| `cancel_invoice` | `POST /invoices/{id}/cancel` |
| `get_invoice_pdf` | `GET /invoices/{id}/pdf` → `{ url }` |

## Fiscal safety

`issue_invoice` (and `create_invoice` with `action:"issue"`) mint a **legally
certified, AT-communicated invoice with a permanent sequential number**. It
**cannot be edited or deleted** — only corrected via a credit note. The server
sends a fresh `Idempotency-Key` on every issue so an agent retry can never mint a
duplicate certified invoice, and every write tool's description tells the model
to confirm with you before issuing.

For an agent that should follow Portuguese fiscal conventions end-to-end, pair
this with the public **`descodify`** skill in [`skills/descodify/`](skills/descodify) of this repo
(published to [skills.sh](https://skills.sh)) — it encodes the guardrails
(confirm-before-issue, credit-note-not-edit, defer tax facts to Descodify).

## Issuing requires confirmation

Issuing is the only irreversible act in this surface: it mints a legally
certified invoice with a permanent sequential number that cannot be edited or
deleted, only corrected with a credit note. The server enforces confirmation
rather than trusting the model to ask.

`issue_invoice`, and `create_invoice` with `action:"issue"`, take two calls:

1. The first call issues nothing. It returns the exact invoice about to be
   minted — customer, line items, total — plus a one-shot `confirmationToken`.
2. After the user approves, the same tool is called again with that token.

A wrong token is refused, a spent token is refused, and neither reaches the API.
If your MCP client supports elicitation, the server asks you directly instead
and issues only on an explicit accept.

This costs one extra confirmation on a legally binding document, deliberately.

## Development

```sh
bun install       # or npm install
bun run build     # tsc → dist/
```

### Tests

```sh
npm run smoke        # handshake, tool registration, wire contract, conformance
npm run conformance  # just the contract check against the live openapi.json
npm run eval         # golden questions: does a real model pick the right tool?
```

`smoke` runs the built server against an unreachable host and a local mock of
`/api/v1`, so it never touches live data. Its last step, `conformance`, is the
one part that needs the network: it fetches the **published** `openapi.json` and
validates every request body the server actually sends against it — required
fields present, no field the schema does not define. It skips loudly if the spec
is unreachable.

That check exists because mocks are not a contract. On 2026-08-12 the API
renamed invoice line prices to `unitPriceMicros`; this package kept sending
`unitPrice`, so every `create_invoice` against production failed — and both
smoke tests stayed green, because they ran against mocks written from this
package's own idea of the contract. They agreed with each other and with nothing
real. Run `npm run conformance` after any API change.

`eval` is the behavioural test: it boots the server against the same kind of
mock, pulls the real shipped tool schemas over MCP, and asks Claude a set of
questions a user would actually type, asserting which tools do and do not get
called. It covers routing (does "show me my customers" reach `list_customers`?)
and the safety contract the tool descriptions promise — most importantly that
drafting an invoice never issues one, since issuing is irreversible.

It needs `ANTHROPIC_API_KEY` and costs a few cents per run; without a key it
skips loudly rather than failing. It defaults to `claude-opus-5`. `EVAL_MODEL`
overrides the model and `EVAL_REPEATS` runs several rounds, which is worth doing
after editing a tool description — routing is model behaviour, so a single green
run is weaker evidence than a deterministic test.

**Also run it against a small model.** Measured, not assumed: with the safety
wording stripped out of `issue_invoice`, `claude-opus-4-7` still refused to
issue without confirmation, while `claude-haiku-4-5` created *and issued* a
certified invoice off "Bill Acme 800 euros". A strong model's own caution masks
a bad description, so an eval run only against the strongest model will pass no
matter what the descriptions say. `EVAL_MODEL=claude-haiku-4-5` is the sensitive
setting and the one that tells you whether the descriptions are carrying their
weight; the default is the "does this work for real users" check.

(That measurement was taken on `claude-opus-4-7`, the strongest model available
at the time. The point is about model strength, not that specific version.)

**A prose instruction is a probability, not a guarantee.** `get_business_profile`
tells the model it is REQUIRED before invoicing. Measured over five runs on
`claude-opus-5`, it is honoured four times out of five — the outlier went
straight to `create_invoice`, choosing VAT treatment without reading the
issuer's regime. That is why issuing is gated in the server rather than
described in prose: anything that must always happen has to be enforced, not
requested. If profile-first ever needs to be a hard guarantee, it needs the same
treatment.

MIT-licensed. Source: <https://github.com/descodify/mcp>.
