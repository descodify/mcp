/**
 * Registers the Descodify MCP tool surface. Every tool is a thin wrapper over
 * an `/api/v1` endpoint (see ../README.md for the mapping). Field names are the
 * camelCase the API actually ships (per its OpenAPI 3.1 document), money is
 * integer cents, VAT rates integer percent.
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
  unitPrice: z.number().int().min(0).describe("Unit price in cents."),
  unit: z.string().describe('e.g. "unit", "hour", "kg".'),
  vatTier: z.enum(["normal", "intermediate", "reduced", "exempt"]),
  itemType: z.enum(["goods", "services"]),
};

const invoiceItem = z.object({
  productId: z.string().nullish().describe("Optional — reference an existing product."),
  description: z.string(),
  quantity: z.number().int().min(1),
  unitPrice: z.number().int().min(0).describe("Cents."),
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

export function registerTools(server: McpServer, client: DescodifyClient): void {
  // ── Business profile ──────────────────────────────────────────────────────
  server.registerTool(
    "get_business_profile",
    {
      title: "Get business profile",
      description:
        "Read the issuer's identity and VAT regime (name, NIF, regime, series). Call this FIRST before constructing invoices — the correct invoice type and VAT treatment depend on the issuer's regime.",
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
      inputSchema: { ...invoiceFields, action: z.enum(["issue"]).optional() },
    },
    (args) =>
      run(() =>
        client.request("/invoices", {
          method: "POST",
          body: args.action === "issue" ? { ...invoiceBody(args), action: "issue" } : invoiceBody(args),
          // Idempotency is required when issuing so a retry can't mint a second certified invoice.
          idempotencyKey: args.action === "issue" ? randomUUID() : undefined,
        }),
      ),
  );
  server.registerTool(
    "issue_invoice",
    {
      title: "Issue invoice (IRREVERSIBLE)",
      description:
        "Issue a draft invoice through the certified path (series, digital signature, ATCUD/QR, AT communication). " +
        "This produces a legally certified invoice with a permanent sequential number that CANNOT be edited or deleted — only corrected via a credit note. " +
        "NEVER call this without the user's explicit confirmation of the line items and totals.",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(() => client.request(`/invoices/${id}/issue`, { method: "POST", idempotencyKey: randomUUID() })),
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
