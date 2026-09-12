import type { TransactionBoundary } from "../../platform/persistence/transaction.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import type { Clock } from "../../platform/clock.js";
import { conflict, invalid, notFound } from "../../platform/errors.js";
import { newId, assertId } from "../../platform/ids.js";
import { makeEvent } from "../../platform/eventing/envelope.js";
import type { OutboxStore } from "../../platform/eventing/outbox.js";
import {
  withTransaction,
  type PendingAuditEntry,
  type UnitOfWork,
} from "../../platform/eventing/unit-of-work.js";
import {
  assertBalanced,
  normalizeCurrency,
  refundableAmount,
  remainingHold,
  type LedgerEntry,
  type LedgerTransaction,
  type PaymentAuthorization,
  type Wallet,
  type WalletOwnerType,
} from "./domain.js";
import type { MoneyRepository } from "./repository.js";

const PRODUCER = "wasla-core";

export interface CaptureInput {
  authorization_id: string;
  /** Omitted captures the whole remaining hold. */
  amount_minor?: number;
  /**
   * The caller's idempotency key for this capture. Required for a partial
   * capture, because a key derived from the authorization alone cannot tell
   * one of several captures from a retry of the previous one.
   */
  capture_reference?: string;
  correlation_id: string;
}

export interface RefundInput {
  authorization_id: string;
  /** Omitted refunds everything still refundable. */
  amount_minor?: number;
  /** Always required: there is no "the" refund of an authorization. */
  refund_reference: string;
  reason: string;
  correlation_id: string;
}

