/**
 * Medicine master + stock controller — HTTP only (Doc 09 §11).
 *
 * Dates arrive as ISO strings and are coerced to `Date` HERE, at the edge, so no service or
 * repository ever parses a string (Constitution: dates are Dates below the controller). The
 * medicine master is tenant-wide — one shelf per hospital, like the tariff — so no branch id
 * is threaded through these writes.
 */
import type { RequestHandler } from "express";
import * as medicines from "./medicine.service.js";
import type {
  AvailabilityQuery,
  CreateMedicineBody,
  UpdateMedicineBody,
  ReceiveStockBody,
  AdjustStockBody,
  ListQuery,
} from "./medicine.schema.js";
import { ok } from "../../core/http/respond.js";

export const list: RequestHandler = async (req, res) => {
  const q = req.query as unknown as ListQuery;
  ok(res, await medicines.listMedicines(filterOf(q)));
};

export const report: RequestHandler = async (req, res) => {
  const q = req.query as unknown as ListQuery;
  ok(res, await medicines.stockReport(filterOf(q)));
};

export const get: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const medicine = await medicines.getMedicine(id);
  if (!medicine) {
    res
      .status(404)
      .json({ success: false, error: { code: "HMS-GEN-404", message: "Medicine not found" } });
    return;
  }
  ok(res, medicine);
};

export const create: RequestHandler = async (req, res) => {
  const body = req.body as CreateMedicineBody;
  ok(res, await medicines.createMedicine(body), 201);
};

export const update: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as UpdateMedicineBody;
  ok(res, await medicines.updateMedicine(id, body));
};

export const receive: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as ReceiveStockBody;
  ok(
    res,
    await medicines.receiveStock(id, {
      quantity: body.quantity,
      ...(body.batchNo ? { batchNo: body.batchNo } : {}),
      ...(body.expiry ? { expiry: new Date(body.expiry) } : {}),
    }),
    201,
  );
};

export const adjust: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as AdjustStockBody;
  ok(res, await medicines.adjustStock(id, { delta: body.delta, reason: body.reason }), 201);
};

export const movements: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await medicines.listMovements(id));
};

function filterOf(q: ListQuery): {
  search?: string;
  lowStockOnly?: boolean;
  includeInactive?: boolean;
} {
  return {
    ...(q.search ? { search: q.search } : {}),
    ...(q.lowStockOnly === "true" ? { lowStockOnly: true } : {}),
    ...(q.includeInactive === "true" ? { includeInactive: true } : {}),
  };
}

/** Every lot of one drug — the shelf, expired stock included so somebody can pull it. */
export const shelf: RequestHandler = async (req, res) => {
  const { code } = req.params as { code: string };
  ok(res, await medicines.shelfFor(code));
};

/**
 * What the pharmacy could hand over today, for the drugs on a prescribing pad.
 *
 * Gated on `prescription:create`, not on a pharmacy permission — see the route.
 */
export const availability: RequestHandler = async (req, res) => {
  const { codes } = req.query as unknown as AvailabilityQuery;
  ok(
    res,
    await medicines.availability(
      codes
        .split(",")
        .map((c: string) => c.trim())
        .filter(Boolean),
    ),
  );
};
