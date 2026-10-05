import { defineStore } from 'pinia';
import type {
  AllocationState,
  AuditAction,
  AuditEntry,
  ClaimInput,
  ClaimOutcome,
  ConfirmOutcome,
  PendingRandomization,
  RandomizeInput
} from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';
import {
  cancelReservation as engineCancel,
  claimNumber,
  confirmNumber,
  createInitialState,
  emergencyUnblindEvent,
  expireReservations,
  markDispensed,
  remainingCapacity,
  stratumKey
} from '~/utils/allocation';

const STORAGE_KEY = 'trial-randomization-v2';
const LEGACY_KEY = 'trial-randomization-v1';

interface LegacyShape {
  participants: AllocationState['participants'];
  audits: AuditEntry[];
  pending: PendingRandomization[];
}

/** 旧版（一步发号）数据迁移：已入组者保留，号码池/账本等按初始状态重建 */
function migrate(): AllocationState {
  const state = createInitialState();
  if (!import.meta.client) return state;
  const legacyRaw = localStorage.getItem(LEGACY_KEY);
  if (!legacyRaw) return state;
  try {
    const legacy = JSON.parse(legacyRaw) as LegacyShape;
    // 仅迁移非演示身份标识，避免与种子记录撞号
    const seeded = new Set(state.participants.map((p) => p.participantNo));
    for (const p of legacy.participants) {
      if (seeded.has(p.participantNo)) continue;
      state.participants.unshift({ ...p, kitNo: p.kitNo ?? `KIT-${String(p.sequence).padStart(4, '0')}`, holdNo: p.holdNo ?? 'legacy' });
    }
    if (Array.isArray(legacy.audits)) state.audits.push(...legacy.audits.slice(0, 50));
    state.pending = Array.isArray(legacy.pending) ? legacy.pending : [];
  } catch {
    /* 损坏的旧快照直接忽略 */
  }
  return state;
}

function loadState(): AllocationState {
  const snapshot = readLocal<AllocationState | null>(STORAGE_KEY, null);
  if (snapshot && snapshot.version === 2) return snapshot;
  return migrate();
}

