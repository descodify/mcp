/**
 * Registers the Descodify MCP tool surface. Every tool is a thin wrapper over
 * an `/api/v1` endpoint (see ../README.md for the mapping). Field names are the
 * camelCase the API actually ships (per its OpenAPI 3.1 document) and VAT rates
 * are integer percent. Money is `unitPrice`, a decimal string ("80.00") in the
 * INVOICE'S currency (`currencyCode`, default EUR),
 * passed through verbatim: /api/v1 accepts it directly and does the conversion
 * to its stored unit, so this wrapper has no money arithmetic to get wrong.
 *
 * Fiscal safety: `issue_invoice` (and `create_invoice` with `action:"issue"`)
 * mint a legally certified, AT-communicated invoice with a permanent sequential
 * number — irreversible, correctable only via a credit note. Those tools carry
 * a fresh `Idempotency-Key` per call so an agent retry can never mint a second
 * certified document, and their descriptions warn the model to confirm with the
 * human before issuing.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError, type DescodifyClient } from "./client.js";

const PAGINATION = {
  cursor: z.string().optional().describe("Opaque next-page token from a previous list call's next_cursor."),
  limit: z.number().int().min(1).max(100).optional().describe("Page size, 1–100 (default 25)."),
  q: z.string().optional().describe("Case-insensitive search."),
};

const customerFields = {
  customerType: z.enum(["business", "private"]),
  name: z.string(),
  country: z.string().describe("ISO 3166-1 alpha-2, e.g. PT."),
  email: z.string().nullish(),
  city: z.string().nullish(),
  address: z.string().nullish(),
  postalCode: z.string().nullish(),
  phone: z.string().nullish(),
  paymentTerms: z.enum(["immediate", "net15", "net30", "net60", "custom"]).optional(),
  paymentTermsDays: z.number().int().min(1).optional(),
  preferredLanguage: z.enum(["pt", "en"]).optional(),
  vatNumber: z.string().nullish().describe("Business customers — EU VAT number."),
  businessRegNumber: z.string().nullish().describe("Business customers."),
  personalIdType: z.enum(["nif", "other"]).optional().describe("Private customers."),
  personalIdNumber: z.string().nullish().describe("Private customers."),
};

const productFields = {
  name: z.string(),
  description: z.string().nullish(),
  unitPrice: z
    .string()
    .describe(
      'Unit price net of tax, as a decimal string — "80.00", "1.789". The catalogue is priced in EUR; only an invoice carries a currency, and a product added to a foreign-currency invoice is converted at that document\'s rate. The API takes this field verbatim.',
    ),
  unit: z.string().describe('e.g. "unit", "hour", "kg".'),
  vatTier: z.enum(["normal", "intermediate", "reduced", "exempt"]),
  itemType: z.enum(["goods", "services"]),
};

const invoiceItem = z.object({
  productId: z.string().nullish().describe("Optional — reference an existing product."),
  description: z.string(),
  quantity: z.number().int().min(1),
  unitPrice: z
    .string()
    .describe(
      'Unit price net of tax, as a decimal string — "80.00", "1.789". IN THE INVOICE\'S CURRENCY, which currencyCode sets once for the whole document and which defaults to EUR: on a USD invoice "80.00" means 80.00 USD, and the server derives the euro figures the document is signed and reported in. The API takes this field verbatim.',
    ),
  vatRate: z.number().int().min(0).describe("VAT rate as a percent (23 = 23%)."),
  vatExemptionCode: z.string().nullish().describe("Required when vatRate is 0."),
  itemType: z.enum(["goods", "services"]),
});

const invoiceFields = {
  invoiceType: z
    .enum(["invoice", "invoice_receipt", "simplified", "credit_note", "debit_note", "receipt", "receipt_vat_cash"])
    .describe("FT / FR / FS / NC / ND / RG / RC."),
  customerId: z.string().nullish(),
  issueDate: z.string().nullish().describe("YYYY-MM-DD."),
  dueDate: z.string().nullish().describe("YYYY-MM-DD."),
  paymentMethod: z.string().nullish(),
  originalInvoiceId: z.string().nullish().describe("Required for credit/debit notes."),
  reason: z.string().nullish(),
  notes: z.string().nullish(),
  withholdingRate: z.number().int().nullish().describe("Basis points (2300 = 23%)."),
  currencyCode: z
    .string()
    .length(3)
    .optional()
    .describe(
      'ISO 4217 currency the invoice is AGREED in — defaults to EUR. This is the one field that says what every price on the request means: on a USD invoice the line prices are USD, and the server derives the EUR the document is signed and reported in, printing the euro equivalent and the rate on the document as Portuguese law requires. Must be a currency the ECB publishes a daily reference rate for.',
    ),
  exchangeRate: z
    .string()
    .nullish()
    .describe(
      "Only for a contractually fixed rate: EUR per one unit of currencyCode, as a decimal string. Omit it and the server resolves the ECB rate for the invoice's date, which is what you almost always want.",
    ),
  items: z.array(invoiceItem).min(1),
};

/** Runs a client call and wraps failures as an MCP tool error the model can read. */
async function run(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return {
      content: [{ type: "text" as const, text: result === undefined ? "OK" : JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof ApiError) {
      const detail = err.details ? `\n${JSON.stringify(err.details, null, 2)}` : "";
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error (${err.status} ${err.type}): ${err.message}${detail}` }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Unexpected error: ${(err as Error).message}` }],
    };
  }
}

