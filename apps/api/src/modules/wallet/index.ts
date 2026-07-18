/**
 * Wallet module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns the patient's stored-value advance: the `walletAccounts` (authoritative balance) and
 * `walletEntries` (immutable ledger) collections in the tenant DB. The desk deposits an
 * advance (OP or admission), a bill is settled from it, the leftover is refunded on discharge.
 *
 * Depends on `patients` (to assert the patient exists). Billing depends on THIS module to
 * settle a bill from advance (`debitForInvoice`); the wallet depends on nothing clinical, so
 * the arrow points one way and the graph stays acyclic.
 */
export { walletRouter } from "./wallet.routes.js";

export {
  getWallet,
  deposit,
  refund,
  debitForInvoice,
  walletReport,
  type WalletView,
  type WalletEntry,
  type WalletRegister,
  type WalletMethodRow,
  type DepositInput,
  type RefundInput,
} from "./wallet.service.js";

export { getBalance } from "./wallet.repository.js";

export { repointPatient } from "./wallet.repository.js";

export { WALLET_ENTRY_TYPES, type WalletEntryType } from "./wallet.model.js";

export { walletConsumers } from "./wallet.consumers.js";
