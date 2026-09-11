import {
  journalMapWrite,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
import type { LedgerTransaction, PaymentAuthorization, Wallet } from "./domain.js";

export interface MoneyRepository {
  insertWallet(wallet: Wallet, scope: TransactionScope): Promise<void>;
  getWallet(walletId: string): Promise<Wallet | undefined>;
  findWallet(ownerType: Wallet["owner_type"], ownerId: string, currency: string): Promise<Wallet | undefined>;
  insertAuthorization(authorization: PaymentAuthorization, scope: TransactionScope): Promise<void>;
  getAuthorization(authorizationId: string): Promise<PaymentAuthorization | undefined>;
  findAuthorizationByReference(reference: string): Promise<PaymentAuthorization | undefined>;
  listAuthorizations(walletId: string): Promise<readonly PaymentAuthorization[]>;
  allAuthorizations(): Promise<readonly PaymentAuthorization[]>;
  updateAuthorization(authorization: PaymentAuthorization, scope: TransactionScope): Promise<void>;
  insertTransaction(transaction: LedgerTransaction, scope: TransactionScope): Promise<void>;
  findTransactionByReference(reference: string): Promise<LedgerTransaction | undefined>;
  transactions(): Promise<readonly LedgerTransaction[]>;
}

/**
 * The reference money store.
 *
 * It enforces the uniqueness the schema declares, not just primary keys. That
 * is the whole reason this class re-states constraints that look redundant:
 * without them a `Map` lets two concurrent captures both insert a
 * `capture:<authorization_id>` ledger transaction and the money moves twice,
 * while Postgres refuses the second on `ledger_transaction_business_reference_key`
 * and rolls it back. A backend that is more permissive than production is a
 * backend that certifies bugs (B-12).
 */
export class InMemoryMoneyRepository implements MoneyRepository {
  private wallets = new Map<string, Wallet>();
  private authorizations = new Map<string, PaymentAuthorization>();
  private ledger = new Map<string, LedgerTransaction>();

  /**
   * The uniqueness checks below are deliberately synchronous.
   *
   * An `await` between reading and writing is enough to lose the race even in
   * a single-threaded runtime: two `capture` calls both suspend on the lookup,
   * both find nothing, and both then write. That is exactly how the first
   * version of this guard failed. Here "atomic" means no `await` between the
   * check and the `set`, so these helpers scan the maps directly instead of
   * calling the async finders.
   */
  private ledgerReferenceClash(transaction: LedgerTransaction): boolean {
    for (const existing of this.ledger.values()) {
      if (
        existing.business_reference === transaction.business_reference &&
        existing.transaction_id !== transaction.transaction_id
      ) {
        return true;
      }
    }
    return false;
  }

  async insertWallet(wallet: Wallet, _scope?: TransactionScope): Promise<void> {
    // UNIQUE (owner_type, owner_id, currency) — db/migrations/0002.
    let clash: Wallet | undefined;
    for (const existing of this.wallets.values()) {
      if (
        existing.owner_type === wallet.owner_type &&
        existing.owner_id === wallet.owner_id &&
        existing.currency === wallet.currency
      ) {
        clash = existing;
        break;
      }
    }
    if (clash && clash.wallet_id !== wallet.wallet_id) {
      throw new Error(
        "duplicate key value violates unique constraint \"wallet_owner_type_owner_id_currency_key\"",
      );
    }
    journalMapWrite(_scope, this.wallets, wallet.wallet_id);
    this.wallets.set(wallet.wallet_id, wallet);
  }
  async getWallet(walletId: string): Promise<Wallet | undefined> {
    return this.wallets.get(walletId);
  }
  async findWallet(ownerType: Wallet["owner_type"], ownerId: string, currency: string): Promise<Wallet | undefined> {
    return [...this.wallets.values()].find(
      (wallet) => wallet.owner_type === ownerType && wallet.owner_id === ownerId && wallet.currency === currency,
    );
  }
  async insertAuthorization(authorization: PaymentAuthorization, _scope?: TransactionScope): Promise<void> {
    // payment_authorization.business_reference is UNIQUE.
    let clash: PaymentAuthorization | undefined;
    for (const existing of this.authorizations.values()) {
      if (existing.business_reference === authorization.business_reference) {
        clash = existing;
        break;
      }
    }
    if (clash && clash.authorization_id !== authorization.authorization_id) {
      throw new Error(
        "duplicate key value violates unique constraint \"payment_authorization_business_reference_key\"",
      );
    }
    journalMapWrite(_scope, this.authorizations, authorization.authorization_id);
    this.authorizations.set(authorization.authorization_id, authorization);
  }
  async getAuthorization(authorizationId: string): Promise<PaymentAuthorization | undefined> {
    return this.authorizations.get(authorizationId);
  }
  async findAuthorizationByReference(reference: string): Promise<PaymentAuthorization | undefined> {
    return [...this.authorizations.values()].find((item) => item.business_reference === reference);
  }
  async listAuthorizations(walletId: string): Promise<readonly PaymentAuthorization[]> {
    return [...this.authorizations.values()].filter((item) => item.wallet_id === walletId);
  }
  async allAuthorizations(): Promise<readonly PaymentAuthorization[]> {
    return [...this.authorizations.values()];
  }
  async updateAuthorization(authorization: PaymentAuthorization, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.authorizations, authorization.authorization_id);
    this.authorizations.set(authorization.authorization_id, authorization);
  }
  async insertTransaction(transaction: LedgerTransaction, _scope?: TransactionScope): Promise<void> {
    // ledger_transaction.business_reference is UNIQUE. This is the constraint
    // that makes a capture exactly-once under concurrency: the reference is
    // `capture:<authorization_id>`, so only one can ever exist, whatever two
    // racing callers each read beforehand.
    if (this.ledgerReferenceClash(transaction)) {
      throw new Error(
        "duplicate key value violates unique constraint \"ledger_transaction_business_reference_key\"",
      );
    }
    journalMapWrite(_scope, this.ledger, transaction.transaction_id);
    this.ledger.set(transaction.transaction_id, transaction);
  }
  async findTransactionByReference(reference: string): Promise<LedgerTransaction | undefined> {
    return [...this.ledger.values()].find((item) => item.business_reference === reference);
  }
  async transactions(): Promise<readonly LedgerTransaction[]> {
    return [...this.ledger.values()];
  }
}