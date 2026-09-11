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
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  createWallet(input: {
    owner_type: WalletOwnerType;
    owner_id: string;
    currency: string;
    correlation_id: string;
  }): { wallet: Wallet; created: boolean } {
    if (!input.owner_id.trim()) throw invalid("owner_id is required");
    let currency: string;
    try {
      currency = normalizeCurrency(input.currency);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "invalid currency");
    }
    const existing = this.repo.findWallet(input.owner_type, input.owner_id, currency);
    if (existing) return { wallet: existing, created: false };
    const wallet: Wallet = {
      wallet_id: newId(),
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      currency,
      status: "active",
      created_at: this.clock.now().toISOString(),
    };
    this.repo.insertWallet(wallet);
    this.audit.record({
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

  balance(walletId: string): { posted_minor: number; held_minor: number; available_minor: number } {
    const wallet = this.requireWallet(walletId);
    const posted = this.repo
      .transactions()
      .flatMap((transaction) => transaction.entries)
      .filter((entry) => entry.account_reference === `wallet:${wallet.wallet_id}`)
      .reduce((sum, entry) => sum + entry.amount_minor, 0);
    const heldMinor = this.repo.listAuthorizations(wallet.wallet_id).filter((item) => item.status === "authorized").reduce(
      (sum, authorization) => sum + authorization.amount_minor,
      0,
    );
    return { posted_minor: posted, held_minor: heldMinor, available_minor: posted - heldMinor };
  }

  async credit(input: {
    wallet_id: string;
    amount_minor: number;
    business_reference: string;
    correlation_id: string;
  }): Promise<LedgerTransaction> {
    const wallet = this.requireWallet(input.wallet_id);
    this.assertAmount(input.amount_minor);
    const existing = this.repo.findTransactionByReference(input.business_reference);
    if (existing) return existing;
    const transaction = this.transaction(
      "credit",
      input.business_reference,
      wallet.currency,
      `wallet:${wallet.wallet_id}`,
      "clearing:external",
      input.amount_minor,
    );
    await withTransaction(this.outbox, (uow) => {
      uow.stage(() => this.repo.insertTransaction(transaction));
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
    this.auditMoney("wallet.credited", wallet.wallet_id, input.correlation_id, input.amount_minor, wallet.currency);
    return transaction;
  }

  async authorize(input: {
    wallet_id: string;
    amount_minor: number;
    business_reference: string;
    correlation_id: string;
  }): Promise<PaymentAuthorization> {
    const wallet = this.requireWallet(input.wallet_id);
    this.assertAmount(input.amount_minor);
    const existing = this.repo.findAuthorizationByReference(input.business_reference);
    if (existing) return existing;
    if (wallet.status !== "active") throw conflict("wallet is not active");
    if (this.balance(wallet.wallet_id).available_minor < input.amount_minor) {
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
    };
    await withTransaction(this.outbox, (uow) => {
      uow.stage(() => this.repo.insertAuthorization(authorization));
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
    this.auditMoney(
      "payment.authorization.created",
      authorization.authorization_id,
      input.correlation_id,
      input.amount_minor,
      wallet.currency,
    );
    return authorization;
  }

  async capture(input: { authorization_id: string; correlation_id: string }): Promise<LedgerTransaction> {
    const authorization = this.repo.getAuthorization(input.authorization_id);
    if (!authorization) throw notFound("payment authorization not found");
    const existing = this.repo.findTransactionByReference(`capture:${authorization.authorization_id}`);
    if (existing) return existing;
    if (authorization.status !== "authorized") throw conflict("authorization cannot be captured");
    const wallet = this.requireWallet(authorization.wallet_id);
    const transaction = this.transaction(
      "capture",
      `capture:${authorization.authorization_id}`,
      authorization.currency,
      "clearing:captured",
      `wallet:${wallet.wallet_id}`,
      authorization.amount_minor,
    );
    const updated = { ...authorization, status: "captured" as const, captured_at: this.clock.now().toISOString() };
    await withTransaction(this.outbox, (uow) => {
      uow.stage(() => {
        this.repo.updateAuthorization(updated);
        this.repo.insertTransaction(transaction);
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
    this.auditMoney(
      "payment.authorization.captured",
      authorization.authorization_id,
      input.correlation_id,
      authorization.amount_minor,
      authorization.currency,
    );
    return transaction;
  }

  getAuthorization(authorizationId: string): PaymentAuthorization {
    const authorization = this.repo.getAuthorization(authorizationId);
    if (!authorization) throw notFound("payment authorization not found");
    return authorization;
  }

  private requireWallet(walletId: string): Wallet {
    const wallet = this.repo.getWallet(walletId);
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

  private auditMoney(action: string, entityId: string, correlationId: string, amount: number, currency: string): void {
    this.audit.record({
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