/** Splits the `action` flag off an invoice body so it is only sent when issuing. */
function invoiceBody(args: Record<string, unknown>) {
  const { action: _action, ...body } = args;
  return body;
}

// ── Issuing confirmation gate ───────────────────────────────────────────────
// Issuing is the one irreversible act in this surface: it mints a legally
// certified invoice with a permanent sequential number. A description asking
// the model to "confirm with the user first" is honoured by strong models and
// ignored by weaker ones — measured, not assumed: with that wording removed,
// claude-haiku-4-5 issued an invoice off "Bill Acme 800 euros" with no
// confirmation at all (golden-eval.mjs, case `prepare-not-issue`). So the
// server enforces confirmation structurally instead of trusting the prose.
//
// Two paths, because MCP clients differ:
//   1. The client supports elicitation -> ask the HUMAN directly and issue only
//      on an explicit accept. This is a real human gate.
//   2. It does not -> hand back a one-shot token with the full invoice summary
//      and refuse until that exact token comes back. This cannot reach the
//      human by itself, but it makes a single-shot silent issue impossible and
//      forces the totals into the transcript where the human can see them.
//
// Note for the 2026-07-28 migration: elicitation's server-initiated request is
// replaced by the Multi Round-Trip Requests pattern. Path 1 moves to MRTR when
// the SDK ships support; path 2 is unaffected.
const ISSUE_CONFIRM_TTL_MS = 10 * 60 * 1000;
const pendingIssue = new Map<string, { token: string; expiresAt: number }>();

/**
 * The currency a document is denominated in. Defaults to EUR, which is what an
 * invoice with no `currencyCode` is.
 *
 * Every amount in the confirmation summary passes through this. Printing "EUR"
 * beside a USD figure would be a unit lie in the one piece of text a human
 * approves before an irreversible mint — the same class of mistake the API
 * removed when it stopped calling the input field `unitPriceEur`.
 */
function documentCurrency(inv: Record<string, unknown>): string {
  const code = inv.currencyCode;
  return typeof code === "string" && code.trim() ? code.trim().toUpperCase() : "EUR";
}

function formatCents(v: unknown, currency = "EUR"): string {
  return typeof v === "number" ? `${(v / 100).toFixed(2)} ${currency}` : "unknown";
}

/**
 * A line's unit price, from either shape the summary can be built from: a
 * fetched invoice carries `unitPriceMicros` (the stored unit), while a
 * create-and-issue request carries the `unitPrice` string the caller sent.
 * Both must render, because this text is what a human approves before an
 * irreversible mint — showing "unknown" there would be worse than not asking.
 *
 * Trailing zeros are trimmed so a plain price reads "80.00" rather than
 * "80.000000", while a discount-apportioned one keeps its real precision
 * ("0.5016"): the human must see what is actually on the document.
 */
