import { z } from "zod";

export const DepartmentSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
});

export const RefinerSchema = z.object({
  id: z.number().int(),
  fullName: z.string(),
  department: DepartmentSchema,
  title: z.string(),
  extension: z.string(),
  bio: z.string(),
  profileUrl: z.string().nullable(),
  badge: z.object({ url: z.string(), width: z.number(), height: z.number() }).nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
});

export const RefinerPageSchema = z.object({
  content: z.array(RefinerSchema),
  totalElements: z.number().int(),
  totalPages: z.number().int(),
  page: z.number().int(),
  size: z.number().int(),
});

export const MediaConstraintsSchema = z.object({
  contentType: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  minLongSide: z.number().optional(),
  maxLongSide: z.number().optional(),
  maxBytes: z.number(),
});

export const MediaTicketSchema = z.object({
  ticketId: z.string(),
  expiresAt: z.string(),
  provider: z.enum(["SUPABASE", "CLOUDINARY"]),
  objectPath: z.string().optional(),
  bucket: z.string().optional(),
  uploadPublicId: z.string().optional(),
  expectedPublicId: z.string().optional(),
  constraints: MediaConstraintsSchema,
});

export const MediaSchema = z.object({
  mediaId: z.number().int(),
  url: z.string(),
  width: z.number(),
  height: z.number(),
  purpose: z.enum(["BADGE", "INCIDENT"]),
});

export const IncidentSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  fileId: z.number().int().nullable(),
  file: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  photos: z.array(z.object({ mediaId: z.number().int(), url: z.string(), width: z.number(), height: z.number() })),
  createdBy: z.object({ id: z.number().int(), displayName: z.string() }),
  createdAt: z.string(),
});

export const IncidentPageSchema = z.object({
  content: z.array(IncidentSchema),
  totalElements: z.number().int(),
  totalPages: z.number().int(),
  page: z.number().int(),
  size: z.number().int(),
});

export const TicketSchema = z.object({ ticket: z.string(), expiresIn: z.number() });

export const RefinerUpdatedEventSchema = z.object({
  id: z.number().int(),
  version: z.number().int(),
  changes: z.array(z.string()).optional(),
  refiner: RefinerSchema,
  updatedBy: z.object({ userId: z.number().nullable(), displayName: z.string() }).optional(),
});
