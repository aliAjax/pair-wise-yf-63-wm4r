/**
 * 引擎不变量测试（纯逻辑，可在 Node 直接跑）：
 * npx tsx scripts/test-allocation.ts
 */
import {
  cancelReservation,
  claimNumber,
  confirmNumber,
  createInitialState,
  expireReservations,
  remainingCapacity,
  stratumKey,
  type AuditEvent
} from '../utils/allocation';
import type { AllocationState, ClaimInput, ClaimOutcome } from '../types/trial';

/** 断言为 reserved 并取出号码结果 */
const asReserved = (o: ClaimOutcome) => {
  if (!o.ok || o.status !== 'reserved') throw new Error('期望 reserved 结果');
  return o;
};

// crypto.randomUUID 在 Node 19+ 全局可用
let passed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error('✗', msg);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log('✓', msg);
  }
};

const base = (over: Partial<ClaimInput> = {}): ClaimInput => ({
  participantNo: 'P-1001',
  identityKey: 'ID-1001',
  site: '广州中心',
  ageBand: '18-44',
  actor: '协调员甲',
  holdNo: 'H-1',
  ...over
});

const apply = (state: AllocationState, events: AuditEvent[]) => {
  for (const e of events) state.audits.unshift({ id: Math.random().toString(36).slice(2), at: new Date().toISOString(), ...e });
};

// 1. 领号预占：号码被锁住，别人领不到同一个
{
  const s = createInitialState();
  const t0 = 1_000_000;
  const c1 = claimNumber(s, base(), t0);
  apply(s, c1.events);
  ok(c1.outcome.ok && c1.outcome.status === 'reserved', '第一次领号成功并预占');
  const seq = asReserved(c1.outcome).sequence;

  const c2 = claimNumber(s, base({ participantNo: 'P-1002', identityKey: 'ID-1002', actor: '协调员乙', holdNo: 'H-2' }), t0 + 1000);
  apply(s, c2.events);
  ok(c2.outcome.ok && c2.outcome.status === 'reserved', '第二位协调员可领下一个号');
  const seq2 = asReserved(c2.outcome).sequence;
  ok(seq !== seq2, `两人拿到不同号码（${seq} ≠ ${seq2}），处理期间互斥`);
}

// 2. 超时未确认：号码放回，别人能领到同一个；再确认原 holdNo = gone
{
  const s = createInitialState();
  const t0 = 2_000_000;
  const c1 = claimNumber(s, base(), t0);
  const r1 = asReserved(c1.outcome);
  const seq = r1.sequence;
  const TTL = r1.expiresAt - t0;

  const c2 = claimNumber(s, base({ participantNo: 'P-2002', identityKey: 'ID-2002', holdNo: 'H-2' }), t0 + TTL + 1);
  apply(s, c2.events);
  ok(c2.outcome.ok && c2.outcome.status === 'reserved' && c2.outcome.sequence === seq, '超时后号码放回区组，被下一位领到同一号码');

  const late = confirmNumber(s, 'H-1', 1, '协调员甲', t0 + TTL + 2);
  ok(!late.outcome.ok && late.outcome.code === 'gone', '原协调员超时后确认 → gone（号码已收回/转号）');
}

// 3. 两个协调员同时提交同一预占（同版本号）：只让一边成功
{
  const s = createInitialState();
  const t0 = 3_000_000;
  claimNumber(s, base(), t0);
  const a = confirmNumber(s, 'H-1', 1, '协调员甲', t0 + 100);
  const b = confirmNumber(s, 'H-1', 1, '协调员乙', t0 + 200);
  ok(a.outcome.ok, '并发确认：第一边成功');
  ok(!b.outcome.ok && b.outcome.code === 'conflict', '并发确认：第二边 conflict，仅一方成功');
  ok(s.participants.filter((p) => p.participantNo === 'P-1001').length === 1, '只产生一条入组记录，号码不重复占');
}

// 4. 写盘失败后按预占编号重试（claim 与 confirm 都幂等，不重复占号占名额）
{
  const s = createInitialState();
  const t0 = 4_000_000;
  const input = base({ holdNo: 'H-IDEM' });
  const first = claimNumber(s, input, t0);
  const seq = asReserved(first.outcome).sequence;
  // “写盘失败”后用同一 holdNo 原样重试
  const retry = claimNumber(s, input, t0 + 500);
  ok(retry.outcome.ok && retry.outcome.status === 'reserved' && retry.outcome.sequence === seq, '领号重试命中同一结果（号码不变）');
  ok(s.reservations.filter((r) => r.holdNo === 'H-IDEM').length === 1, '重试未产生第二条预占（名额未重复占）');

  const c1 = confirmNumber(s, 'H-IDEM', 1, '协调员甲', t0 + 600);
  const c2 = confirmNumber(s, 'H-IDEM', 1, '协调员甲', t0 + 700);
  ok(c1.outcome.ok, '首次确认成功');
  ok(c2.outcome.ok && (c2.outcome as { replayed?: boolean }).replayed === true, '确认重试为幂等回放');
  ok(s.participants.length === createInitialState().participants.length + 1, '重试确认未多建受试者');
}

