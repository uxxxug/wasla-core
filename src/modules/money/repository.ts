import {
  journalMapWrite,
  journalOf,
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
    this.assertAuthorizationShape(authorization);
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
  /**
   * The CHECK constraints migration 0009 adds, restated.
   *
   * They look redundant next to the service that already upholds them, and
   * that is the point: they are here to catch the service getting it wrong.
   * A memory backend more permissive than Postgres is a backend that certifies
   * bugs, which is what B-12 was.
   */
  private assertAuthorizationShape(a: PaymentAuthorization): void {
    if (a.captured_minor < 0 || a.captured_minor > a.amount_minor) {
      throw new Error(
        'new row violates check constraint "payment_authorization_capture_ceiling"',
      );
    }
    if (a.refunded_minor < 0 || a.refunded_minor > a.captured_minor) {
      throw new Error(
        'new row violates check constraint "payment_authorization_refund_ceiling"',
      );
    }
    const consistent =
      a.status === "authorized"
        ? a.captured_minor < a.amount_minor
        : a.status === "captured"
          ? a.captured_minor === a.amount_minor
          : a.status === "partially_captured"
            ? a.captured_minor > 0 && a.captured_minor < a.amount_minor
            : a.captured_minor === 0;
    if (!consistent) {
      throw new Error(
        'new row violates check constraint "payment_authorization_status_amounts"',
      );
    }
    if ((a.status === "voided" || a.status === "partially_captured") && !a.void_reason) {
      throw new Error(
        'new row violates check constraint "payment_authorization_void_reason_required"',
      );
    }
  }

  /**
   * The deferred trigger from migration 0009: the aggregate columns on an
   * authorization must equal what the ledger says moved.
   *
   * Deferred for the same reason Postgres defers it — the authorization row
   * and its ledger rows are written in one transaction and either order is
   * legitimate, so checking eagerly would reject a state the transaction was
   * about to make consistent. Outside a transaction there is nothing to defer
   * to, so the check runs immediately, which matches autocommit.
   */
  private deferLedgerAgreement(scope: TransactionScope | undefined, authorizationId: string): void {
    const check = () => this.assertLedgerAgreement(authorizationId);
    const journal = journalOf(scope);
    if (journal) journal.defer(`money:${authorizationId}`, check);
    else check();
  }

  private assertLedgerAgreement(authorizationId: string): void {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) return;
    let captured = 0;
    let refunded = 0;
    for (const transaction of this.ledger.values()) {
      if (transaction.authorization_id !== authorizationId) continue;
      for (const entry of transaction.entries) {
        if (entry.account_reference !== "clearing:captured") continue;
        // A capture posts +amount there, a refund posts -amount. Summed per
        // kind rather than netted, so two errors of equal size cannot cancel
        // out and hide each other.
        if (transaction.kind === "capture") captured += entry.amount_minor;
        if (transaction.kind === "refund") refunded -= entry.amount_minor;
      }
    }
    if (authorization.captured_minor !== captured) {
      throw new Error(
        `authorization ${authorizationId} claims ${authorization.captured_minor} captured but the ledger holds ${captured}`,
      );
    }
    if (authorization.refunded_minor !== refunded) {
      throw new Error(
        `authorization ${authorizationId} claims ${authorization.refunded_minor} refunded but the ledger holds ${refunded}`,
      );
    }
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
    this.assertAuthorizationShape(authorization);
    journalMapWrite(_scope, this.authorizations, authorization.authorization_id);
    this.authorizations.set(authorization.authorization_id, authorization);
    this.deferLedgerAgreement(_scope, authorization.authorization_id);
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
    // ledger_transaction_authorization_presence — migration 0009.
    if ((transaction.kind === "credit") !== (transaction.authorization_id === null)) {
      throw new Error(
        'new row for relation "ledger_transaction" violates check constraint "ledger_transaction_authorization_presence"',
      );
    }
    journalMapWrite(_scope, this.ledger, transaction.transaction_id);
    this.ledger.set(transaction.transaction_id, transaction);
    if (transaction.authorization_id) {
      this.deferLedgerAgreement(_scope, transaction.authorization_id);
    }
  }
  async findTransactionByReference(reference: string): Promise<LedgerTransaction | undefined> {
    return [...this.ledger.values()].find((item) => item.business_reference === reference);
  }
  async transactions(): Promise<readonly LedgerTransaction[]> {
    return [...this.ledger.values()];
  }
}