export const useTrialStore = defineStore('trial', {
  state: () => ({ ...loadState(), now: Date.now() }),
  getters: {
    activeReservations: (state): AllocationState['reservations'] =>
      state.reservations.filter((r) => r.status === 'reserved' && r.expiresAt > state.now),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    bySite: (state) =>
      state.participants.reduce<Record<string, number>>((result, participant) => {
        result[participant.site] = (result[participant.site] ?? 0) + 1;
        return result;
      }, {}),
    /** 各层中央容量口径：总量 / 已确认 / 预占中 / 排队 */
    capacityBoard: (state) => {
      const board: Record<string, { total: number; used: number; reserved: number; waiting: number; remaining: number }> = {};
      for (const key of Object.keys(state.capacity)) {
        const used = state.participants.filter((p) => stratumKey(p.site, p.ageBand) === key).length;
        const reserved = state.reservations.filter((r) => r.stratum === key && r.status === 'reserved' && r.expiresAt > state.now).length;
        const waiting = state.waitlist.filter((w) => w.stratum === key).length;
        board[key] = { total: state.capacity[key], used, reserved, waiting, remaining: state.capacity[key] - used - reserved };
      }
      return board;
    }
  },
  actions: {
    tick() {
      this.now = Date.now();
    },
    /** 触发一次超时扫描（组件定时器调用） */
    sweep(): boolean {
      const before = this.reservations.length + this.waitlist.length;
      const events = expireReservations(this.$state as AllocationState, Date.now());
      this.now = Date.now();
      if (events.length) {
        this.appendEvents(events, false);
        this.persist();
      }
      return this.reservations.length + this.waitlist.length !== before;
    },
    persist() {
      writeLocal(STORAGE_KEY, {
        version: 2,
        pool: this.pool,
        taken: this.taken,
        capacity: this.capacity,
        reservations: this.reservations,
        waitlist: this.waitlist,
        ledger: this.ledger,
        participants: this.participants,
        audits: this.audits,
        pending: this.pending
      } satisfies AllocationState);
    },
    appendEvents(events: { action: AuditAction; actor: string; detail: string; participantNo?: string }[], save = true) {
      for (const event of events) {
        this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...event });
      }
      if (save) this.persist();
    },
    /**
     * 第一阶段：领号预占。
     * 写盘失败时向上抛出，由界面用同一 holdNo 调 retryClaim 重试（幂等）。
     */
    claim(input: ClaimInput) {
      const { outcome, events } = claimNumber(this.$state as AllocationState, input, Date.now());
      this.appendEvents(events, false);
      this.persist();
      return outcome;
    },
    /** 写盘失败后按原预占编号重试领号：命中账本，直接回放，不重复占用 */
    retryClaim(input: ClaimInput): ClaimOutcome {
      const { outcome } = claimNumber(this.$state as AllocationState, input, Date.now());
      this.persist();
      return outcome;
    },
    /** 第二阶段：确认，CAS。写盘失败抛出，界面按 holdNo 重试。 */
    confirm(holdNo: string, expectedVersion: number, actor: string): ConfirmOutcome {
      const { outcome, events } = confirmNumber(this.$state as AllocationState, holdNo, expectedVersion, actor, Date.now());
      this.appendEvents(events, false);
      this.persist();
      return outcome;
    },
    retryConfirm(holdNo: string, expectedVersion: number, actor: string): ConfirmOutcome {
      const { outcome } = confirmNumber(this.$state as AllocationState, holdNo, expectedVersion, actor, Date.now());
      this.persist();
      return outcome;
    },
    cancel(holdNo: string, actor: string) {
      const events = engineCancel(this.$state as AllocationState, holdNo, actor, Date.now());
      if (events.length) {
        this.appendEvents(events);
      }
    },
    dispense(participantId: string, actor: string) {
      const events = markDispensed(this.$state as AllocationState, participantId, actor, Date.now());
      if (events.length) this.appendEvents(events);
    },
    /** 离线：模拟断网时的领号进入待提交队列，不占号码池 */
    queueOffline(input: RandomizeInput) {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.appendEvents([{ action: 'duplicate-blocked', actor: input.actor, detail: `拒绝重复入组：${input.participantNo}`, participantNo: input.participantNo }]);
        return { ok: false as const, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      this.pending.unshift({ id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' });
      this.appendEvents([{ action: 'pending-queued', actor: input.actor, detail: `离线领号进入待处理队列：${input.participantNo}（联网后走先领后确认）`, participantNo: input.participantNo }]);
      return { ok: true as const, message: '已加入待提交队列，联网后由协调员执行先领后确认' };
    },
    /** 离线队列恢复联网：按中央容量走两阶段（直接领号并确认） */
    commitPending(id: string, actor: string) {
      const item = this.pending.find((p) => p.id === id && p.status === 'pending');
      if (!item) return;
      const holdNo = crypto.randomUUID();
      const claimed = claimNumber(
        this.$state as AllocationState,
        { ...item.payload, actor, holdNo },
        Date.now()
      );
      this.appendEvents(claimed.events, false);
      if (!claimed.outcome.ok || claimed.outcome.status === 'queued') {
        this.persist();
        return { ok: false as const, message: claimed.outcome.ok ? '该层名额不足，已转入中央容量队列' : claimed.outcome.message };
      }
      const confirmed = confirmNumber(this.$state as AllocationState, holdNo, claimed.outcome.version, actor, Date.now());
      this.appendEvents(confirmed.events, false);
      if (confirmed.outcome.ok) {
        item.status = 'committed';
        this.appendEvents([{ action: 'pending-committed', actor, detail: `待提交记录已确认入库：${item.payload.participantNo}（预占 ${holdNo}）`, participantNo: item.payload.participantNo }], false);
      }
      this.persist();
      return confirmed.outcome.ok ? { ok: true as const, message: '待提交记录已完成领号并确认' } : { ok: false as const, message: confirmed.outcome.message };
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const event = emergencyUnblindEvent(this.$state as AllocationState, id, reason, actor, Date.now());
      if (event) this.appendEvents([event]);
    },
    capacityOf(site: string, ageBand: string) {
      const key = stratumKey(site, ageBand);
      return {
        ...this.capacityBoard[key],
        remaining: remainingCapacity(this.$state as AllocationState, key, Date.now())
      };
    }
  }
});
