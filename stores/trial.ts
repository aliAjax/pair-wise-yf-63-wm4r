import { defineStore } from 'pinia';
import type {
  Arm,
  AuditEntry,
  Block,
  Participant,
  PendingRandomization,
  RandomizeInput,
  Reservation,
  TrialConfig,
  WaitlistEntry,
  AgeBand
} from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v2';
const STRATUM_SEP = '||';

export const stratumKey = (site: string, ageBand: string) => `${site}${STRATUM_SEP}${ageBand}`;
export const parseStratum = (key: string) => {
  const [site, ageBand] = key.split(STRATUM_SEP);
  return { site, ageBand: ageBand as AgeBand };
};

/** 生成 1:1 均衡的区组治疗组排列（Fisher-Yates 洗牌） */
function permutedArms(size: number): Arm[] {
  const arms: Arm[] = [];
  for (let i = 0; i < size / 2; i++) arms.push('A', 'B');
  for (let i = arms.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arms[i], arms[j]] = [arms[j], arms[i]];
  }
  return arms;
}

function newBlock(stratum: string, blockNo: number, size: number): Block {
  return {
    id: crypto.randomUUID(),
    stratum,
    blockNo,
    size,
    arms: permutedArms(size),
    slots: Array.from({ length: size }, () => ({ status: 'available' as const }))
  };
}

function buildSeed() {
  const config: TrialConfig = { blockSize: 4, maxBlocksPerStratum: 3, claimTtlMs: 2 * 60 * 1000 };
  const s1: Participant = {
    id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心',
    ageBand: '45-64', status: 'randomized', sequence: 1001, dispensingNo: 'DY1001', arm: 'A'
  };
  const s2: Participant = {
    id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心',
    ageBand: '45-64', status: 'randomized', sequence: 1002, dispensingNo: 'DY1002', arm: 'B'
  };
  const block = newBlock(stratumKey('上海中心', '45-64'), 1, config.blockSize);
  block.slots[0].status = 'confirmed';
  block.slots[0].participantId = s1.id;
  block.slots[1].status = 'confirmed';
  block.slots[1].participantId = s2.id;
  const audits: AuditEntry[] = [
    {
      id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统',
      action: 'randomized', detail: 'S01-002 完成分层区组随机，中央随机号 1002，发药编号 DY1002',
      participantNo: 'S01-002'
    }
  ];
  return {
    participants: [s1, s2],
    audits,
    pending: [] as PendingRandomization[],
    blocks: [block],
    reservations: [] as Reservation[],
    waitlist: [] as WaitlistEntry[],
    config,
    sequenceCounter: 1002
  };
}

type SeedShape = ReturnType<typeof buildSeed>;

