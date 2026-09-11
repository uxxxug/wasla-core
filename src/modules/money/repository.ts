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

export class InMemoryMoneyRepository implements MoneyRepository {
  private wallets = new Map<string, Wallet>();
  private authorizations = new Map<string, PaymentAuthorization>();
  private ledger = new Map<string, LedgerTransaction>();

  async insertWallet(wallet: Wallet, _scope?: TransactionScope): Promise<void> {
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