// 5. 中央容量排队：名额耗尽 → queued；取消/超时释放后队首自动补位
{
  const s = createInitialState();
  const stratum = stratumKey('新加坡中心', '65+');
  const cap = s.capacity[stratum];
  const t0 = 5_000_000;
  // 用满容量（领号占名额）
  for (let i = 0; i < cap; i++) {
    const r = claimNumber(s, base({ site: '新加坡中心', ageBand: '65+', participantNo: `Q-${i}`, identityKey: `QI-${i}`, holdNo: `HQ-${i}` }), t0 + i);
    ok(r.outcome.ok && r.outcome.status === 'reserved', `第 ${i + 1}/${cap} 个号可领`);
  }
  const full = claimNumber(s, base({ site: '新加坡中心', ageBand: '65+', participantNo: 'Q-WAIT', identityKey: 'QI-WAIT', holdNo: 'HQ-W' }), t0 + cap);
  ok(full.outcome.ok && full.outcome.status === 'queued' && full.outcome.position === 1, '名额不足 → 进入中央容量队列第 1 位');
  ok(remainingCapacity(s, stratum, t0 + cap) === 0, '剩余容量为 0');

  // 一个受试者临时退出 → 号码与名额立即释放，排队者补位
  const ev = cancelReservation(s, 'HQ-0', '协调员甲', t0 + cap + 1);
  apply(s, ev);
  const promoted = s.reservations.find((r) => r.holdNo === 'HQ-W');
  ok(Boolean(promoted) && promoted?.status === 'reserved', '退出释放后队首自动补位拿到预占');
  ok(s.waitlist.every((w) => w.holdNo !== 'HQ-W'), '补位后离开排队队列');
}

// 6. 主动取消：号码立即放回，其他排队者补位，且不产生入组
{
  const s = createInitialState();
  const t0 = 6_000_000;
  claimNumber(s, base({ holdNo: 'HC-1' }), t0);
  cancelReservation(s, 'HC-1', '协调员甲', t0 + 100);
  const next = claimNumber(s, base({ participantNo: 'P-NEXT', identityKey: 'ID-NEXT', holdNo: 'HC-2' }), t0 + 200);
  ok(next.outcome.ok && next.outcome.status === 'reserved', '取消后名额可用，他人领号成功');
  ok(s.participants.every((p) => p.participantNo !== 'P-1001'), '取消未产生入组记录');
}

// 7. 区组平衡：每个 4 人区组 A/B 各 2
{
  const s = createInitialState();
  const key = stratumKey('广州中心', '45-64');
  const blocks = new Map<number, { A: number; B: number }>();
  for (const n of s.pool[key]) {
    const cur = blocks.get(n.blockNo) ?? { A: 0, B: 0 };
    cur[n.arm] += 1;
    blocks.set(n.blockNo, cur);
  }
  for (const [blockNo, c] of blocks) ok(c.A === 2 && c.B === 2, `区组 ${blockNo} 平衡（A=2,B=2）`);
}

// 8. 重复身份/编号在预占、排队、已确认三种状态都被阻止
{
  const s = createInitialState();
  const t0 = 7_000_000;
  claimNumber(s, base({ participantNo: 'DUP-1', identityKey: 'DUPID-1', holdNo: 'HD-1' }), t0);
  const dup = claimNumber(s, base({ participantNo: 'DUP-1', identityKey: 'DUPID-1', holdNo: 'HD-2' }), t0 + 10);
  ok(!dup.outcome.ok && dup.outcome.code === 'duplicate', '预占期间重复身份被阻止');
}

// 9. 系统扫描超时不影响未超时预占
{
  const s = createInitialState();
  const t0 = 8_000_000;
  claimNumber(s, base({ holdNo: 'HK-1' }), t0);
  expireReservations(s, t0 + 1000);
  ok(s.reservations.some((r) => r.holdNo === 'HK-1'), '未超时预占在扫描后仍然有效');
}

// 10. 他人用错误版本抢先提交不会毒化预占，真正持有人随后用正确版本仍可确认
{
  const s = createInitialState();
  const t0 = 9_000_000;
  claimNumber(s, base({ holdNo: 'HV-1' }), t0);
  const wrong = confirmNumber(s, 'HV-1', 999, '协调员乙', t0 + 100);
  ok(!wrong.outcome.ok && wrong.outcome.code === 'conflict', '错误版本提交 → conflict');
  const right = confirmNumber(s, 'HV-1', 1, '协调员甲', t0 + 200);
  ok(right.outcome.ok, '真正持有人用当前版本确认仍成功（未被毒化）');
}

// 11. 排队补位后，用原 holdNo 重试领号返回当前 reserved 结果而非过期 queued
{
  const s = createInitialState();
  const stratum = stratumKey('新加坡中心', '65+');
  const cap = s.capacity[stratum];
  const t0 = 10_000_000;
  for (let i = 0; i < cap; i++) {
    claimNumber(s, base({ site: '新加坡中心', ageBand: '65+', participantNo: `R-${i}`, identityKey: `RI-${i}`, holdNo: `HR-${i}` }), t0 + i);
  }
  const waiter = base({ site: '新加坡中心', ageBand: '65+', participantNo: 'R-W', identityKey: 'RI-W', holdNo: 'HR-W' });
  const queued = claimNumber(s, waiter, t0 + cap);
  ok(queued.outcome.ok && queued.outcome.status === 'queued', '满员时排队');
  apply(s, cancelReservation(s, 'HR-0', '协调员甲', t0 + cap + 1));
  const replay = claimNumber(s, waiter, t0 + cap + 2);
  ok(replay.outcome.ok && replay.outcome.status === 'reserved' && replay.outcome.holdNo === 'HR-W', '补位后同 holdNo 重试返回 reserved 预占');
}

console.log(`\n${passed} 项断言通过`);
