export type Currency = string;
export type WalletOwnerType = "identity" | "organization";
export type WalletStatus = "active" | "frozen" | "closed";
export type AuthorizationStatus = "authorized" | "captured" | "voided";

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
  amount_minor: number;
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
  kind: "credit" | "capture";
  business_reference: string;
  occurred_at: string;
  entries: readonly LedgerEntry[];
}

export function normalizeCurrency(value: string): Currency {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be an ISO 4217 code");
  return currency;
}

export function assertBalanced(entries: readonly LedgerEntry[]): void {
  if (entries.length < 2) throw new Error("ledger transaction requires at least two entries");
  const currencies = new Set(entries.map((entry) => entry.currency));
  if (currencies.size !== 1) throw new Error("ledger transaction cannot mix currencies");
  if (entries.reduce((sum, entry) => sum + entry.amount_minor, 0) !== 0) {
    throw new Error("ledger transaction is not balanced");
  }
}