import { NO_SCOPE, type TransactionBoundary } from "../../platform/persistence/transaction.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import type { Clock } from "../../platform/clock.js";
import { conflict, invalid, notFound } from "../../platform/errors.js";
import { newId } from "../../platform/ids.js";
import { makeEvent } from "../../platform/eventing/envelope.js";
import type { OutboxStore } from "../../platform/eventing/outbox.js";
import { withTransaction } from "../../platform/eventing/unit-of-work.js";
import {
  assertBalanced,
  normalizeCurrency,
  type LedgerEntry,
  type LedgerTransaction,
  type PaymentAuthorization,
  type Wallet,
  type WalletOwnerType,
} from "./domain.js";
import type { MoneyRepository } from "./repository.js";

const PRODUCER = "wasla-core";

export class MoneyService {
  constructor(
    private readonly repo: MoneyRepository,
    private readonly outbox: OutboxStore,
    private readonly boundary: TransactionBoundary,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  async createWallet(input: {
    owner_type: WalletOwnerType;
    owner_id: string;
    currency: string;
    correlation_id: string;
  }): Promise<{ wallet: Wallet; created: boolean }> {
    if (!input.owner_id.trim()) throw invalid("owner_id is required");
    let currency: string;
    try {
      currency = normalizeCurrency(input.currency);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "invalid currency");
    }
    const existing = await this.repo.findWallet(input.owner_type, input.owner_id, currency);
    if (existing) return { wallet: existing, created: false };
    const wallet: Wallet = {
      wallet_id: newId(),
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      currency,
      status: "active",
      created_at: this.clock.now().toISOString(),
    };
    await this.repo.insertWallet(wallet, NO_SCOPE);
    await this.audit.record({
      actor_type: "service",
      actor_id: null,
      action: "wallet.created",
      entity_type: "wallet",
      entity_id: wallet.wallet_id,
      correlation_id: input.correlation_id,
      metadata: { owner_type: wallet.owner_type, owner_id: wallet.owner_id, currency },
    });
    return { wallet, created: true };
  }

  /**
   * Posted, held and available balance.
   *
   * An expired hold is excluded from `held_minor`: capture is already refused
   * past the expiry, so the funds are spendable again and only the sweep has
   * not caught up yet. Counting them as held would make the available balance
   * understate the truth and refuse authorizations the wallet can actually
   * afford. `expired_hold_minor` keeps that transitional amount observable
   * until `expireDueAuthorizations` releases it.
   */
  async balance(walletId: string): Promise<{
    posted_minor: number;
    held_minor: number;
    available_minor: number;
    expired_hold_minor: number;
  }> {
    const wallet = await this.requireWallet(walletId);
    const posted = (await this.repo.transactions())
      .flatMap((transaction) => transaction.entries)
      .filter((entry) => entry.account_reference === `wallet:${wallet.wallet_id}`)
      .reduce((sum, entry) => sum + entry.amount_minor, 0);
    const open = (await this.repo.listAuthorizations(wallet.wallet_id))
      .filter((item) => item.status === "authorized");
    const heldMinor = open
      .filter((item) => !this.isExpired(item))
      .reduce((sum, authorization) => sum + authorization.amount_minor, 0);
    const expiredMinor = open
      .filter((item) => this.isExpired(item))
      .reduce((sum, authorization) => sum + authorization.amount_minor, 0);
    return {
      posted_minor: posted,
      held_minor: heldMinor,
      available_minor: posted - heldMinor,
      expired_hold_minor: expiredMinor,
    };
  }

  async credit(input: {
    wallet_id: string;
    amount_minor: number;
    business_reference: string;
    correlation_id: string;
  }): Promise<LedgerTransaction> {
    const wallet = await this.requireWallet(input.wallet_id);
    this.assertAmount(input.amount_minor);
    const existing = await this.repo.findTransactionByReference(input.business_reference);
    if (existing) return existing;
    const transaction = this.transaction(
      "credit",
      input.business_reference,
      wallet.currency,
      `wallet:${wallet.wallet_id}`,
      "clearing:external",
      input.amount_minor,
    );
    await withTransaction({ boundary: this.boundary, outbox: this.outbox }, async (uow) => {
      uow.stage((scope) => this.repo.insertTransaction(transaction, scope));
      uow.emit(
        makeEvent({
          event_type: "core.money.credited",
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: input.correlation_id,
          entity_type: "wallet",
          entity_id: wallet.wallet_id,
          payload: {
            wallet_id: wallet.wallet_id,
            transaction_id: transaction.transaction_id,
            amount_minor: input.amount_minor,
            currency: wallet.currency,
            business_reference: input.business_reference,
          },
        }),
      );
    });
    await this.auditMoney("wallet.credited", wallet.wallet_id, input.correlation_id, input.amount_minor, wallet.currency);
    return transaction;
  }

