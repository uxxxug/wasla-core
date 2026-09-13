export type Currency = string;
export type WalletOwnerType = "identity" | "organization";
export type WalletStatus = "active" | "frozen" | "closed";
/**
 * `partially_captured` is a fourth state, not a convenience.
 *
 * A hold whose remainder was released after part of it moved cannot be
 * described by the other three without lying: `captured` overstates what
 * moved, and `voided` claims nothing moved when some did. See migration 0009.
 */
export type AuthorizationStatus =
  | "authorized"
  | "captured"
  | "partially_captured"
  | "voided";

export interface Wallet {
  wallet_id: string;
  owner_type: WalletOwnerType;
  owner_id: string;
  currency: Currency;
  status: WalletStatus;
  created_at: string;
}

export interface PaymentAuthorization {
  authorization_id: string;
  wallet_id: string;
  /** The ceiling the payer consented to. Immutable once created. */
  amount_minor: number;
  /** How much has actually moved. Grows, never shrinks. */
  captured_minor: number;
  /** How much has moved back. Grows, never shrinks, and never un-captures. */
  refunded_minor: number;
  currency: Currency;
  status: AuthorizationStatus;
  business_reference: string;
  created_at: string;
  captured_at: string | null;
  voided_at: string | null;
  /** Optional hold expiry (ADR 0005). Past this instant a hold may only be voided. */
  expires_at: string | null;
  void_reason: string | null;
}

export interface LedgerEntry {
  entry_id: string;
  transaction_id: string;
  account_reference: string;
  amount_minor: number;
  currency: Currency;
}

export interface LedgerTransaction {
  transaction_id: string;
  kind: "credit" | "capture" | "refund";
  business_reference: string;
  /**
   * Which hold this movement belongs to. Null only for a credit, which has no
   * authorization. A foreign key rather than something parsed back out of
   * `business_reference`, so the aggregate columns on the authorization cannot
   * drift from the ledger unnoticed — money that can disagree with its own
   * audit trail is money nobody can reconcile.
   */
  authorization_id: string | null;
  occurred_at: string;
  entries: readonly LedgerEntry[];
}

/**
 * The amount still reserved on a hold.
 *
 * Derived rather than stored, so it cannot disagree with the two columns it is
 * computed from. Zero for any closed authorization.
 */
export function remainingHold(authorization: PaymentAuthorization): number {
  if (authorization.status !== "authorized") return 0;
  return authorization.amount_minor - authorization.captured_minor;
}

/** What may still be given back on a hold. */
export function refundableAmount(authorization: PaymentAuthorization): number {
  return authorization.captured_minor - authorization.refunded_minor;
}

export function normalizeCurrency(value: string): Currency {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be an ISO 4217 code");
  return currency;
}

/**
 * The `ledger_transaction_balance` constraint trigger, restated.
 *
 * Postgres defers this to commit and names the transaction in the refusal:
 * `ledger transaction % is not balanced`, grouped per currency. The reference
 * backend checks it eagerly, and that is not a difference a caller can observe
 * through the port: `insertTransaction` takes a header with all of its entries
 * nested inside it, so a transaction is never half-written the way it can be
 * across two `INSERT` statements in one SQL transaction. The wording is matched
 * so the two backends' stack traces read the same; the timing difference is
 * recorded in `docs/trigger-parity.md` rather than papered over.
 */
export function assertBalanced(entries: readonly LedgerEntry[]): void {
  if (entries.length < 2) throw new Error("ledger transaction requires at least two entries");
  const id = entries[0]?.transaction_id ?? "unknown";
  const currencies = new Set(entries.map((entry) => entry.currency));
  // Stricter than the trigger on purpose: Postgres sums per currency, so two
  // currencies each balancing to zero would pass there. CORE has no
  // multi-currency transaction, and `ledger_entry_currency_matches_transaction`
  // is why — refusing the mix here keeps the reference backend from accepting a
  // shape no caller may write.
  if (currencies.size !== 1) throw new Error("ledger transaction cannot mix currencies");
  if (entries.reduce((sum, entry) => sum + entry.amount_minor, 0) !== 0) {
    throw new Error(`ledger transaction ${id} is not balanced`);
  }
}