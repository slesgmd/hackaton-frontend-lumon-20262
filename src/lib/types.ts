export type Permission =
  | "files:read"
  | "files:refine"
  | "refiners:read"
  | "refiners:write"
  | "media:upload"
  | "incidents:read"
  | "incidents:create"
  | "team:manage";

export interface User {
  id: number;
  email: string;
  displayName: string;
}

export interface TeamInfo {
  code: string;
  name: string;
}

export interface RoleInfo {
  code: string;
  name: string;
}

export interface ClearanceStatus {
  granted: boolean;
  grantedAt: string | null;
}

export interface Me {
  id: number;
  email: string;
  displayName: string;
  team: TeamInfo;
  role: RoleInfo;
  permissions: Permission[];
  clearance: ClearanceStatus;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResponse extends TokenPair {
  user: User;
}

export interface RegisterResponse extends TokenPair {
  user: User;
  team: TeamInfo;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details: unknown;
  timestamp: string;
  path: string;
  requestId: string;
}

export interface ValidationErrorDetails {
  fields?: Record<string, string>;
}

export interface Progress {
  WO: number;
  FC: number;
  DR: number;
  MA: number;
  overall: number;
}

export type FileStatus = "ACTIVE" | "COMPLETE";
export type Bin = "WO" | "FC" | "DR" | "MA";
export type BinChar = "." | "W" | "F" | "D" | "M";

export interface DataFile {
  id: number;
  name: string;
  rows: number;
  cols: number;
  tileSize: number;
  status: FileStatus;
  progress: Progress;
  refinedGroups: number;
  totalGroups: number;
  mistakes: number;
  updatedAt: string;
}

export interface FilePage {
  content: DataFile[];
  totalElements: number;
  totalPages: number;
  page: number;
  size: number;
}

export interface Rules {
  tremorThreshold: number;
  connectivity: 4 | 8;
  minGroupSize: number;
  maxGroupSize: number;
  binning: {
    strategy: string;
    order: Bin[];
  };
}

export interface Tile {
  tileRow: number;
  tileCol: number;
  originRow: number;
  originCol: number;
  rows: number;
  cols: number;
  values: string;
  tremor: string;
  bins: string;
  version: number;
}

export interface CellRef {
  r: number;
  c: number;
}

export interface RefineResult {
  refinementId: number;
  bin: Bin;
  size: number;
  file: {
    progress: Progress;
    refinedGroups: number;
    totalGroups: number;
    mistakes: number;
    status: FileStatus;
  };
}

export interface Department {
  id: number;
  code: string;
  name: string;
}

export interface BadgeMedia {
  url: string;
  width: number;
  height: number;
}

export interface Refiner {
  id: number;
  fullName: string;
  department: Department;
  title: string;
  extension: string;
  bio: string;
  profileUrl: string | null;
  badge: BadgeMedia | null;
  version: number;
  updatedAt: string;
}

export interface RefinerPage {
  content: Refiner[];
  totalElements: number;
  totalPages: number;
  page: number;
  size: number;
}

export interface RefinerPatch {
  title?: string;
  extension?: string;
  bio?: string;
  departmentId?: number;
  badgeMediaId?: number | null;
}

export type MediaPurpose = "BADGE" | "INCIDENT";

export interface MediaConstraints {
  contentType: "image/webp";
  width?: number;
  height?: number;
  minLongSide?: number;
  maxLongSide?: number;
  maxBytes: number;
}

export interface MediaTicket {
  ticketId: string;
  expiresAt: string;
  provider: "SUPABASE" | "CLOUDINARY";
  objectPath?: string;
  bucket?: string;
  uploadPublicId?: string;
  expectedPublicId?: string;
  constraints: MediaConstraints;
}

export interface Media {
  mediaId: number;
  url: string;
  width: number;
  height: number;
  purpose: MediaPurpose;
}

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface IncidentPhoto {
  mediaId: number;
  url: string;
  width: number;
  height: number;
}

export interface Incident {
  id: number;
  title: string;
  description: string;
  severity: Severity;
  fileId: number | null;
  file: { id: number; name: string } | null;
  photos: IncidentPhoto[];
  createdBy: { id: number; displayName: string };
  createdAt: string;
}

export interface IncidentPage {
  content: Incident[];
  totalElements: number;
  totalPages: number;
  page: number;
  size: number;
}

export interface RosterMember {
  name: string;
  code: string;
}

export interface Roster {
  members: RosterMember[];
  complete: boolean;
  locked: boolean;
}

export interface ClearanceCheck {
  name: "DEPLOY" | "SESSION" | "GRID" | "REFINE";
  passed: boolean;
  detail: string;
}

export interface RoundInfo {
  round: number;
  startsAt: string;
  endsAt: string;
}

export interface RoundState {
  approved: boolean;
  approvedAt: string | null;
  approvedRound: number | null;
  nextRoundAt: string | null;
  nextRound: RoundInfo | null;
  drawnMember: { round: number; name: string; code: string; startsAt: string } | null;
  attempts: Array<{
    round: number;
    startsAt: string;
    member: { name: string; code: string };
    result: "PASSED" | "FAILED" | "ABSENT" | null;
    gradedAt: string | null;
  }>;
  schedule: RoundInfo[];
}

export interface Clearance {
  granted: boolean;
  grantedAt: string | null;
  checks: ClearanceCheck[];
  checkedAt: string | null;
  workspace: { kind: "DEV" | "EVAL"; chaosLevel: 0 | 1 | 2 };
  roster: Roster;
  round: RoundState;
}

export interface IntegrationStatus {
  deploy: {
    origin: string | null;
    verifiedAt: string | null;
    lastBuildSeen: string | null;
    lastBuildSeenAt: string | null;
    pendingChallenge: { origin: string; expiresAt: string } | null;
  };
  storage: {
    provider: "SUPABASE" | "CLOUDINARY" | null;
    verifiedAt: string | null;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
    config: {
      projectUrl?: string;
      bucket?: string;
      cloudName?: string;
      uploadPreset?: string;
    } | null;
  };
  clearance: ClearanceStatus;
}

export interface StreamTicket {
  ticket: string;
  expiresIn: number;
}

export interface FloorTicket {
  ticket: string;
  expiresIn: number;
}

export interface FloorMember {
  userId: number;
  displayName: string;
}

export interface FloorClaim {
  claimId: string;
  userId: number;
  cells: CellRef[];
  expiresAt: string;
}

export interface FloorCursor {
  userId: number;
  r: number;
  c: number;
  displayName?: string;
}

export type FloorServerMessage =
  | { type: "snapshot"; seq: number; members: FloorMember[]; claims: FloorClaim[] }
  | { type: "member.joined"; seq: number; userId: number; displayName: string }
  | { type: "member.left"; seq: number; userId: number; displayName: string }
  | { type: "cursor"; userId: number; r: number; c: number; displayName?: string }
  | {
      type: "claim.granted";
      seq: number;
      requestId: string;
      claimId: string;
      cells: CellRef[];
      expiresAt: string;
    }
  | {
      type: "claim.denied";
      requestId: string;
      reason: "HELD" | "NOT_A_GROUP";
      holder?: { userId: number; displayName: string };
    }
  | {
      type: "claim.updated" | "claim.released";
      seq: number;
      claimId: string;
      userId: number;
      cells: CellRef[];
      expiresAt: string;
    }
  | { type: "pong"; t: number };

export interface RealtimeEvent<T = unknown> {
  event: string;
  data: T;
  id: string | null;
}

export interface RefinerUpdatedEvent {
  id: number;
  version: number;
  changes: string[];
  refiner: Refiner;
  updatedBy: { userId: number | null; displayName: string };
}

export interface RefinementCreatedEvent {
  fileId: number;
  refinementId: number;
  cells: CellRef[];
  bin: Bin;
  progress: Progress;
  refinedBy: { userId: number; displayName: string };
}

export interface FileCompletedEvent {
  fileId: number;
  name: string;
}

export interface ContingencyEvent {
  id: number;
  userId: number;
  status: string;
  reason?: string;
}

export interface SessionRevokedEvent {
  reason: string;
}
