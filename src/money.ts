/**
 * Money parsing for the tool surface.
 *
 * The model is asked for a decimal euro STRING — "80.00", "1.789" — never an
 * integer in some sub-unit. That is deliberate: `/api/v1` takes invoice unit
 * prices in micro-euros (1 EUR = 1_000_000) so SAF-T can carry the 4-6 decimals
 * that a discount-apportioned unit price needs, and an LLM emitting 80000000
 * instead of 80 mints a legally certified invoice off by four orders of
 * magnitude with nothing downstream able to notice. The wrapper does the
 * multiplication once, in code, where it is tested.
 *
 * Parsing goes through BigInt rather than parseFloat: 1.789 * 1e6 is
 * 1788999.9999999998 in IEEE 754, and truncating that loses a micro on a signed
 * document.
 */

/** Digits, optional decimal part, nothing else. No sign, no exponent, no separators. */
const DECIMAL = /^(\d+)(?:[.,](\d+))?$/;

function parseDecimal(value: string, field: string, scale: number, scaleName: string): number {
  const raw = value.trim();
  const m = DECIMAL.exec(raw);
  if (!m) {
    throw new Error(
      `${field} must be a decimal amount in euros as a string, e.g. "80.00" or "1.789" — got ${JSON.stringify(value)}.`,
    );
  }
  const frac = m[2] ?? "";
  if (frac.length > scale) {
    throw new Error(
      `${field} has ${frac.length} decimal places; ${scaleName} supports at most ${scale}. Got ${JSON.stringify(value)}.`,
    );
  }
  const units = BigInt(m[1]) * BigInt(10 ** scale) + BigInt(frac.padEnd(scale, "0") || "0");
  return Number(units);
}

/** "80.00" -> 80_000_000 micro-euros. Up to six decimals, per SAF-T UnitPrice. */
export function eurosToMicros(value: string, field = "unitPrice"): number {
  return parseDecimal(value, field, 6, "micro-euro precision");
}

/** "80.00" -> 8000 cents. Up to two decimals — cents cannot express more. */
export function eurosToCents(value: string, field = "unitPrice"): number {
  return parseDecimal(value, field, 2, "a cents field");
}
