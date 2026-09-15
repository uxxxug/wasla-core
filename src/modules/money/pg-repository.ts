import { iso, isoRequired, runner, type Queryable } from "../../platform/persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../../platform/persistence/transaction.js";
import type {
  AuthorizationStatus,
  LedgerEntry,
  LedgerTransaction,
  PaymentAuthorization,
  Wallet,
  WalletOwnerType,
  WalletStatus,
} from "./domain.js";
import type { MoneyRepository } from "./repository.js";

/**
 * `amount_minor` is `bigint`, which the driver returns as a string so that
 * values beyond 2^53 are not silently corrupted. CORE amounts are integer
 * minor units well inside the safe range, so converting is correct here — but
 * it is a conversion, not a no-op, and doing it in one place is why it is
 * worth naming.
 */
const minor = (value: string | number): number => Number(value);

/** `currency` is `char(3)`; Postgres pads it, so trim on the way out. */
const trim = (value: string) => value.trim();

interface WalletRow {
  wallet_id: string;
  owner_type: WalletOwnerType;
  owner_id: string;
  currency: string;
  status: WalletStatus;
  created_at: Date;
}

interface AuthorizationRow {
  authorization_id: string;
  wallet_id: string;
  amount_minor: string;
  captured_minor: string;
  refunded_minor: string;
  currency: string;
  status: AuthorizationStatus;
  business_reference: string;
  created_at: Date;
  captured_at: Date | null;
  voided_at: Date | null;
  expires_at: Date | null;
  void_reason: string | null;
}

interface TransactionRow {
  transaction_id: string;
  kind: LedgerTransaction["kind"];
  business_reference: string;
  occurred_at: Date;
  authorization_id: string | null;
}

interface EntryRow {
  entry_id: string;
  transaction_id: string;
  account_reference: string;
  amount_minor: string;
  currency: string;
}

const toWallet = (row: WalletRow): Wallet => ({
  wallet_id: row.wallet_id,
  owner_type: row.owner_type,
  owner_id: row.owner_id,
  currency: trim(row.currency),
  status: row.status,
  created_at: isoRequired(row.created_at),
});

const toAuthorization = (row: AuthorizationRow): PaymentAuthorization => ({
  authorization_id: row.authorization_id,
  wallet_id: row.wallet_id,
  amount_minor: minor(row.amount_minor),
  // bigint columns arrive as strings from the driver.
  captured_minor: minor(row.captured_minor),
  refunded_minor: minor(row.refunded_minor),
  currency: trim(row.currency),
  status: row.status,
  business_reference: row.business_reference,
  created_at: isoRequired(row.created_at),
  captured_at: iso(row.captured_at),
  voided_at: iso(row.voided_at),
  expires_at: iso(row.expires_at),
  void_reason: row.void_reason,
});

const toEntry = (row: EntryRow): LedgerEntry => ({
  entry_id: row.entry_id,
  transaction_id: row.transaction_id,
  account_reference: row.account_reference,
  amount_minor: minor(row.amount_minor),
  currency: trim(row.currency),
});

const WALLET = `wallet_id, owner_type, owner_id, currency, status, created_at`;
const AUTHORIZATION = `authorization_id, wallet_id, amount_minor, captured_minor,
  refunded_minor, currency, status, business_reference, created_at, captured_at,
  voided_at, expires_at, void_reason`;

/** Postgres adapter for the money ports. */
export class PgMoneyRepository implements MoneyRepository {
  constructor(private readonly pool: Queryable) {}