  async authorize(input: {
    wallet_id: string;
    amount_minor: number;
    business_reference: string;
    correlation_id: string;
    expires_at?: Date | string | null;
  }): Promise<PaymentAuthorization> {
    const wallet = await this.requireWallet(input.wallet_id);
    this.assertAmount(input.amount_minor);
    const existing = await this.repo.findAuthorizationByReference(input.business_reference);
    if (existing) return existing;
    if (wallet.status !== "active") throw conflict("wallet is not active");
    if ((await this.balance(wallet.wallet_id)).available_minor < input.amount_minor) {
      throw conflict("insufficient available balance");
    }
    const authorization: PaymentAuthorization = {
      authorization_id: newId(),
      wallet_id: wallet.wallet_id,
      amount_minor: input.amount_minor,
      currency: wallet.currency,
      status: "authorized",
      business_reference: input.business_reference,
      created_at: this.clock.now().toISOString(),
      captured_at: null,
      voided_at: null,
      expires_at: this.expiry(input.expires_at ?? null),
      void_reason: null,
    };
    await withTransaction({ boundary: this.boundary, outbox: this.outbox }, async (uow) => {
      uow.stage((scope) => this.repo.insertAuthorization(authorization, scope));
      uow.emit(
        makeEvent({
          event_type: "core.payment.authorized",
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: input.correlation_id,
          entity_type: "payment_authorization",
          entity_id: authorization.authorization_id,
          payload: {
            authorization_id: authorization.authorization_id,
            wallet_id: wallet.wallet_id,
            amount_minor: authorization.amount_minor,
            currency: authorization.currency,
            business_reference: authorization.business_reference,
          },
        }),
      );
    });
    await this.auditMoney(
      "payment.authorization.created",
      authorization.authorization_id,
      input.correlation_id,
      input.amount_minor,
      wallet.currency,
    );
    return authorization;
  }

  async capture(input: { authorization_id: string; correlation_id: string }): Promise<LedgerTransaction> {
    const authorization = await this.repo.getAuthorization(input.authorization_id);
    if (!authorization) throw notFound("payment authorization not found");
    const existing = await this.repo.findTransactionByReference(`capture:${authorization.authorization_id}`);
    if (existing) return existing;
    if (authorization.status !== "authorized") throw conflict("authorization cannot be captured");
    if (this.isExpired(authorization)) throw conflict("authorization has expired and can only be voided");
    const wallet = await this.requireWallet(authorization.wallet_id);
    const transaction = this.transaction(
      "capture",
      `capture:${authorization.authorization_id}`,
      authorization.currency,
      "clearing:captured",
      `wallet:${wallet.wallet_id}`,
      authorization.amount_minor,
    );
    const updated = { ...authorization, status: "captured" as const, captured_at: this.clock.now().toISOString() };
    await withTransaction({ boundary: this.boundary, outbox: this.outbox }, async (uow) => {
      uow.stage(async (scope) => {
        await this.repo.updateAuthorization(updated, scope);
        await this.repo.insertTransaction(transaction, scope);
      });
      uow.emit(
        makeEvent({
          event_type: "core.payment.captured",
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: input.correlation_id,
          entity_type: "payment_authorization",
          entity_id: authorization.authorization_id,
          payload: {
            authorization_id: authorization.authorization_id,
            wallet_id: wallet.wallet_id,
            transaction_id: transaction.transaction_id,
            amount_minor: authorization.amount_minor,
            currency: authorization.currency,
            business_reference: authorization.business_reference,
          },
        }),
      );
    });
    await this.auditMoney(
      "payment.authorization.captured",
      authorization.authorization_id,
      input.correlation_id,
      authorization.amount_minor,
      authorization.currency,
    );
    return transaction;
  }

