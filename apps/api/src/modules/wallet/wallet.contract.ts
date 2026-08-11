/**
 * Patient wallet response contracts — the advance a hospital holds against a stay.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { WALLET_ENTRY_TYPES } from "./wallet.model.js";
import type { WalletEntry } from "./wallet.repository.js";
import type { WalletView } from "./wallet.service.js";

const paise = z.number().int();

export const walletEntry = contract(
  "WalletEntry",
  z.object({
    id: z.string(),
    patientId: z.string(),
    type: z.enum(WALLET_ENTRY_TYPES),
    /** Signed paise: a deposit adds, a debit subtracts. */
    amount: paise,
    balanceAfter: paise,
    method: z.string().optional(),
    reference: z.string().optional(),
    reason: z.string().optional(),
    invoiceId: z.string().optional(),
    encounterId: z.string().optional(),
    by: z.string().optional(),
    at: z.string(),
  }),
);
export type WalletEntryProof = Proves<Matches<typeof walletEntry, WalletEntry>>;

export const walletView = contract(
  "WalletView",
  z.object({ patientId: z.string(), balance: paise, entries: z.array(walletEntry) }),
);
export type WalletViewProof = Proves<Matches<typeof walletView, WalletView>>;
