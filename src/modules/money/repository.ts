import type { LedgerTransaction, PaymentAuthorization, Wallet } from "./domain.js";

export interface MoneyRepository {
  insertWallet(wallet: Wallet): void;
  getWallet(walletId: string): Wallet | undefined;
  findWallet(ownerType: Wallet["owner_type"], ownerId: string, currency: string): Wallet | undefined;
  insertAuthorization(authorization: PaymentAuthorization): void;
  getAuthorization(authorizationId: string): PaymentAuthorization | undefined;
  findAuthorizationByReference(reference: string): PaymentAuthorization | undefined;
  listAuthorizations(walletId: string): readonly PaymentAuthorization[];
  updateAuthorization(authorization: PaymentAuthorization): void;
  insertTransaction(transaction: LedgerTransaction): void;
  findTransactionByReference(reference: string): LedgerTransaction | undefined;
  transactions(): readonly LedgerTransaction[];
}

export class InMemoryMoneyRepository implements MoneyRepository {
  private wallets = new Map<string, Wallet>();
  private authorizations = new Map<string, PaymentAuthorization>();
  private ledger = new Map<string, LedgerTransaction>();

  insertWallet(wallet: Wallet): void {
    this.wallets.set(wallet.wallet_id, wallet);
  }
  getWallet(walletId: string): Wallet | undefined {
    return this.wallets.get(walletId);
  }
  findWallet(ownerType: Wallet["owner_type"], ownerId: string, currency: string): Wallet | undefined {
    return [...this.wallets.values()].find(
      (wallet) => wallet.owner_type === ownerType && wallet.owner_id === ownerId && wallet.currency === currency,
    );
  }
  insertAuthorization(authorization: PaymentAuthorization): void {
    this.authorizations.set(authorization.authorization_id, authorization);
  }
  getAuthorization(authorizationId: string): PaymentAuthorization | undefined {
    return this.authorizations.get(authorizationId);
  }
  findAuthorizationByReference(reference: string): PaymentAuthorization | undefined {
    return [...this.authorizations.values()].find((item) => item.business_reference === reference);
  }
  listAuthorizations(walletId: string): readonly PaymentAuthorization[] {
    return [...this.authorizations.values()].filter((item) => item.wallet_id === walletId);
  }
  updateAuthorization(authorization: PaymentAuthorization): void {
    this.authorizations.set(authorization.authorization_id, authorization);
  }
  insertTransaction(transaction: LedgerTransaction): void {
    this.ledger.set(transaction.transaction_id, transaction);
  }
  findTransactionByReference(reference: string): LedgerTransaction | undefined {
    return [...this.ledger.values()].find((item) => item.business_reference === reference);
  }
  transactions(): readonly LedgerTransaction[] {
    return [...this.ledger.values()];
  }
}