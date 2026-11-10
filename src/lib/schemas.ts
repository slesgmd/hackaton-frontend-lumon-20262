import { z } from "zod";

export const BinSchema = z.enum(["WO", "FC", "DR", "MA"]);

export const ProgressSchema = z.object({
  WO: z.number(),
  FC: z.number(),
  DR: z.number(),
  MA: z.number(),
  overall: z.number(),
});

export const DataFileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  tileSize: z.number().int().positive(),
  status: z.enum(["ACTIVE", "COMPLETE"]),
  progress: ProgressSchema,
  refinedGroups: z.number().int(),
  totalGroups: z.number().int(),
  mistakes: z.number().int(),
  updatedAt: z.string(),
});

export const FilePageSchema = z.object({
  content: z.array(DataFileSchema),
  totalElements: z.number().int(),
  totalPages: z.number().int(),
  page: z.number().int(),
  size: z.number().int(),
});

/** `strategy` queda como string: una estrategia desconocida es un error visible, no un fallo de parseo. */
export const RulesSchema = z.object({
  tremorThreshold: z.number().int().min(0).max(100),
  connectivity: z.union([z.literal(4), z.literal(8)]),
  minGroupSize: z.number().int().min(0),
  maxGroupSize: z.number().int().min(1),
  binning: z.object({
    strategy: z.string(),
    order: z.array(BinSchema).length(4),
  }),
});

export const TileSchema = z.object({
  tileRow: z.number().int(),
  tileCol: z.number().int(),
  originRow: z.number().int(),
  originCol: z.number().int(),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  values: z.string(),
  tremor: z.string(),
  bins: z.string(),
  version: z.number().int(),
});

export const RefineResultSchema = z.object({
  refinementId: z.number().int(),
  bin: BinSchema,
  size: z.number().int(),
  file: z.object({
    progress: ProgressSchema,
    refinedGroups: z.number().int(),
    totalGroups: z.number().int(),
    mistakes: z.number().int(),
    status: z.enum(["ACTIVE", "COMPLETE"]),
  }),
});

export const ClearanceCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

export const ClearanceCheckResultSchema = z.object({
  granted: z.boolean(),
  grantedAt: z.string().nullable(),
  checks: z.array(ClearanceCheckSchema),
});

export const ClearanceSchema = z.object({
  granted: z.boolean(),
  grantedAt: z.string().nullable(),
  checks: z.array(ClearanceCheckSchema),
  checkedAt: z.string().nullable(),
  workspace: z.object({ kind: z.string(), chaosLevel: z.number() }),
  roster: z.object({ complete: z.boolean(), locked: z.boolean() }),
  round: z.object({ approved: z.boolean() }),
});

export const IntegrationStatusSchema = z.object({
  deploy: z.object({
    origin: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    lastBuildSeen: z.string().nullable(),
    lastBuildSeenAt: z.string().nullable(),
    pendingChallenge: z.object({ origin: z.string(), expiresAt: z.string() }).nullable(),
  }),
  storage: z.object({
    provider: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    checks: z.array(ClearanceCheckSchema),
  }),
  clearance: z.object({ granted: z.boolean(), grantedAt: z.string().nullable() }),
});
