# @descodify/mcp

Model Context Protocol server for [Descodify](https://app.descodify.pt) — drive
**certified Portuguese invoicing**, customers and products from your AI (Claude
Desktop, Claude Code, Cursor, or any MCP client), by natural language.

It's a thin, open-source wrapper over Descodify's public `/api/v1`. The server
runs locally over stdio; your org is resolved from the API key, so there is no
extra hosting or OAuth — calls land on the same certified path as the app UI.

## Setup

1. In Descodify, go to **Settings → Developers** and create an API key
   (`dsc_live_…`), granting the scopes you need (`customers`, `products`,
   `invoices`, read and/or write). Copy the secret — it's shown once.
2. Add the server to your MCP client config:

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

   `DESCODIFY_BASE_URL` is optional (defaults to `https://app.descodify.pt`); set
   it to point at a self-hosted or dev instance.

## Tools

Field names, money-in-cents and VAT-in-percent match the API's OpenAPI document
(`GET /api/v1/openapi.json`).

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
this with the public **`descodify`** skill in [`skill/`](skill) of this repo
(published to [skills.sh](https://skills.sh)) — it encodes the guardrails
(confirm-before-issue, credit-note-not-edit, defer tax facts to Descodify).

## Development

```sh
bun install       # or npm install
bun run build     # tsc → dist/
```

MIT-licensed. Source: <https://github.com/descodify/mcp>.