  /**
   * Releases a hold without moving money. Idempotent: voiding an already
   * voided authorization returns it unchanged; a captured one cannot be voided.
   */
  async voidAuthorization(input: {
    authorization_id: string;
    reason: string;
    correlation_id: string;
  }): Promise<PaymentAuthorization> {
    const authorization = await this.repo.getAuthorization(input.authorization_id);
    if (!authorization) throw notFound("payment authorization not found");
    if (authorization.status === "voided") return authorization;
    if (authorization.status === "captured") throw conflict("a captured authorization cannot be voided");
    if (!input.reason.trim()) throw invalid("reason is required");
    return this.applyVoid(authorization, input.reason.trim(), input.correlation_id);
  }

  /**
   * Sweeps holds whose expiry has passed. Expiry never moves money — the hold
   * is released and the funds return to the available balance.
   */
  async expireDueAuthorizations(correlationId: string): Promise<readonly PaymentAuthorization[]> {
    const due = (await this.repo.allAuthorizations())
      .filter((authorization) => authorization.status === "authorized" && this.isExpired(authorization));
    const expired: PaymentAuthorization[] = [];
    for (const authorization of due) {
      expired.push(await this.applyVoid(authorization, "expired", correlationId));
    }
    return expired;
  }

  private async applyVoid(
    authorization: PaymentAuthorization,
    reason: string,
    correlationId: string,
  ): Promise<PaymentAuthorization> {
    const updated: PaymentAuthorization = {
      ...authorization,
      status: "voided",
      voided_at: this.clock.now().toISOString(),
      void_reason: reason,
    };
    await withTransaction({ boundary: this.boundary, outbox: this.outbox }, async (uow) => {
      uow.stage((scope) => this.repo.updateAuthorization(updated, scope));
      uow.emit(
        makeEvent({
          event_type: "core.payment.voided",
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: correlationId,
          entity_type: "payment_authorization",
          entity_id: updated.authorization_id,
          payload: {
            authorization_id: updated.authorization_id,
            wallet_id: updated.wallet_id,
            amount_minor: updated.amount_minor,
            currency: updated.currency,
            business_reference: updated.business_reference,
            reason,
          },
        }),
      );
    });
    await this.auditMoney(
      "payment.authorization.voided",
      updated.authorization_id,
      correlationId,
      updated.amount_minor,
      updated.currency,
    );
    return updated;
  }

  private isExpired(authorization: PaymentAuthorization): boolean {
    if (!authorization.expires_at) return false;
    return Date.parse(authorization.expires_at) <= this.clock.now().getTime();
  }

  private expiry(value: Date | string | null): string | null {
    if (value === null) return null;
    const at = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(at.getTime())) throw invalid("expires_at must be a valid timestamp");
    if (at.getTime() <= this.clock.now().getTime()) throw invalid("expires_at must be in the future");
    return at.toISOString();
  }

  async getAuthorization(authorizationId: string): Promise<PaymentAuthorization> {
    const authorization = await this.repo.getAuthorization(authorizationId);
    if (!authorization) throw notFound("payment authorization not found");
    return authorization;
  }

  private async requireWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.repo.getWallet(walletId);
    if (!wallet) throw notFound("wallet not found");
    return wallet;
  }

  private assertAmount(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid("amount_minor must be a positive integer");
  }

  private transaction(
    kind: LedgerTransaction["kind"],
    reference: string,
    currency: string,
    creditAccount: string,
    debitAccount: string,
    amount: number,
  ): LedgerTransaction {
    const transactionId = newId();
    const entries: LedgerEntry[] = [
      { entry_id: newId(), transaction_id: transactionId, account_reference: creditAccount, amount_minor: amount, currency },
      { entry_id: newId(), transaction_id: transactionId, account_reference: debitAccount, amount_minor: -amount, currency },
    ];
    assertBalanced(entries);
    return {
      transaction_id: transactionId,
      kind,
      business_reference: reference,
      occurred_at: this.clock.now().toISOString(),
      entries,
    };
  }

  private async auditMoney(
    action: string,
    entityId: string,
    correlationId: string,
    amount: number,
    currency: string,
  ): Promise<void> {
    await this.audit.record({
      actor_type: "service",
      actor_id: null,
      action,
      entity_type: "money",
      entity_id: entityId,
      correlation_id: correlationId,
      metadata: { amount_minor: amount, currency },
    });
  }
}