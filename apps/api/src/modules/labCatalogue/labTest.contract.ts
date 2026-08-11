/**
 * Lab catalogue response contracts — the tests a hospital offers and their analytes.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import type { LabTest } from "./labTest.repository.js";

export const analyte = contract(
  "Analyte",
  z.object({
    /** Stable code within the test — `HB`, `NA`. Carried onto the order result value. */
    code: z.string(),
    label: z.string(),
    unit: z.string().optional(),
    /** Numeric reference bounds, for auto-flagging. Either, both, or neither may be set. */
    refLow: z.number().optional(),
    refHigh: z.number().optional(),
    /** The printable reference range; derived from the numbers when absent. */
    refText: z.string().optional(),
  }),
);

export const labTest = contract(
  "LabTest",
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    specimenType: z.string().optional(),
    analytes: z.array(analyte),
    active: z.boolean(),
    branchId: z.string().optional(),
  }),
);
export type LabTestProof = Proves<Matches<typeof labTest, LabTest>>;