function formatUnitPrice(item: Record<string, unknown>, currency = "EUR"): string {
  // A fetched invoice carries the FOREIGN micros when it has them: that is the
  // price the parties agreed, and it is what the human is being asked about.
  // `unitPriceMicros` beside it is the derived EUR, which would read as the
  // wrong number under a USD heading.
  const micros =
    typeof item.unitPriceForeignMicros === "number"
      ? item.unitPriceForeignMicros
      : item.unitPriceMicros;
  if (typeof micros === "number") {
    return `${(micros / 1_000_000).toFixed(6).replace(/(\.\d\d)(\d*?)0+$/, "$1$2")} ${currency}`;
  }
  const typed = item.unitPrice;
  if (typeof typed === "string" && typed.trim()) return `${typed.trim()} ${currency}`;
  return "unknown";
}

/** The facts a human must check before an irreversible mint. */
function summariseInvoice(inv: Record<string, unknown>): string {
  const currency = documentCurrency(inv);
  const items = Array.isArray(inv.items) ? inv.items : [];
  const lines = items.map((raw) => {
    const it = raw as Record<string, unknown>;
    return `    - ${String(it.description ?? "item")} x ${String(it.quantity ?? "?")} @ ${formatUnitPrice(it, currency)}`;
  });
  return [
    `  Invoice:  ${String(inv.invoiceNumber ?? inv.id ?? "(not yet created)")}`,
    `  Type:     ${String(inv.invoiceType ?? "invoice")}`,
    `  Customer: ${String(inv.customerId ?? "-")}`,
    `  Total:    ${
      currency === "EUR"
        ? formatCents(inv.amountCents)
        : `${formatCents(inv.currencyAmountCents, currency)} (${formatCents(inv.amountCents)})`
    }`,
    lines.length ? `  Lines:\n${lines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type Gate = { ok: true } | { ok: false; message: string };

async function gateIssuing(
  server: McpServer,
  key: string,
  summary: string,
  confirmationToken: string | undefined,
): Promise<Gate> {
  if (server.server.getClientCapabilities()?.elicitation) {
    const res = await server.server.elicitInput({
      message:
        "IRREVERSIBLE — issuing mints a legally certified invoice with a permanent sequential number. " +
        "It cannot be edited or deleted afterwards, only corrected with a credit note.\n\n" +
        `${summary}\n\nConfirm to issue.`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "Issue this invoice",
            description: "Confirm the customer, line items and total above are correct.",
          },
        },
        required: ["confirm"],
      },
    });
    if (res.action !== "accept" || res.content?.confirm !== true) {
      return { ok: false, message: `Issuing cancelled by the user (${res.action}). The invoice was NOT issued.` };
    }
    return { ok: true };
  }

  const now = Date.now();
  const pending = pendingIssue.get(key);
  if (confirmationToken && pending && pending.token === confirmationToken && pending.expiresAt > now) {
    pendingIssue.delete(key); // one-shot: a retry needs a fresh confirmation
    return { ok: true };
  }

  // Reuse a live pending confirmation rather than minting a new token. A wrong
  // or mistyped token must not rotate the one the user has already been shown,
  // or their approval becomes unusable and the correct retry fails forever.
  const live = pending && pending.expiresAt > now ? pending : undefined;
  const token = live?.token ?? randomUUID();
  pendingIssue.set(key, { token, expiresAt: live?.expiresAt ?? now + ISSUE_CONFIRM_TTL_MS });
  return {
    ok: false,
    message:
      "CONFIRMATION REQUIRED — nothing has been issued yet.\n\n" +
      "Issuing mints a legally certified invoice with a permanent sequential number that cannot be " +
      "edited or deleted, only corrected with a credit note.\n\n" +
      `${summary}\n\n` +
      "Show these details to the user and get their explicit approval. Only once they have approved, " +
      `call this tool again with confirmationToken: "${token}". Do not call it again without their answer.`,
  };
}

function gateBlocked(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function registerTools(server: McpServer, client: DescodifyClient): void {
  // ── Business profile ──────────────────────────────────────────────────────
  server.registerTool(
    "get_business_profile",
    {
      title: "Get business profile",
      description:
        "Read the issuer's identity and VAT regime (name, NIF, regime, series). " +
        "REQUIRED before create_invoice or issue_invoice: the issuer's regime determines the correct invoice type " +
        "and VAT treatment, and an invoice built without it can be fiscally wrong. " +
        "Call this first in any conversation that will create or issue an invoice — do not infer the regime, do not " +
        "reuse an assumption from earlier, and do not skip it because the request looks simple.",
      inputSchema: {},
    },
    () => run(() => client.request("/business-profile")),
  );

  // ── Customers ─────────────────────────────────────────────────────────────
  server.registerTool(
    "list_customers",
    { title: "List customers", description: "List the org's customers (cursor-paginated).", inputSchema: PAGINATION },
    (args) => run(() => client.request("/customers", { query: args })),
  );
  server.registerTool(
    "get_customer",
    { title: "Get customer", description: "Fetch one customer by id.", inputSchema: { id: z.string() } },
    ({ id }) => run(() => client.request(`/customers/${id}`)),
  );
  server.registerTool(
    "create_customer",
    {
      title: "Create customer",
      description:
        "Create a customer. Set verifyVat=true to validate an EU VAT number against VIES (fail-open). Resolve or create the customer before issuing an invoice to them.",
      inputSchema: { ...customerFields, verifyVat: z.boolean().optional() },
    },
    ({ verifyVat, ...body }) =>
      run(() => client.request("/customers", { method: "POST", body, query: verifyVat ? { verify_vat: true } : {} })),
  );
  server.registerTool(
    "update_customer",
    {
      title: "Update customer",
      description:
        "Update a customer (full representation replace). The tax ID freezes once the customer is referenced by a non-draft invoice.",
      inputSchema: { id: z.string(), ...customerFields },
    },
    ({ id, ...body }) => run(() => client.request(`/customers/${id}`, { method: "PATCH", body })),
  );
  server.registerTool(
    "delete_customer",
    { title: "Delete customer", description: "Delete a customer.", inputSchema: { id: z.string() } },
    ({ id }) => run(() => client.request(`/customers/${id}`, { method: "DELETE" })),
  );

  // ── Products ──────────────────────────────────────────────────────────────
  server.registerTool(
    "list_products",
    { title: "List products", description: "List the org's products (cursor-paginated).", inputSchema: PAGINATION },
    (args) => run(() => client.request("/products", { query: args })),
  );
  server.registerTool(
    "get_product",
    { title: "Get product", description: "Fetch one product by id.", inputSchema: { id: z.string() } },
    ({ id }) => run(() => client.request(`/products/${id}`)),
  );
  server.registerTool(
    "create_product",
    { title: "Create product", description: "Create a product/service catalogue entry.", inputSchema: productFields },
    (body) => run(() => client.request("/products", { method: "POST", body })),
  );
  server.registerTool(
    "update_product",
    {
      title: "Update product",
      description: "Update a product (full representation replace).",
      inputSchema: { id: z.string(), ...productFields },
    },
    ({ id, ...body }) => run(() => client.request(`/products/${id}`, { method: "PATCH", body })),
  );
  server.registerTool(
    "delete_product",
    { title: "Delete product", description: "Delete a product.", inputSchema: { id: z.string() } },
    ({ id }) => run(() => client.request(`/products/${id}`, { method: "DELETE" })),
  );

  // ── Invoices ──────────────────────────────────────────────────────────────
  server.registerTool(
    "list_invoices",
    {
      title: "List invoices",
      description: "List invoices (cursor-paginated). Filter by status (draft/issued/cancelled), year, or q.",
      inputSchema: {
        ...PAGINATION,
        status: z.enum(["draft", "issued", "cancelled"]).optional(),
        year: z.number().int().optional(),
        tab: z.enum(["outstanding"]).optional(),
      },
    },
    (args) => run(() => client.request("/invoices", { query: args })),
  );
  server.registerTool(
    "get_invoice",
    {
      title: "Get invoice",
      description: "Fetch one invoice — header, line items, certification fields (hash/atcud/qr) and at_comm_status.",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(() => client.request(`/invoices/${id}`)),
  );
  server.registerTool(
    "create_invoice",
    {
      title: "Create invoice",
      description:
        "Create a DRAFT invoice. Prefer this, then confirm line items and totals with the user, then call issue_invoice. " +
        'Pass action:"issue" to create-and-issue in one step ONLY after the user has explicitly approved issuing — that mints a legally certified, irreversible invoice.',
      inputSchema: {
        ...invoiceFields,
        action: z.enum(["issue"]).optional(),
        confirmationToken: z
          .string()
          .optional()
          .describe("Only for action:\"issue\" — the token returned by a prior confirmation-required response."),
      },
    },
    async (args) => {
      const { confirmationToken, ...rest } = args;
      const body = invoiceBody(rest);
      if (rest.action === "issue") {
        // Create-and-issue is the same irreversible act as issue_invoice, so it
        // goes through the same gate — summarised from the request, since the
        // invoice does not exist yet.
        const gate = await gateIssuing(
          server,
          `create:${JSON.stringify(body)}`,
          summariseInvoice({ ...body, amountCents: undefined }),
          confirmationToken,
        );
        if (!gate.ok) return gateBlocked(gate.message);
      }
      return run(() =>
        client.request("/invoices", {
          method: "POST",
          body: rest.action === "issue" ? { ...body, action: "issue" } : body,
          // Idempotency is required when issuing so a retry can't mint a second certified invoice.
          idempotencyKey: rest.action === "issue" ? randomUUID() : undefined,
        }),
      );
    },
  );
  server.registerTool(
    "issue_invoice",
    {
      title: "Issue invoice (IRREVERSIBLE)",
      description:
        "Issue a draft invoice through the certified path (series, digital signature, ATCUD/QR, AT communication). " +
        "This produces a legally certified invoice with a permanent sequential number that CANNOT be edited or deleted — only corrected via a credit note. " +
        "NEVER call this without the user's explicit confirmation of the line items and totals. " +
        "The server enforces this: the first call returns the invoice summary and a confirmationToken and issues " +
        "nothing. Show that summary to the user, and only after they approve, call again with the token.",
      inputSchema: {
        id: z.string(),
        confirmationToken: z
          .string()
          .optional()
          .describe("The token returned by a prior confirmation-required response for this same invoice."),
      },
    },
    async ({ id, confirmationToken }) => {
      // Read the invoice first so the confirmation shows what will actually be
      // minted, rather than trusting the model's paraphrase of it.
      let summary = `  Invoice: ${id}`;
      try {
        const inv = (await client.request(`/invoices/${id}`)) as Record<string, unknown>;
        summary = summariseInvoice(inv);
      } catch {
        // A read failure must not open the gate; confirm against the id alone.
      }
      const gate = await gateIssuing(server, `issue:${id}`, summary, confirmationToken);
      if (!gate.ok) return gateBlocked(gate.message);
      return run(() => client.request(`/invoices/${id}/issue`, { method: "POST", idempotencyKey: randomUUID() }));
    },
  );
  server.registerTool(
    "cancel_invoice",
    {
      title: "Cancel invoice",
      description:
        "Cancel an invoice with a reason. To correct an ISSUED invoice, create a credit note (create_invoice with invoiceType:credit_note + originalInvoiceId) instead of cancelling.",
      inputSchema: { id: z.string(), reason: z.string() },
    },
    ({ id, reason }) => run(() => client.request(`/invoices/${id}/cancel`, { method: "POST", body: { reason } })),
  );
  server.registerTool(
    "get_invoice_pdf",
    {
      title: "Get invoice PDF",
      description: "Get a link to the certified PDF of an issued/cancelled invoice (returns { url }).",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(() => client.request(`/invoices/${id}/pdf`)),
  );
}
