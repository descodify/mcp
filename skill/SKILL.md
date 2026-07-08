---
name: descodify
description: Issue certified Portuguese invoices and manage customers/products with Descodify — via its MCP server or its REST API directly. Use when the user wants to create, issue, cancel, or look up a fatura / recibo / invoice in Portugal, manage recibos-verdes clients, or drive Descodify by natural language. Triggers on certified invoice, fatura, fatura-recibo, recibo verde, ATCUD, IVA invoice, "issue an invoice in Portugal", Descodify.
license: MIT
---

# Driving Descodify — certified Portuguese invoicing

[Descodify](https://app.descodify.pt) issues **legally certified** invoices for
Portuguese solo entrepreneurs (regime simplificado / recibos verdes): each issued
invoice is signed, gets a permanent sequential number + ATCUD + QR code, and is
communicated to the Tax Authority (AT). This skill tells you how to drive it
safely. The tax computation is Descodify's job — your job is to gather the right
inputs, confirm with the user, and never issue without approval.

## Two equivalent ways to reach it

Descodify exposes the **same operations** two ways — use whichever your client
supports; the flow and rules below are identical for both:

- **MCP** — if the `@descodify/mcp` server is configured, each operation below is
  one of its tools.
- **Direct HTTP** — otherwise call the REST API at
  `https://app.descodify.pt/api/v1` with `Authorization: Bearer dsc_live_…`. The
  machine-readable contract — every endpoint, parameter, field, and error — is at
  **`GET /api/v1/openapi.json`** (public, no key). Treat it as the source of truth
  for all wire details; don't hardcode shapes from memory.

Either way the user needs an **org-scoped API key** created in Descodify →
**Settings → Developers** (with the `customers` / `products` / `invoices` scopes,
read and/or write). If no key is configured, tell the user how to create one and
**stop** — do not attempt any write.

Conventions (both paths, per `openapi.json`): money is integer **cents**, VAT
rates integer **percent**, field names **camelCase**, lists cursor-paginated
(`{ data, next_cursor }`).

## Operations available

- **Business profile** — read the issuer's identity + VAT regime.
- **Customers** — search/list, get, create (optionally verifying an EU VAT number
  against VIES), update, delete.
- **Products** — list, get, create, update, delete.
- **Invoices** — list, get, create as a draft, issue, cancel, fetch the certified
  PDF, and create a credit/debit note referencing an original invoice.

## The safe flow

1. **Read the business profile first.** It tells you the issuer's identity and VAT
   regime — the correct invoice type and VAT treatment depend on it. Don't guess
   the regime.
2. **Find or create the customer.** Search existing customers first; create one
   only if it doesn't exist. For an EU-VAT business customer, verify the VAT
   number against VIES as part of creation.
3. **Create the invoice as a draft.** Build the line items from what the user
   gave you; reference an existing product where possible.
4. **Confirm line items and totals with the user in plain language** — amounts,
   VAT, customer, invoice type. This is the review gate.
5. **Only after explicit approval, issue the draft.** This is irreversible.

## Non-negotiable fiscal rules

- **Issuing is irreversible.** An issued invoice has a permanent sequential number
  and cannot be edited or deleted. Never issue (including any "create and issue in
  one step" shortcut) without the user's explicit go-ahead on the exact contents.
- **Correct an issued invoice with a credit note, never a mutation.** To fix or
  reverse an issued invoice, create a credit note referencing the original invoice
  and issue it. Editing or deleting only works on drafts.
- **Cancelling needs a reason** and applies to drafts / not-yet-delivered
  invoices; a delivered issued invoice is corrected via a credit note.
- **The tax ID freezes** once a customer is used on a non-draft invoice — you
  can't change their NIF/VAT number afterward.
- **Idempotency on issue.** Over MCP the server attaches an idempotency key
  automatically. On the direct HTTP path, send a fresh `Idempotency-Key: <uuid>`
  on every issue (and on any create-and-issue call) so a network retry can't mint
  a second certified invoice.

## Don't invent tax facts

Do **not** state Portuguese VAT rates, coefficients, withholding rates, or
thresholds from memory — they change and getting them wrong is high-stakes.
Descodify computes the correct VAT and totals from the issuer's regime; take the
numbers it returns, and for fiscal questions point the user to the product rather
than asserting a rate yourself.

## Errors

Every error is `{ error: { type, message, details? } }`; surface `message`:

- `401 invalid_api_key` — the key is missing/revoked/expired; tell the user to
  check Settings → Developers.
- `403 insufficient_scope` — the key lacks the scope named in the message; the
  user must create a key with that scope.
- `409 at_not_ready` — the org hasn't connected to the AT yet; the draft is
  preserved. Tell the user to connect AT in Settings, then retry the issue.
- `422` — validation failed; the failing rules are in `details`. Fix the draft
  and retry.
- `429` — rate limited; wait for the `Retry-After` interval.

Full reference: `GET /api/v1/openapi.json` and <https://app.descodify.pt/developers>.
