/**
 * Ward & bed controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as wards from "./ward.service.js";
import type {
  CreateWardBody,
  UpdateWardBody,
  CreateRoomBody,
  UpdateRoomBody,
  CreateBedBody,
  UpdateBedBody,
  ListRoomsQuery,
  ListBedsQuery,
} from "./ward.schema.js";
import { ok } from "../../core/http/respond.js";

export const listWards: RequestHandler = async (_req, res) => {
  ok(res, await wards.listWards());
};

export const createWard: RequestHandler = async (req, res) => {
  ok(res, await wards.createWard(req.body as CreateWardBody), 201);
};

export const updateWard: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await wards.updateWard(id, req.body as UpdateWardBody));
};

export const listRooms: RequestHandler = async (req, res) => {
  const { wardId } = req.query as ListRoomsQuery;
  ok(res, await wards.listRooms(wardId));
};

export const createRoom: RequestHandler = async (req, res) => {
  ok(res, await wards.createRoom(req.body as CreateRoomBody), 201);
};

export const updateRoom: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await wards.updateRoom(id, req.body as UpdateRoomBody));
};

export const listBeds: RequestHandler = async (req, res) => {
  const { wardId } = req.query as ListBedsQuery;
  ok(res, await wards.listBeds(wardId));
};

export const createBed: RequestHandler = async (req, res) => {
  ok(res, await wards.createBed(req.body as CreateBedBody), 201);
};

export const updateBed: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await wards.updateBed(id, req.body as UpdateBedBody));
};
