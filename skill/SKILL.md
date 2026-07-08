---
name: descodify
description: Issue certified Portuguese invoices and manage customers/products via Descodify's API or MCP server. Use when the user wants to create, issue, cancel, or look up a fatura / recibo / invoice in Portugal, manage recibos-verdes clients, or drive Descodify by natural language. Triggers on certified invoice, fatura, fatura-recibo, recibo verde, ATCUD, IVA invoice, "issue an invoice in Portugal", Descodify.
license: MIT
---

# Driving Descodify — certified Portuguese invoicing

[Descodify](https://app.descodify.pt) issues **legally certified** invoices for
Portuguese solo entrepreneurs (regime simplificado / recibos verdes): each issued
invoice is signed, gets a permanent sequential number + ATCUD + QR code, and is
communicated to the Tax Authority (AT). This skill tells you how to drive it
safely. The tax computation is Descodify's job — your job is to gather the right
inputs, confirm with the user, and never issue without approval.

## How to connect

Prefer the **`@descodify/mcp`** server (tools like `create_invoice`,
`issue_invoice`, `list_customers`). If it isn't configured, call the REST API
directly at `https://app.descodify.pt/api/v1` with
`Authorization: Bearer dsc_live_…`; the OpenAPI document is at
`GET /api/v1/openapi.json`.

Either way the user needs an **org-scoped API key** created in Descodify →
**Settings → Developers** (choose the `customers` / `products` / `invoices`
scopes, read and/or write). If no key is configured, tell the user how to create
one and **stop** — do not attempt any write.

Conventions: money is integer **cents**, VAT rates integer **percent**, field
names are **camelCase** (`customerType`, `unitPrice`, `vatTier`). Lists are
cursor-paginated (`{ data, next_cursor }`).

## The safe flow

1. **Read the business profile first** (`get_business_profile`). It tells you the
   issuer's identity and VAT regime — the correct invoice type and VAT treatment
   depend on it. Don't guess the regime.
2. **Resolve the customer.** Search with `list_customers` (`q=`); create one with
   `create_customer` only if it doesn't exist. For an EU-VAT business customer,
   pass `verifyVat: true` to validate against VIES.
3. **Create a DRAFT** with `create_invoice` (omit `action`). Build the line items
   from what the user gave you; reference an existing product via `productId`
   where possible.
4. **Confirm line items and totals with the user in plain language** — amounts,
   VAT, customer, invoice type. This is the review gate.
5. **Only after explicit approval, issue** with `issue_invoice` (or re-create
   with `action:"issue"`). This is irreversible.

## Non-negotiable fiscal rules

- **Issuing is irreversible.** An issued invoice has a permanent sequential
  number and cannot be edited or deleted. Never call `issue_invoice` (or
  `create_invoice` with `action:"issue"`) without the user's explicit go-ahead on
  the exact contents.
- **Correct an issued invoice with a credit note, never a mutation.** To fix or
  reverse an issued invoice, create a `credit_note` (`create_invoice` with
  `invoiceType:"credit_note"` and `originalInvoiceId`) and issue it. Do not try
  to PATCH or DELETE an issued invoice — only drafts are mutable.
- **Cancel needs a reason**, and cancelling is for drafts / not-yet-acted
  invoices; a delivered issued invoice is corrected via credit note.
- **The tax ID freezes** once a customer is used on a non-draft invoice — you
  can't change their NIF/VAT number afterward.
- **Idempotency on issue is automatic** via the MCP server. If you call the REST
  API directly, send a fresh `Idempotency-Key: <uuid>` on every issue so a retry
  can't mint a second certified invoice.

## Don't invent tax facts

Do **not** state Portuguese VAT rates, coefficients, withholding rates, or
thresholds from memory — they change and getting them wrong is high-stakes.
Descodify computes the correct VAT and totals from the issuer's regime; take the
numbers it returns, and for fiscal questions point the user to the product rather
than asserting a rate yourself.

## Errors you'll see

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

Full API reference: <https://app.descodify.pt/developers>.