export class MoneyService {
  constructor(
    private readonly repo: MoneyRepository,
    private readonly outbox: OutboxStore,
    private readonly boundary: TransactionBoundary,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  /** Boundary, outbox and audit log — the three things a commit needs. */
  private get tx() {
    return { boundary: this.boundary, outbox: this.outbox, audit: this.audit };
  }

  async createWallet(input: {
    owner_type: WalletOwnerType;
    owner_id: string;
    currency: string;
    correlation_id: string;
  }): Promise<{ wallet: Wallet; created: boolean }> {
    // owner_id always names a CORE entity (an organization or an identity),
    // so it is one of ours and must look like one.
    assertId("owner_id", input.owner_id);
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
    await withTransaction(this.tx, (uow) => {
      uow.stage((scope) => this.repo.insertWallet(wallet, scope));
      uow.audit({
        actor_type: "service",
        actor_id: null,
        action: "wallet.created",
        entity_type: "wallet",
        entity_id: wallet.wallet_id,
        correlation_id: input.correlation_id,
        metadata: { owner_type: wallet.owner_type, owner_id: wallet.owner_id, currency },
      });
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
   *
   * What is held is the *remainder* of each hold, not its original amount.
   * A partial capture has already left the wallet via a ledger entry, so it
   * is in `posted_minor` — counting the whole hold as well would deduct that
   * money twice and refuse authorizations the wallet can afford. Refunds need
   * no special handling: they are ledger entries on the wallet, so they show
   * up in `posted_minor` on their own.
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
      .reduce((sum, authorization) => sum + remainingHold(authorization), 0);
    const expiredMinor = open
      .filter((item) => this.isExpired(item))
      .reduce((sum, authorization) => sum + remainingHold(authorization), 0);
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
    await withTransaction(this.tx, async (uow) => {
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
      uow.audit(this.moneyAudit("wallet.credited", wallet.wallet_id, input.correlation_id, input.amount_minor, wallet.currency));
    });
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
      captured_minor: 0,
      refunded_minor: 0,
      currency: wallet.currency,
      status: "authorized",
      business_reference: input.business_reference,
      created_at: this.clock.now().toISOString(),
      captured_at: null,
      voided_at: null,
      expires_at: this.expiry(input.expires_at ?? null),
      void_reason: null,
    };
    await withTransaction(this.tx, async (uow) => {
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
      uow.audit(this.moneyAudit("payment.authorization.created", authorization.authorization_id, input.correlation_id, input.amount_minor, wallet.currency,));
    });
    return authorization;
  }

  /**
   * Captures a hold, on its own.
   *
   * Prefer `captureWithin` when the caller is also changing state that must
   * agree with the money. This form opens its own transaction, so a caller
   * that then commits separately can end up with captured funds and an
   * unchanged domain row (that was B-11).
   */
  async capture(input: CaptureInput): Promise<LedgerTransaction> {
    return withTransaction(this.tx, (uow) => this.captureWithin(uow, input));
  }

  /**
   * Captures against a hold **inside the caller's unit of work**.
   *
   * Everything is validated and read first, then the mutation, the event and
   * the audit entry are staged on the caller's `uow`. So they commit with
   * whatever else the caller is changing, and roll back with it — which is the
   * only way money and execution state can be guaranteed to agree.
   *
   * Refusals (`notFound`, `conflict`) are raised during the read phase, before
   * anything is staged, so a refusal leaves the caller's unit of work
   * untouched rather than half filled.
   *
   * `amount_minor` omitted captures the whole remainder, which is what every
   * caller before migration 0009 meant. A smaller amount leaves the rest held
   * and capturable, because the authorization records what the payer consented
   * to and part of that consent being unused is not a reason to discard it.
   * The hold only closes when the full amount is captured, or when someone
   * releases the remainder explicitly.
   */
  async captureWithin(uow: UnitOfWork, input: CaptureInput): Promise<LedgerTransaction> {
    return (await this.applyCaptureWithin(uow, input)).transaction;
  }

  /**
   * Captures and reports the **hold** rather than the ledger leg.
   *
   * The counterpart of `voidWithin`, and it exists for the same reason that one
   * returns an authorization: a caller that has to record where the money now
   * stands needs the hold's running total, and the ledger transaction only ever
   * carries the amount of the leg that just moved. On a hold captured in legs
   * the last leg is not the total, so a caller deriving the total from the
   * transaction would understate what the payer paid — which is why
   * `FulfillmentService` previously published no amount at all on the success
   * path and left consumers to infer it.
   *
   * Same idempotency as `captureWithin`, because it is the same call: a retry
   * returns the stored authorization, whose `captured_minor` already includes
   * the earlier capture.
   */
  async captureHoldWithin(
    uow: UnitOfWork,
    input: CaptureInput,
  ): Promise<PaymentAuthorization> {
    return (await this.applyCaptureWithin(uow, input)).authorization;
  }

  /**
   * The one capture implementation. Reports both facts it produces — the ledger
   * leg and the hold as it now stands — so the two public forms are two
   * projections of one write and cannot drift.
   */
  private async applyCaptureWithin(
    uow: UnitOfWork,
    input: CaptureInput,
  ): Promise<{ transaction: LedgerTransaction; authorization: PaymentAuthorization }> {
    assertId("authorization_id", input.authorization_id);
    const authorization = await this.repo.getAuthorization(input.authorization_id);
    if (!authorization) throw notFound("payment authorization not found");

    // The ledger answers a retry before anything else is considered.
    //
    // It has to come first: once a hold is fully captured its remainder is
    // zero, so reasoning about the amount ahead of this would turn an
    // idempotent retry into "capture zero" and refuse it as invalid. Full
    // captures keep the reference they have always had, so an existing
    // caller's retry is answered exactly as before.
    const reference = input.capture_reference
      ? `capture:${authorization.authorization_id}:${input.capture_reference}`
      : `capture:${authorization.authorization_id}`;
    const existing = await this.repo.findTransactionByReference(reference);
    // The stored authorization is the right answer for the hold on a retry: it
    // already includes the capture this call is repeating, so a caller reading
    // `captured_minor` from it sees the same total the first call produced.
    if (existing) return { transaction: existing, authorization };

    if (authorization.status !== "authorized") throw conflict("authorization cannot be captured");
    if (this.isExpired(authorization)) {
      throw conflict("authorization has expired and can only be voided");
    }

    const remaining = remainingHold(authorization);
    const requested = input.amount_minor ?? remaining;
    this.assertAmount(requested);
    // A partial capture is by definition one of several, so a reference
    // derived from the authorization alone cannot tell two of them apart —
    // and a retry would be indistinguishable from a second, additional
    // capture. Requiring an explicit key is the only way the caller can
    // retry safely, so CORE refuses rather than guessing.
    if (requested < remaining && !input.capture_reference) {
      throw invalid("capture_reference is required when capturing less than the remaining hold");
    }
    // The ceiling the payer consented to. Exceeding it is not an overdraft,
    // it is charging for something nobody agreed to.
    if (requested > remaining) {
      throw conflict(`capture of ${requested} exceeds the remaining hold of ${remaining}`);
    }

    const wallet = await this.requireWallet(authorization.wallet_id);
    const transaction = this.transaction(
      "capture",
      reference,
      authorization.currency,
      "clearing:captured",
      `wallet:${wallet.wallet_id}`,
      requested,
      authorization.authorization_id,
    );
    const capturedTotal = authorization.captured_minor + requested;
    const settled = capturedTotal === authorization.amount_minor;
    const updated: PaymentAuthorization = {
      ...authorization,
      captured_minor: capturedTotal,
      status: settled ? "captured" : "authorized",
      // `captured_at` is when the hold closed with money having moved, so it
      // stays null while a remainder is still capturable.
      captured_at: settled ? this.clock.now().toISOString() : authorization.captured_at,
    };
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
          // The amount that moved in THIS capture. Equal to the whole
          // authorization for a full capture, which is what it always was.
          amount_minor: requested,
          captured_minor: capturedTotal,
          remaining_minor: updated.amount_minor - capturedTotal,
          currency: authorization.currency,
          business_reference: authorization.business_reference,
        },
      }),
    );
    uow.audit(
      this.moneyAudit(
        "payment.authorization.captured",
        authorization.authorization_id,
        input.correlation_id,
        requested,
        authorization.currency,
      ),
    );
    // `updated`, not `authorization`: the caller needs the hold as this capture
    // leaves it. Returning the pre-capture row would report a total that is
    // short by exactly the amount just captured.
    return { transaction, authorization: updated };
  }

  /**
   * Returns money that has already moved.
   *
   * A refund is not a void, and treating them as one operation would be the
   * worst mistake available in this module. A void releases money that never
   * left the wallet and posts nothing to the ledger; a refund posts a balanced
   * reversal of money that did leave. Their limits differ too — a void is
   * bounded by what is still held, a refund by what was captured.
   *
   * It also does not un-capture. The authorization stays `captured`, and the
   * history shows money going out and coming back rather than never having
   * left. Nor does it restore the hold: the funds return to the posted balance
   * and are simply spendable again.
   */
  async refund(input: RefundInput): Promise<LedgerTransaction> {
    return withTransaction(this.tx, (uow) => this.refundWithin(uow, input));
  }

  /** Refunds inside the caller's unit of work. See `captureWithin`. */
  async refundWithin(uow: UnitOfWork, input: RefundInput): Promise<LedgerTransaction> {
    assertId("authorization_id", input.authorization_id);
    if (!input.refund_reference.trim()) throw invalid("refund_reference is required");
    if (!input.reason.trim()) throw invalid("reason is required");
    const authorization = await this.repo.getAuthorization(input.authorization_id);
    if (!authorization) throw notFound("payment authorization not found");

    // Always keyed, unlike capture: there is no such thing as "the" refund of
    // an authorization, so there is no reference that could be derived.
    const reference = `refund:${authorization.authorization_id}:${input.refund_reference.trim()}`;
    const existing = await this.repo.findTransactionByReference(reference);
    if (existing) return existing;

    const refundable = refundableAmount(authorization);
    if (authorization.captured_minor === 0) {
      throw conflict("nothing has been captured on this authorization");
    }
    // Said separately from the ceiling below, because "you may not refund
    // 1 more" and "there is nothing left to refund" are different facts, and
    // defaulting to the whole refundable amount would otherwise ask for zero
    // and be refused as a malformed amount instead of an exhausted one.
    if (refundable === 0) throw conflict("nothing refundable remains on this authorization");
    const requested = input.amount_minor ?? refundable;
    this.assertAmount(requested);
    if (requested > refundable) {
      throw conflict(`refund of ${requested} exceeds the refundable amount of ${refundable}`);
    }

    const wallet = await this.requireWallet(authorization.wallet_id);
    // The exact reversal of a capture: the money goes back to the wallet and
    // comes out of the account it was captured into.
    const transaction = this.transaction(
      "refund",
      reference,
      authorization.currency,
      `wallet:${wallet.wallet_id}`,
      "clearing:captured",
      requested,
      authorization.authorization_id,
    );
    const updated: PaymentAuthorization = {
      ...authorization,
      refunded_minor: authorization.refunded_minor + requested,
    };
    uow.stage(async (scope) => {
      await this.repo.updateAuthorization(updated, scope);
      await this.repo.insertTransaction(transaction, scope);
    });
    uow.emit(
      makeEvent({
        event_type: "core.payment.refunded",
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
          amount_minor: requested,
          refunded_minor: updated.refunded_minor,
          captured_minor: authorization.captured_minor,
          currency: authorization.currency,
          business_reference: authorization.business_reference,
          reason: input.reason.trim(),
        },
      }),
    );
    uow.audit(
      this.moneyAudit(
        "payment.authorization.refunded",
        authorization.authorization_id,
        input.correlation_id,
        requested,
        authorization.currency,
      ),
    );
    return transaction;
  }

  /**
   * Releases whatever is still held, without moving money. Idempotent: voiding
   * an already closed authorization returns it unchanged; a fully captured one
   * cannot be voided because there is nothing left to release.
   */
  async voidAuthorization(input: {
    authorization_id: string;
    reason: string;
    correlation_id: string;
  }): Promise<PaymentAuthorization> {
    return withTransaction(this.tx, (uow) => this.voidWithin(uow, input));
  }

  /** Releases a hold inside the caller's unit of work. See `captureWithin`. */
  async voidWithin(
    uow: UnitOfWork,
    input: { authorization_id: string; reason: string; correlation_id: string },
  ): Promise<PaymentAuthorization> {
    assertId("authorization_id", input.authorization_id);
    const authorization = await this.repo.getAuthorization(input.authorization_id);
    if (!authorization) throw notFound("payment authorization not found");
    if (authorization.status === "voided" || authorization.status === "partially_captured") {
      return authorization;
    }
    if (authorization.status === "captured") {
      throw conflict("a captured authorization cannot be voided");
    }
    if (!input.reason.trim()) throw invalid("reason is required");
    return this.applyVoidWithin(uow, authorization, input.reason.trim(), input.correlation_id);
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
      expired.push(
        await withTransaction(this.tx, (uow) =>
          this.applyVoidWithin(uow, authorization, "expired", correlationId),
        ),
      );
    }
    return expired;
  }

  private async applyVoidWithin(
    uow: UnitOfWork,
    authorization: PaymentAuthorization,
    reason: string,
    correlationId: string,
  ): Promise<PaymentAuthorization> {
    // Only the remainder comes back. The captured part already left and a
    // void cannot undo that — returning it would need a refund, which is a
    // different operation with a different meaning.
    const released = remainingHold(authorization);
    // A hold that moved money and then released the rest is neither
    // `captured` nor `voided`. Calling it `voided` would claim nothing moved
    // when some did, and it is the record a reconciliation would trust.
    const closed = authorization.captured_minor > 0 ? "partially_captured" : "voided";
    const updated: PaymentAuthorization = {
      ...authorization,
      status: closed,
      voided_at: this.clock.now().toISOString(),
      void_reason: reason,
      captured_at:
        closed === "partially_captured"
          ? this.clock.now().toISOString()
          : authorization.captured_at,
    };
    {
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
            // The amount actually released. Equal to the whole authorization
            // when nothing was captured, which is what it always was.
            amount_minor: released,
            captured_minor: updated.captured_minor,
            currency: updated.currency,
            business_reference: updated.business_reference,
            reason,
          },
        }),
      );
      uow.audit(this.moneyAudit("payment.authorization.voided", updated.authorization_id, correlationId, released, updated.currency,));
    }
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

  /**
   * Reads a wallet.
   *
   * On money's published surface because another module needs to check a
   * wallet's currency and owner before binding anything to it, and the
   * alternative was reaching into `MoneyRepository` directly, which the module
   * boundary rule forbids for good reason. Read-only.
   */
  async getWallet(walletId: string): Promise<Wallet | undefined> {
    assertId("wallet_id", walletId);
    return this.repo.getWallet(walletId);
  }

  private async requireWallet(walletId: string): Promise<Wallet> {
    assertId("wallet_id", walletId);
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
    authorizationId: string | null = null,
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
      authorization_id: authorizationId,
      business_reference: reference,
      occurred_at: this.clock.now().toISOString(),
      entries,
    };
  }

  /**
   * Builds the audit entry for a money movement. It is a value, not a write,
   * so the caller can hand it to `uow.audit` and have it commit with the
   * ledger rows rather than after them (B-9). An audit entry claiming money
   * moved when the transaction rolled back is worse than no entry: it is the
   * record a reconciliation would trust.
   */
  private moneyAudit(
    action: string,
    entityId: string,
    correlationId: string,
    amount: number,
    currency: string,
  ): PendingAuditEntry {
    return {
      actor_type: "service",
      actor_id: null,
      action,
      entity_type: "money",
      entity_id: entityId,
      correlation_id: correlationId,
      metadata: { amount_minor: amount, currency },
    };
  }
}