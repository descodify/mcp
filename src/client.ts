/**
 * Thin HTTP client over Descodify's public `/api/v1` surface.
 *
 * Every call sends `Authorization: Bearer dsc_live_…` and maps the API's error
 * envelope (`{ error: { type, message, details? } }`) to a thrown `ApiError`
 * carrying the HTTP status, so the tool layer can surface `message` verbatim to
 * the model. This mirrors the first-party `lib/api/fetch.ts` contract.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly details: unknown;
  constructor(status: number, type: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.details = details;
  }
}

export interface ClientOptions {
  apiKey: string;
  /** Defaults to https://app.descodify.pt — override for a dev instance. */
  baseUrl?: string;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** When set, sent as the Idempotency-Key header (required on issue). */
  idempotencyKey?: string;
  /** Accept header override — the PDF route returns `{ url }` under JSON. */
  accept?: string;
}

const DEFAULT_BASE_URL = "https://app.descodify.pt";

export class DescodifyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    // Trim a trailing slash so `${baseUrl}/api/v1/...` never doubles up.
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: opts.accept ?? "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (cause) {
      // Network / DNS / TLS — surface the base URL so the user can check it.
      throw new ApiError(
        0,
        "network_error",
        `Could not reach Descodify at ${this.baseUrl}: ${(cause as Error).message}`,
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;

    if (!response.ok) {
      const env = (payload as { error?: { type?: string; message?: string; details?: unknown } })?.error;
      throw new ApiError(
        response.status,
        env?.type ?? "error",
        env?.message ?? `Request failed with status ${response.status}.`,
        env?.details,
      );
    }

    return payload as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
