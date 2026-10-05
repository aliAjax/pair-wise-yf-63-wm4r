export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AgeBand = '18-44' | '45-64' | '65+';

/** 区组槽位状态：可用 / 预占中 / 已确认入组 */
export type SlotStatus = 'available' | 'reserved' | 'confirmed';
/** 预占单状态：有效 / 已确认 / 已超时收回 / 已放弃 */
export type ReservationStatus = 'active' | 'confirmed' | 'expired' | 'cancelled';
/** 排队单状态：等待中 / 已叫号 / 已确认 / 已取消 */
export type WaitlistStatus = 'waiting' | 'offered' | 'confirmed' | 'cancelled';

export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'claim-created'
  | 'claim-confirmed'
  | 'claim-expired'
  | 'claim-cancelled'
  | 'claim-conflict'
  | 'waitlist-queued'
  | 'waitlist-offered'
  | 'write-failed';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  status: 'randomized' | 'unblinded';
  /** 中央随机号（研究者/监察员可见） */
  sequence: number;
  /** 发药编号（药品管理员唯一可见的发药标识） */
  dispensingNo: string;
  arm?: Arm;
  unblindedAt?: string;
  /** 来源预占编号 */
  reservationId?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
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

/** 区组内槽位 */
export interface BlockSlot {
  status: SlotStatus;
  reservationId?: string;
  participantId?: string;
}

/** 分层区组：每个分层下若干固定大小、治疗组排列随机的区组 */
export interface Block {
  id: string;
  /** 分层键：site || ageBand */
  stratum: string;
  blockNo: number;
  size: number;
  /** 区组内治疗组排列（1:1 均衡） */
  arms: Arm[];
  slots: BlockSlot[];
}

/** 预占单：先领后确认的核心单据 */
export interface Reservation {
  /** 预占编号（同时作为幂等键，写盘失败后按它重试） */
  id: string;
  stratum: string;
  blockId: string;
  slotIndex: number;
  /** 中央随机号 */
  sequence: number;
  /** 发药编号 */
  dispensingNo: string;
  /** 治疗组：系统内部分配，对研究者隐藏，药品管理员按角色边界不可见 */
  arm: Arm;
  actor: string;
  /** 确认令牌（乐观锁）：仅当前持号人可确认，号码被收回/转发后旧令牌失效 */
  token: string;
  status: ReservationStatus;
  version: number;
  claimedAt: string;
  expiresAt: string;
  confirmedAt?: string;
  participantNo?: string;
  identityKey?: string;
}

/** 中央容量排队单 */
export interface WaitlistEntry {
  id: string;
  stratum: string;
  payload: RandomizeInput;
  actor: string;
  status: WaitlistStatus;
  createdAt: string;
  reservationId?: string;
}

export interface TrialConfig {
  /** 每个区组大小 */
  blockSize: number;
  /** 每个分层最多开区组数（中央容量 = blockSize * maxBlocksPerStratum） */
  maxBlocksPerStratum: number;
  /** 预占超时时长（毫秒） */
  claimTtlMs: number;
}