export const useTrialStore = defineStore('trial', {
  state: () => ({
    ...readLocal<SeedShape>(STORAGE_KEY, buildSeed()),
    /** 模拟写盘失败开关（仅内存态，不持久化） */
    simulateWriteFail: false
  }),
  getters: {
    bySite: (state) =>
      state.participants.reduce<Record<string, number>>((result, participant) => {
        result[participant.site] = (result[participant.site] ?? 0) + 1;
        return result;
      }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    activeReservations: (state) =>
      state.reservations.filter((item) => item.status === 'active'),
    waitingCount: (state) => state.waitlist.filter((item) => item.status === 'waiting' || item.status === 'offered').length,
    /** 某分层容量占用情况 */
    stratumOccupancy: (state) => (site: string, ageBand: string) => {
      const key = stratumKey(site, ageBand);
      const blocks = state.blocks.filter((b) => b.stratum === key);
      const held = blocks.reduce((n, b) => n + b.slots.filter((s) => s.status !== 'available').length, 0);
      const total = state.config.blockSize * state.config.maxBlocksPerStratum;
      return { held, total, available: total - held, blockCount: blocks.length };
    }
  },
  actions: {
    persist() {
      if (this.simulateWriteFail) throw new Error('WRITE_FAIL');
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        blocks: this.blocks,
        reservations: this.reservations,
        waitlist: this.waitlist,
        config: this.config,
        sequenceCounter: this.sequenceCounter
      });
    },
    persistSafe() {
      try {
        this.persist();
      } catch {
        /* 后台尽力而为，忽略写盘失败 */
      }
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        actor,
        action,
        detail,
        participantNo
      });
    },
    nextSequence(): number {
      this.sequenceCounter += 1;
      return this.sequenceCounter;
    },
    /** 在某分层下分配一个可用槽位；容量内自动开新区组，容量不足返回 null */
    allocateSlot(key: string): { block: Block; slotIndex: number } | null {
      let block = this.blocks.find((b) => b.stratum === key && b.slots.some((s) => s.status === 'available'));
      if (!block) {
        const count = this.blocks.filter((b) => b.stratum === key).length;
        if (count >= this.config.maxBlocksPerStratum) return null;
        block = newBlock(key, count + 1, this.config.blockSize);
        this.blocks.push(block);
      }
      const slotIndex = block.slots.findIndex((s) => s.status === 'available');
      return { block, slotIndex };
    },
    /** 超时收回：把过期预占的槽位放回区组，并按序叫号给排队者 */
    sweepExpired() {
      const now = Date.now();
      let changed = false;
      for (const r of this.reservations) {
        if (r.status !== 'active') continue;
        if (new Date(r.expiresAt).getTime() > now) continue;
        r.status = 'expired';
        const block = this.blocks.find((b) => b.id === r.blockId);
        const slot = block?.slots[r.slotIndex];
        if (block && slot && slot.status === 'reserved' && slot.reservationId === r.id) {
          slot.status = 'available';
          slot.reservationId = undefined;
        }
        this.addAudit('claim-expired', `预占 ${r.id} 超时未确认，随机号 ${r.sequence}、发药编号 ${r.dispensingNo} 已收回区组`, r.actor, r.participantNo);
        changed = true;
      }
      if (changed) {
        this.offerWaitlist();
        this.persistSafe();
      }
    },
    /** 定时巡检：收回超时预占，并在区组出现空位（过期/放弃/扩容）时按序叫号 */
    tick() {
      this.sweepExpired();
      this.offerWaitlist();
    },
    /** 区组有空位时，按 FIFO 给排队者叫号（生成新预占） */
    offerWaitlist() {
      const waiting = this.waitlist
        .filter((w) => w.status === 'waiting')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      let offered = false;
      for (const w of waiting) {
        const allocated = this.allocateSlot(w.stratum);
        if (!allocated) continue;
        const { block, slotIndex } = allocated;
        const slot = block.slots[slotIndex];
        const seq = this.nextSequence();
        const id = crypto.randomUUID();
        const token = crypto.randomUUID();
        const reservation: Reservation = {
          id,
          stratum: w.stratum,
          blockId: block.id,
          slotIndex,
          sequence: seq,
          dispensingNo: `DY${seq}`,
          arm: block.arms[slotIndex],
          actor: w.actor,
          token,
          status: 'active',
          version: 1,
          claimedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + this.config.claimTtlMs).toISOString(),
          participantNo: w.payload.participantNo,
          identityKey: w.payload.identityKey
        };
        slot.status = 'reserved';
        slot.reservationId = id;
        this.reservations.push(reservation);
        w.status = 'offered';
        w.reservationId = id;
        offered = true;
        this.addAudit('waitlist-offered', `排队叫号：${w.payload.participantNo} 已分配预占 ${id}，随机号 ${seq}，发药编号 DY${seq}`, w.actor, w.payload.participantNo);
      }
      if (offered) this.persistSafe();
    },
    /**
     * 领号（先领）：协调员按分层区组预占一个槽位，处理期间他人不可见/不可领。
     * clientKey 为客户端幂等键（即预占编号），写盘失败后按它重试，号码与名额不重复占。
     */
    claim(input: RandomizeInput, clientKey?: string): {
      ok: boolean;
      message: string;
      reservationId?: string;
      token?: string;
      retryable?: boolean;
      queued?: boolean;
      waitlistId?: string;
      expired?: boolean;
    } {
      this.sweepExpired();
      // 幂等：同一预占编号重试，直接返回已有结果，不重复占号
      if (clientKey) {
        const existing = this.reservations.find((r) => r.id === clientKey);
        if (existing) {
          if (existing.status === 'confirmed') {
            return { ok: true, message: '预占已确认入库（重复提交未重复占号）', reservationId: existing.id, token: existing.token };
          }
          if (existing.status === 'active') {
            return { ok: true, message: '预占仍有效', reservationId: existing.id, token: existing.token };
          }
          return { ok: false, expired: true, message: '预占已失效，请重新领号', reservationId: existing.id };
        }
      }
      // 防重复入组（在占号之前拦截）
      if (this.participants.some((p) => p.identityKey === input.identityKey || p.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        this.persistSafe();
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      const key = stratumKey(input.site, input.ageBand);
      const allocated = this.allocateSlot(key);
      if (!allocated) {
        // 名额不足 → 按中央容量排队
        const entry: WaitlistEntry = {
          id: crypto.randomUUID(),
          stratum: key,
          payload: { ...input },
          actor: input.actor,
          status: 'waiting',
          createdAt: new Date().toISOString()
        };
        this.waitlist.push(entry);
        this.addAudit('waitlist-queued', `名额已满，进入中央容量排队：${input.participantNo}，排队号 ${entry.id}`, input.actor, input.participantNo);
        this.persistSafe();
        return { ok: false, queued: true, waitlistId: entry.id, message: '当前分层名额已满，已进入中央容量排队；有空位将按序叫号' };
      }
      const { block, slotIndex } = allocated;
      const slot = block.slots[slotIndex];
      const seq = this.nextSequence();
      const id = clientKey ?? crypto.randomUUID();
      const token = crypto.randomUUID();
      const reservation: Reservation = {
        id,
        stratum: key,
        blockId: block.id,
        slotIndex,
        sequence: seq,
        dispensingNo: `DY${seq}`,
        arm: block.arms[slotIndex],
        actor: input.actor,
        token,
        status: 'active',
        version: 1,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.config.claimTtlMs).toISOString(),
        participantNo: input.participantNo,
        identityKey: input.identityKey
      };
      slot.status = 'reserved';
      slot.reservationId = id;
      this.reservations.push(reservation);
      this.addAudit('claim-created', `预占领号：${input.participantNo} 随机号 ${seq}，发药编号 DY${seq}，区组 ${block.blockNo} 槽位 ${slotIndex + 1}，有效期 ${Math.round(this.config.claimTtlMs / 1000)} 秒`, input.actor, input.participantNo);
      try {
        this.persist();
      } catch {
        // 写盘失败：内存预占保留，返回可重试；按预占编号幂等重试，不重复占号
        return { ok: false, retryable: true, reservationId: id, token, message: '写盘失败：预占未持久化，请按预占编号重试（不会重复占号）' };
      }
      return {
        ok: true,
        message: `领号成功：随机号 ${seq}，发药编号 DY${seq}，请在 ${Math.round(this.config.claimTtlMs / 1000)} 秒内确认入组`,
        reservationId: id,
        token
      };
    },
    /**
     * 确认入组（后确认）：凭预占编号 + 确认令牌提交。
     * 号码已被收回/转给他人（令牌不符）或两人同时提交时，只让一边成功。
     */
    confirm(reservationId: string, token: string, actor: string): {
      ok: boolean;
      message: string;
      participant?: Participant;
      conflict?: boolean;
      retryable?: boolean;
    } {
      this.sweepExpired();
      const r = this.reservations.find((x) => x.id === reservationId);
      if (!r) {
        return { ok: false, message: '预占编号不存在或已被收回，请重新领号' };
      }
      // 令牌校验优先：令牌不符 → 号码已被收回或转发他人，无论单据处于何种状态都是冲突，仅一边可成功
      if (r.token !== token) {
        this.addAudit('claim-conflict', `确认冲突：预占 ${r.id} 令牌不匹配，号码可能已被收回或转发他人`, actor, r.participantNo);
        this.persistSafe();
        return { ok: false, conflict: true, message: '确认失败：预占已被收回或已转给他人，仅一边可成功' };
      }
      // 幂等：已确认且令牌一致 → 重复提交直接返回原结果（两人同时提交只产生一条记录）
      if (r.status === 'confirmed') {
        const existing = this.participants.find((p) => p.reservationId === r.id);
        this.persistSafe();
        return { ok: true, message: '预占已确认入库（重复提交未重复占号）', participant: existing };
      }
      if (r.status === 'expired') {
        return { ok: false, conflict: true, message: '预占已超时收回，号码已转回区组，请重新领号' };
      }
      if (r.status === 'cancelled') {
        return { ok: false, conflict: true, message: '预占已放弃，请重新领号' };
      }
      // 槽位必须仍处于 reserved 且归属本预占
      const block = this.blocks.find((b) => b.id === r.blockId);
      const slot = block?.slots[r.slotIndex];
      if (!block || !slot || slot.status !== 'reserved' || slot.reservationId !== r.id) {
        this.addAudit('claim-conflict', `确认冲突：预占 ${r.id} 槽位状态异常`, actor, r.participantNo);
        this.persistSafe();
        return { ok: false, conflict: true, message: '确认失败：号码已不在本预占下' };
      }
      if (this.participants.some((p) => p.identityKey === r.identityKey || p.participantNo === r.participantNo)) {
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      const { site, ageBand } = parseStratum(r.stratum);
      const participant: Participant = {
        id: crypto.randomUUID(),
        participantNo: r.participantNo!,
        identityKey: r.identityKey!,
        site,
        ageBand,
        status: 'randomized',
        sequence: r.sequence,
        dispensingNo: r.dispensingNo,
        arm: r.arm,
        reservationId: r.id
      };
      slot.status = 'confirmed';
      slot.participantId = participant.id;
      r.status = 'confirmed';
      r.confirmedAt = new Date().toISOString();
      r.version += 1;
      this.participants.unshift(participant);
      this.addAudit('claim-confirmed', `预占确认入库：${participant.participantNo} 随机号 ${participant.sequence}，发药编号 ${participant.dispensingNo}`, actor, participant.participantNo);
      try {
        this.persist();
      } catch {
        return { ok: false, retryable: true, message: '写盘失败：确认未持久化，请按预占编号重试（不会重复占号）' };
      }
      return { ok: true, message: `入组成功：随机号 ${participant.sequence}，发药编号 ${participant.dispensingNo}（治疗组按角色隐藏）`, participant };
    },
    /** 放弃预占：槽位放回区组并按序叫号 */
    cancelReservation(reservationId: string, actor: string) {
      const r = this.reservations.find((x) => x.id === reservationId && x.status === 'active');
      if (!r) return;
      r.status = 'cancelled';
      const block = this.blocks.find((b) => b.id === r.blockId);
      const slot = block?.slots[r.slotIndex];
      if (block && slot && slot.status === 'reserved' && slot.reservationId === r.id) {
        slot.status = 'available';
        slot.reservationId = undefined;
      }
      this.addAudit('claim-cancelled', `预占 ${r.id} 已放弃，随机号 ${r.sequence} 收回区组`, actor, r.participantNo);
      this.offerWaitlist();
      this.persistSafe();
    },
    /** 离线提交进入待处理队列（原有断网队列流程） */
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string } {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        this.persistSafe();
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = {
          id: crypto.randomUUID(),
          payload: { ...input },
          createdAt: new Date().toISOString(),
          status: 'pending'
        };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        this.persistSafe();
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return { ok: false, message: '在线请先领号再确认入组' };
    },
    /** 离线记录联网后确认入库：系统自动分配槽位并即时确认 */
    commitPending(id: string, actor: string) {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return;
      const input = pending.payload;
      if (this.participants.some((p) => p.identityKey === input.identityKey || p.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `待提交记录重复，拒绝入库：${input.participantNo}`, actor, input.participantNo);
        pending.status = 'committed';
        this.persistSafe();
        return;
      }
      this.sweepExpired();
      const key = stratumKey(input.site, input.ageBand);
      const allocated = this.allocateSlot(key);
      if (!allocated) {
        this.addAudit('write-failed', `待提交记录入库失败：${input.participantNo} 名额已满，请稍后重试`, actor, input.participantNo);
        this.persistSafe();
        return;
      }
      const { block, slotIndex } = allocated;
      const slot = block.slots[slotIndex];
      const seq = this.nextSequence();
      const participant: Participant = {
        id: crypto.randomUUID(),
        participantNo: input.participantNo,
        identityKey: input.identityKey,
        site: input.site,
        ageBand: input.ageBand,
        status: 'randomized',
        sequence: seq,
        dispensingNo: `DY${seq}`,
        arm: block.arms[slotIndex]
      };
      slot.status = 'confirmed';
      slot.participantId = participant.id;
      pending.status = 'committed';
      this.participants.unshift(participant);
      this.addAudit('pending-committed', `待提交记录已确认入库：${input.participantNo} 随机号 ${seq}，发药编号 DY${seq}`, actor, input.participantNo);
      this.persistSafe();
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
      this.persistSafe();
    }
  }
});
