export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AgeBand = '18-44' | '45-64' | '65+';
export type AuditAction =
  | 'number-claimed'
  | 'number-released'
  | 'number-confirmed'
  | 'number-queued'
  | 'number-promoted'
  | 'number-cancelled'
  | 'confirm-conflict'
  | 'write-retried'
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'dispensed';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  status: 'randomized' | 'unblinded';
  sequence: number;
  kitNo: string;
  holdNo: string;
  arm?: Arm;
  unblindedAt?: string;
  dispensedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
  /** 组别字段单独存放，由展示层按角色边界决定是否可见 */
  arm?: Arm;
}

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: 'pending' | 'committed';
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  actor: string;
}

/** 分层区组中的一个可发号码 */
export interface NumberPoolEntry {
  sequence: number;
  kitNo: string;
  arm: Arm;
  blockNo: number;
}

/** 已占用号码（待确认 / 已确认），放回时恢复为池内 NumberPoolEntry */
export interface TakenNumber {
  sequence: number;
  kitNo: string;
  arm: Arm;
  blockNo: number;
  participantNo: string;
}

/** 领号预占：协调员持有、处理期间别人领不到 */
export interface Reservation {
  holdNo: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  stratum: string;
  actor: string;
  sequence: number;
  kitNo: string;
  arm: Arm;
  blockNo: number;
  claimedAt: number;
  expiresAt: number;
  version: number;
  status: 'reserved' | 'queued' | 'confirmed';
}

/** 中央容量排队：本层名额不够时排队等待 */
export interface WaitEntry {
  holdNo: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  stratum: string;
  actor: string;
  queuedAt: number;
}

/** 写盘失败后按预占编号幂等重试的记忆账本 */
export interface IdempotencyRecord {
  holdNo: string;
  phase: 'claim' | 'confirm';
  result: ClaimOutcome | ConfirmOutcome;
  /** 首次成功执行的协调员，用于辨认另一方的并发重复提交 */
  actor: string;
  at: number;
}

export interface ConfirmSuccess {
  ok: true;
  sequence: number;
  kitNo: string;
  arm: Arm;
  participantId: string;
  /** true 表示命中幂等账本，未再次占用号码与名额 */
  replayed?: boolean;
}

/** 引擎快照（纯数据，可 JSON 持久化） */
export interface AllocationState {
  version: 2;
  pool: Record<string, NumberPoolEntry[]>;
  taken: Record<string, TakenNumber[]>;
  capacity: Record<string, number>;
  reservations: Reservation[];
  waitlist: WaitEntry[];
  ledger: IdempotencyRecord[];
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
}

export interface ClaimInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  actor: string;
  /** 客户端预先生成的预占编号，写盘失败后原样重试 */
  holdNo: string;
}

export type ClaimOutcome =
  | { ok: true; status: 'reserved'; holdNo: string; sequence: number; kitNo: string; expiresAt: number; version: number; arm: Arm }
  | { ok: true; status: 'queued'; holdNo: string; position: number; message: string }
  | { ok: false; code: 'duplicate'; message: string };

export type ConfirmOutcome =
  | ConfirmSuccess
  | { ok: false; code: 'gone' | 'mismatch' | 'conflict'; message: string };