  async insertWallet(wallet: Wallet, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into wallet (${WALLET}) values ($1,$2,$3,$4,$5,$6)`,
      [
        wallet.wallet_id,
        wallet.owner_type,
        wallet.owner_id,
        wallet.currency,
        wallet.status,
        wallet.created_at,
      ],
    );
  }

  async getWallet(walletId: string): Promise<Wallet | undefined> {
    const result = await this.pool.query<WalletRow>(
      `select ${WALLET} from wallet where wallet_id = $1`,
      [walletId],
    );
    const row = result.rows[0];
    return row ? toWallet(row) : undefined;
  }

  async findWallet(
    ownerType: WalletOwnerType,
    ownerId: string,
    currency: string,
  ): Promise<Wallet | undefined> {
    const result = await this.pool.query<WalletRow>(
      `select ${WALLET} from wallet where owner_type = $1 and owner_id = $2 and currency = $3`,
      [ownerType, ownerId, currency],
    );
    const row = result.rows[0];
    return row ? toWallet(row) : undefined;
  }

  async insertAuthorization(
    authorization: PaymentAuthorization,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into payment_authorization (${AUTHORIZATION})
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        authorization.authorization_id,
        authorization.wallet_id,
        authorization.amount_minor,
        authorization.captured_minor,
        authorization.refunded_minor,
        authorization.currency,
        authorization.status,
        authorization.business_reference,
        authorization.created_at,
        authorization.captured_at,
        authorization.voided_at,
        authorization.expires_at,
        authorization.void_reason,
      ],
    );
  }

  async getAuthorization(authorizationId: string): Promise<PaymentAuthorization | undefined> {
    const result = await this.pool.query<AuthorizationRow>(
      `select ${AUTHORIZATION} from payment_authorization where authorization_id = $1`,
      [authorizationId],
    );
    const row = result.rows[0];
    return row ? toAuthorization(row) : undefined;
  }

  async findAuthorizationByReference(
    reference: string,
  ): Promise<PaymentAuthorization | undefined> {
    const result = await this.pool.query<AuthorizationRow>(
      `select ${AUTHORIZATION} from payment_authorization where business_reference = $1`,
      [reference],
    );
    const row = result.rows[0];
    return row ? toAuthorization(row) : undefined;
  }

  async listAuthorizations(walletId: string): Promise<readonly PaymentAuthorization[]> {
    const result = await this.pool.query<AuthorizationRow>(
      `select ${AUTHORIZATION} from payment_authorization where wallet_id = $1
       order by created_at, authorization_id`,
      [walletId],
    );
    return result.rows.map(toAuthorization);
  }

  async allAuthorizations(): Promise<readonly PaymentAuthorization[]> {
    const result = await this.pool.query<AuthorizationRow>(
      `select ${AUTHORIZATION} from payment_authorization order by created_at, authorization_id`,
    );
    return result.rows.map(toAuthorization);
  }

  async countWalletsByStatus(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ status: string; count: string }>(
      `select status, count(*)::text as count from wallet group by status`,
    );
    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  async countAuthorizationsByStatus(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ status: string; count: string }>(
      `select status, count(*)::text as count from payment_authorization group by status`,
    );
    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  async updateAuthorization(
    authorization: PaymentAuthorization,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<void> {
    await runner(this.pool, scope).query(
      `update payment_authorization
       set status = $2, captured_at = $3, voided_at = $4, expires_at = $5,
           void_reason = $6, captured_minor = $7, refunded_minor = $8
       where authorization_id = $1`,
      [
        authorization.authorization_id,
        authorization.status,
        authorization.captured_at,
        authorization.voided_at,
        authorization.expires_at,
        authorization.void_reason,
        authorization.captured_minor,
        authorization.refunded_minor,
      ],
    );
  }

  /**
   * A ledger transaction and its entries are one indivisible write. The schema
   * enforces that with a deferred constraint trigger that refuses an unbalanced
   * transaction at COMMIT, which only works if the header and every entry are
   * in the same transaction.
   *
   * So this method refuses to run outside one. Without a scope each statement
   * would autocommit, the trigger would fire on a header with no entries, and
   * the failure would look like a balance bug rather than a missing
   * transaction. Failing here says what is actually wrong.
   */
  async insertTransaction(
    transaction: LedgerTransaction,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<void> {
    const client = runner(this.pool, scope);
    if (client === this.pool) {
      throw new Error(
        "insertTransaction must run inside a transaction: the ledger balance trigger " +
          "is checked at COMMIT and the header and entries must reach it together",
      );
    }

    await client.query(
      `insert into ledger_transaction
         (transaction_id, kind, business_reference, occurred_at, authorization_id)
       values ($1,$2,$3,$4,$5)`,
      [
        transaction.transaction_id,
        transaction.kind,
        transaction.business_reference,
        transaction.occurred_at,
        transaction.authorization_id,
      ],
    );

    for (const entry of transaction.entries) {
      await client.query(
        `insert into ledger_entry (entry_id, transaction_id, account_reference, amount_minor, currency)
         values ($1,$2,$3,$4,$5)`,
        [
          entry.entry_id,
          transaction.transaction_id,
          entry.account_reference,
          entry.amount_minor,
          entry.currency,
        ],
      );
    }
  }

  async findTransactionByReference(reference: string): Promise<LedgerTransaction | undefined> {
    const result = await this.pool.query<TransactionRow>(
      `select transaction_id, kind, business_reference, occurred_at, authorization_id
       from ledger_transaction where business_reference = $1`,
      [reference],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { ...this.header(row), entries: await this.entriesFor([row.transaction_id]) };
  }

  async transactions(): Promise<readonly LedgerTransaction[]> {
    const result = await this.pool.query<TransactionRow>(
      `select transaction_id, kind, business_reference, occurred_at, authorization_id
       from ledger_transaction order by occurred_at, transaction_id`,
    );
    if (result.rows.length === 0) return [];

    // One query for every entry rather than one per transaction: the reads
    // that use this are reconciliation reads over the whole table.
    const entries = await this.entriesFor(result.rows.map((row) => row.transaction_id));
    const byTransaction = new Map<string, LedgerEntry[]>();
    for (const entry of entries) {
      const bucket = byTransaction.get(entry.transaction_id);
      if (bucket) bucket.push(entry);
      else byTransaction.set(entry.transaction_id, [entry]);
    }
    return result.rows.map((row) => ({
      ...this.header(row),
      entries: byTransaction.get(row.transaction_id) ?? [],
    }));
  }

  private header(row: TransactionRow) {
    return {
      transaction_id: row.transaction_id,
      kind: row.kind,
      business_reference: row.business_reference,
      occurred_at: isoRequired(row.occurred_at),
      authorization_id: row.authorization_id,
    };
  }

  private async entriesFor(transactionIds: readonly string[]): Promise<LedgerEntry[]> {
    const result = await this.pool.query<EntryRow>(
      `select entry_id, transaction_id, account_reference, amount_minor, currency
       from ledger_entry where transaction_id = any($1::uuid[]) order by entry_id`,
      [transactionIds],
    );
    return result.rows.map(toEntry);
  }
}
