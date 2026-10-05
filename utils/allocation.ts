import type {
  AllocationState,
  Arm,
  AuditAction,
  AuditEntry,
  ClaimInput,
  ClaimOutcome,
  ConfirmOutcome,
  NumberPoolEntry,
  Reservation,
  TakenNumber,
  WaitEntry,
  ConfirmSuccess
} from '~/types/trial';

/** 领号处理期：期间别人领不到同一号码；超时未确认号码放回区组再发 */
export const HOLD_TTL_MS = 30 * 60 * 1000;
/** 前端演示用缩短到 45 秒，便于观察超时放回与排队补位 */
export const HOLD_TTL_DEMO_MS = 45 * 1000;
const DEFAULT_STRATUM_CAPACITY = 6;
const BLOCK_SIZE = 4;
const SEQUENCE_BASE = 1000;
const AGE_BANDS = ['18-44', '45-64', '65+'] as const;
const SITES = ['上海中心', '广州中心', '新加坡中心'] as const;

export const stratumKey = (site: string, ageBand: string) => `${site}|${ageBand}`;

/** 确定性伪随机（LCG），相同种子生成相同区组序列，避免刷新漂移 */
function lcg(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** 生成平衡区组：每块 A/B 等量，块内 Fisher-Yates 洗牌 */
function buildBlocks(count: number, seed: number): { arm: Arm; consumed: number; blockNo: number }[] {
  const rand = lcg(seed);
  const rows: { arm: Arm; consumed: number; blockNo: number }[] = [];
  let blockNo = 1;
  let made = 0;
  while (made < count) {
    const take = Math.min(BLOCK_SIZE, count - made);
    const slots: Arm[] = [];
    const half = Math.floor(take / 2);
    for (let i = 0; i < half; i++) slots.push('A', 'B');
    if (take % 2 === 1) slots.push(rand() < 0.5 ? 'A' : 'B');
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    slots.forEach((arm) => {
      made += 1;
      rows.push({ arm, consumed: made, blockNo });
    });
    blockNo += 1;
  }
  return rows;
}

function hashSeed(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h + 1;
}

/** 发药编号按全局序号编码，药品管理员只凭此编号发药，不反推治疗组 */
export const kitOf = (sequence: number) => `KIT-${String(sequence).padStart(4, '0')}`;

export function createInitialState(): AllocationState {
  const pool: AllocationState['pool'] = {};
  const taken: AllocationState['taken'] = {};
  const capacity: Record<string, number> = {};
  let cursor = 0;

  for (const site of SITES) {
    for (const ageBand of AGE_BANDS) {
      const key = stratumKey(site, ageBand);
      capacity[key] = DEFAULT_STRATUM_CAPACITY;
      taken[key] = [];
      // 区组始终完整（容量向上取整到区组倍数），尾块多出的号受容量约束不会被发出
      const blockAligned = Math.ceil(DEFAULT_STRATUM_CAPACITY / BLOCK_SIZE) * BLOCK_SIZE;
      const blocks = buildBlocks(blockAligned, hashSeed(key));
      pool[key] = blocks.map<NumberPoolEntry>((row) => {
        cursor += 1;
        return { sequence: SEQUENCE_BASE + cursor, kitNo: kitOf(SEQUENCE_BASE + cursor), arm: row.arm, blockNo: row.blockNo };
      });
    }
  }

  // 预置两名已确认受试者（上海/45-64 层前两个号），号码从池中摘除并计入 taken
  const stratum = stratumKey('上海中心', '45-64');
  const [n1, n2] = pool[stratum].splice(0, 2);
  const now = Date.now();
  taken[stratum].push(
    { sequence: n1.sequence, kitNo: n1.kitNo, arm: n1.arm, blockNo: n1.blockNo, participantNo: 'S01-001' },
    { sequence: n2.sequence, kitNo: n2.kitNo, arm: n2.arm, blockNo: n2.blockNo, participantNo: 'S01-002' }
  );

  const audits: AuditEntry[] = [
    {
      id: crypto.randomUUID(),
      at: new Date(now - 3600_000).toISOString(),
      actor: '系统',
      action: 'number-confirmed',
      detail: 'S01-002 确认入组，分层区组号码 1002，发药编号 KIT-1002',
      participantNo: 'S01-002'
      // 审计记录不携带 arm，审计视图对所有角色遵循同一隐藏边界
    }
  ];

  return {
    version: 2,
    pool,
    taken,
    capacity,
    reservations: [],
    waitlist: [],
    ledger: [],
    participants: [
      { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: n1.sequence, kitNo: n1.kitNo, holdNo: 'seed-1', arm: n1.arm },
      { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: n2.sequence, kitNo: n2.kitNo, holdNo: 'seed-2', arm: n2.arm }
    ],
    audits,
    pending: []
  };
}

/** 已确认入组占用的名额 */
export function usedCount(state: AllocationState, stratum: string): number {
  return state.participants.filter((p) => stratumKey(p.site, p.ageBand) === stratum).length;
}

/** 有效预占（未超时）占用的名额 */
function liveReservations(state: AllocationState, now: number): Reservation[] {
  return state.reservations.filter((r) => r.status === 'reserved' && r.expiresAt > now);
}

export function remainingCapacity(state: AllocationState, stratum: string, now: number): number {
  const reserved = liveReservations(state, now).filter((r) => r.stratum === stratum).length;
  return (state.capacity[stratum] ?? 0) - usedCount(state, stratum) - reserved;
}

/** 可发号码：池内且未被有效预占取走 */
function availableNumbers(state: AllocationState, stratum: string, now: number): NumberPoolEntry[] {
  const locked = new Set(liveReservations(state, now).map((r) => r.sequence));
  return (state.pool[stratum] ?? []).filter((n) => !locked.has(n.sequence));
}

export interface AuditEvent {
  action: AuditAction;
  actor: string;
  detail: string;
  participantNo?: string;
}

function eventOf(action: AuditAction, actor: string, detail: string, participantNo?: string): AuditEvent {
  return { action, actor, detail, participantNo };
}

/**
 * 回收所有超时预占：号码仍留在池中（池条目天然还在），预占解除即可被他人领取；
 * 若对应层有排队者，队首自动补位。
 */
export function expireReservations(state: AllocationState, now: number): AuditEvent[] {
  const events: AuditEvent[] = [];
  const expiredStrata = new Set<string>();
  const expired = state.reservations.filter((r) => r.status === 'reserved' && r.expiresAt <= now);
  for (const r of expired) {
    expiredStrata.add(r.stratum);
    events.push(eventOf('number-released', '系统', `预占 ${r.holdNo} 超时未确认，号码 ${r.sequence} 放回 ${r.site}/${r.ageBand} 区组再发`, r.participantNo));
  }
  if (expired.length) state.reservations = state.reservations.filter((r) => !(r.status === 'reserved' && r.expiresAt <= now));
  promoteWaitlist(state, now, events, expiredStrata);
  return events;
}

/** 队首补位：为排队者建立预占（同 holdNo） */
function promoteWaitlist(state: AllocationState, now: number, events: AuditEvent[], strata: Iterable<string>) {
  for (const stratum of new Set(strata)) {
    for (;;) {
      if (remainingCapacity(state, stratum, now) <= 0) break;
      const idx = state.waitlist.findIndex((w) => w.stratum === stratum);
      if (idx < 0) break;
      const nums = availableNumbers(state, stratum, now);
      if (nums.length === 0) break;
      const wait = state.waitlist.splice(idx, 1)[0];
      const picked = nums[0];
      state.reservations.push(buildReservation(wait, picked, now));
      events.push(eventOf('number-promoted', '系统', `排队补位：${wait.participantNo} 获得号码 ${picked.sequence}（预占 ${wait.holdNo}），请尽快确认`, wait.participantNo));
    }
  }
}

function buildReservation(wait: WaitEntry, picked: NumberPoolEntry, now: number): Reservation {
  return {
    holdNo: wait.holdNo,
    participantNo: wait.participantNo,
    identityKey: wait.identityKey,
    site: wait.site,
    ageBand: wait.ageBand,
    stratum: wait.stratum,
    actor: wait.actor,
    sequence: picked.sequence,
    kitNo: picked.kitNo,
    arm: picked.arm,
    blockNo: picked.blockNo,
    claimedAt: now,
    expiresAt: now + HOLD_TTL_DEMO_MS,
    version: 1,
    status: 'reserved'
  };
}

function isDuplicate(state: AllocationState, input: ClaimInput): boolean {
  return (
    state.participants.some((p) => p.identityKey === input.identityKey || p.participantNo === input.participantNo) ||
    state.reservations.some((r) => r.identityKey === input.identityKey || r.participantNo === input.participantNo) ||
    state.waitlist.some((w) => w.identityKey === input.identityKey || w.participantNo === input.participantNo)
  );
}

function remember(state: AllocationState, holdNo: string, phase: 'claim' | 'confirm', result: ClaimOutcome | ConfirmOutcome, now: number, actor: string) {
  state.ledger = state.ledger.filter((l) => !(l.holdNo === holdNo && l.phase === phase));
  state.ledger.unshift({ holdNo, phase, result, actor, at: now });
  if (state.ledger.length > 200) state.ledger.length = 200;
}

/**
 * 领号（第一阶段）。
 * 按分层区组取号预占；名额不足进中央容量队列；
 * holdNo 幂等：写盘失败后用同一预占编号重试，回放上次结果，号码与名额不重复占。
 */
export function claimNumber(state: AllocationState, input: ClaimInput, now: number): { outcome: ClaimOutcome; events: AuditEvent[] } {
  const replay = state.ledger.find((l) => l.holdNo === input.holdNo && l.phase === 'claim');
  if (replay) {
    const cached = replay.result as ClaimOutcome;
    // 排队者已被自动补位为预占时，回放要反映当前状态，不能停留在 queued
    if (cached.ok && cached.status === 'queued') {
      const promoted = state.reservations.find((r) => r.holdNo === input.holdNo && r.status === 'reserved');
      if (promoted) {
        return {
          outcome: {
            ok: true,
            status: 'reserved',
            holdNo: promoted.holdNo,
            sequence: promoted.sequence,
            kitNo: promoted.kitNo,
            expiresAt: promoted.expiresAt,
            version: promoted.version,
            arm: promoted.arm
          },
          events: []
        };
      }
    }
    return { outcome: cached, events: [] };
  }

  const events = expireReservations(state, now);

  if (isDuplicate(state, input)) {
    const outcome: ClaimOutcome = { ok: false, code: 'duplicate', message: '身份标识或受试者编号已存在（含预占/排队中），已阻止重复领号' };
    remember(state, input.holdNo, 'claim', outcome, now, input.actor);
    events.push(eventOf('duplicate-blocked', input.actor, `拒绝重复领号：${input.participantNo}`, input.participantNo));
    return { outcome, events };
  }

  const stratum = stratumKey(input.site, input.ageBand);
  const nums = availableNumbers(state, stratum, now);

  if (remainingCapacity(state, stratum, now) <= 0 || nums.length === 0) {
    state.waitlist.push({
      holdNo: input.holdNo,
      participantNo: input.participantNo,
      identityKey: input.identityKey,
      site: input.site,
      ageBand: input.ageBand,
      stratum,
      actor: input.actor,
      queuedAt: now
    });
    const position = state.waitlist.filter((w) => w.stratum === stratum).length;
    const outcome: ClaimOutcome = { ok: true, status: 'queued', holdNo: input.holdNo, position, message: `本层中央容量已满，已按中央容量排队（第 ${position} 位）` };
    remember(state, input.holdNo, 'claim', outcome, now, input.actor);
    events.push(eventOf('number-queued', input.actor, `${input.participantNo} 进入 ${input.site}/${input.ageBand} 容量队列，队位 ${position}`, input.participantNo));
    return { outcome, events };
  }

  const picked = nums[0];
  const wait: WaitEntry = {
    holdNo: input.holdNo,
    participantNo: input.participantNo,
    identityKey: input.identityKey,
    site: input.site,
    ageBand: input.ageBand,
    stratum,
    actor: input.actor,
    queuedAt: now
  };
  state.reservations.push(buildReservation(wait, picked, now));
  const outcome: ClaimOutcome = {
    ok: true,
    status: 'reserved',
    holdNo: input.holdNo,
    sequence: picked.sequence,
    kitNo: picked.kitNo,
    expiresAt: now + HOLD_TTL_DEMO_MS,
    version: 1,
    arm: picked.arm
  };
  remember(state, input.holdNo, 'claim', outcome, now, input.actor);
  events.push(eventOf('number-claimed', input.actor, `领号预占 ${input.holdNo}：${input.participantNo} 预占 ${input.site}/${input.ageBand} 区组号码 ${picked.sequence}（区组 ${picked.blockNo}），处理期间他人不可领，超时未确认将放回`, input.participantNo));
  return { outcome, events };
}

/**
 * 确认（第二阶段），版本号 CAS。
 * gone：号码已被超时收回或转给排队者；
 * conflict：两个协调员同时提交，版本只与一边匹配，只让一边成功；
 * 幂等：写盘失败后按 holdNo 重试，已成功的确认原样回放。
 */
export function confirmNumber(
  state: AllocationState,
  holdNo: string,
  expectedVersion: number,
  actor: string,
  now: number
): { outcome: ConfirmOutcome; events: AuditEvent[] } {
  const replay = state.ledger.find((l) => l.holdNo === holdNo && l.phase === 'confirm');
  if (replay) {
    if (replay.result.ok) {
      // 成功结果：仅允许原协调员做写盘失败后的幂等重试；他人同号提交 = 并发冲突
      if (replay.actor !== actor) {
        const conflict: ConfirmOutcome = { ok: false, code: 'conflict', message: `该预占已由 ${replay.actor} 确认，本次重复提交未生效（仅一方成功）` };
        return {
          outcome: conflict,
          events: [eventOf('confirm-conflict', actor, `预占 ${holdNo} 已被 ${replay.actor} 先行确认，${actor} 的并发提交被拒绝`)]
        };
      }
      return { outcome: { ...(replay.result as ConfirmSuccess), replayed: true }, events: [] };
    }
    return { outcome: replay.result as ConfirmOutcome, events: [] };
  }

  const events = expireReservations(state, now);

  const reservation = state.reservations.find((r) => r.holdNo === holdNo);
  if (!reservation) {
    const outcome: ConfirmOutcome = { ok: false, code: 'gone', message: '号码已被收回或已转给其他受试者，确认失败；请重新领号' };
    remember(state, holdNo, 'confirm', outcome, now, actor);
    events.push(eventOf('confirm-conflict', actor, `预占 ${holdNo} 确认失败：号码已收回或转号`));
    return { outcome, events };
  }

  if (reservation.status !== 'reserved' || reservation.expiresAt <= now) {
    state.reservations = state.reservations.filter((r) => r.holdNo !== holdNo);
    const outcome: ConfirmOutcome = { ok: false, code: 'gone', message: '预占已超时，号码已放回区组并可能已发给他人' };
    remember(state, holdNo, 'confirm', outcome, now, actor);
    return { outcome, events };
  }

  if (reservation.version !== expectedVersion) {
    // 不记忆该失败：他人用错误版本抢先提交不能毒化预占，真正持有人用当前版本仍可确认
    const outcome: ConfirmOutcome = { ok: false, code: 'conflict', message: '该号码已被另一位协调员确认，本次提交未生效（仅一方成功）' };
    events.push(eventOf('confirm-conflict', actor, `预占 ${holdNo} 并发确认冲突：提交版本 ${expectedVersion} ≠ 当前版本 ${reservation.version}`, reservation.participantNo));
    return { outcome, events };
  }

  if (usedCount(state, reservation.stratum) >= (state.capacity[reservation.stratum] ?? 0)) {
    state.reservations = state.reservations.filter((r) => r.holdNo !== holdNo);
    // 可恢复失败，不入账本：名额释放后允许按同 holdNo 重新领号
    const outcome: ConfirmOutcome = { ok: false, code: 'gone', message: '中央容量已满，确认失败，号码已释放' };
    return { outcome, events };
  }

  const confirmed: Reservation = { ...reservation, status: 'confirmed', version: reservation.version + 1 };
  const takenEntry: TakenNumber = {
    sequence: confirmed.sequence,
    kitNo: confirmed.kitNo,
    arm: confirmed.arm,
    blockNo: confirmed.blockNo,
    participantNo: confirmed.participantNo
  };
  state.taken[reservation.stratum].push(takenEntry);

  // 从池中摘除已确认号码
  const pool = state.pool[reservation.stratum];
  const poolIdx = pool.findIndex((n) => n.sequence === confirmed.sequence);
  if (poolIdx >= 0) pool.splice(poolIdx, 1);

  const participantId = crypto.randomUUID();
  state.participants.unshift({
    id: participantId,
    participantNo: confirmed.participantNo,
    identityKey: confirmed.identityKey,
    site: confirmed.site,
    ageBand: confirmed.ageBand,
    status: 'randomized',
    sequence: confirmed.sequence,
    kitNo: confirmed.kitNo,
    holdNo: confirmed.holdNo,
    // 治疗组作为受控字段落库，是否展示完全由视图层角色边界决定（药品管理员永不渲染）
    arm: confirmed.arm
  });
  state.reservations = state.reservations.filter((r) => r.holdNo !== holdNo);

  const outcome: ConfirmOutcome = { ok: true, sequence: confirmed.sequence, kitNo: confirmed.kitNo, arm: confirmed.arm, participantId };
  remember(state, holdNo, 'confirm', outcome, now, actor);
  events.push(eventOf('number-confirmed', actor, `${confirmed.participantNo} 确认入组，号码 ${confirmed.sequence}，发药编号 ${confirmed.kitNo}`, confirmed.participantNo));
  return { outcome, events };
}

/** 受试者临时退出：协调员主动取消，号码立即放回区组，排队者立即补位 */
export function cancelReservation(state: AllocationState, holdNo: string, actor: string, now: number): AuditEvent[] {
  const r = state.reservations.find((x) => x.holdNo === holdNo && x.status === 'reserved');
  if (!r) return [];
  state.reservations = state.reservations.filter((x) => x.holdNo !== holdNo);
  const events: AuditEvent[] = [eventOf('number-cancelled', actor, `受试者临时退出，预占 ${holdNo} 取消，号码 ${r.sequence} 立即放回区组`, r.participantNo)];
  promoteWaitlist(state, now, events, [r.stratum]);
  return events;
}

/** 药品管理员按发药编号登记发药（全程不接触治疗组） */
export function markDispensed(state: AllocationState, participantId: string, actor: string, now: number): AuditEvent[] {
  const p = state.participants.find((x) => x.id === participantId);
  if (!p || p.dispensedAt) return [];
  p.dispensedAt = new Date(now).toISOString();
  return [eventOf('dispensed', actor, `按发药编号 ${p.kitNo} 发药出库（治疗组按角色边界隐藏）`, p.participantNo)];
}

export function emergencyUnblindEvent(state: AllocationState, participantId: string, reason: string, actor: string, now: number): AuditEvent | null {
  const p = state.participants.find((x) => x.id === participantId);
  if (!p || !reason.trim()) return null;
  if (p.status !== 'unblinded') {
    p.status = 'unblinded';
    p.unblindedAt = new Date(now).toISOString();
  }
  // 治疗组只写进审计动作的留痕载荷（后端语义），列表视图仍按角色隐藏
  return eventOf('unblinded', actor, `紧急揭盲：${reason}；该受试者治疗组已记录于受控揭盲日志`, p.participantNo);
}
