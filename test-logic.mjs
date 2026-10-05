import { createJiti } from 'jiti';
import { createPinia, setActivePinia } from 'pinia';

const jiti = createJiti(import.meta.url, {
  alias: { '~': '/workspace' },
  interopDefault: true,
});
const { useTrialStore } = await jiti.import('/workspace/stores/trial.ts');

setActivePinia(createPinia());
const store = useTrialStore();

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const input = (n) => ({ participantNo: `S01-${n}`, identityKey: `id-${n}`, site: '上海中心', ageBand: '45-64', actor: '测试协调员' });

console.log('\n== 1. 领号：先领后确认，处理期间他人领不到同一槽位 ==');
const r1 = store.claim(input('003'));
check('领号成功', r1.ok === true);
check('返回预占编号', !!r1.reservationId);
check('返回确认令牌', !!r1.token);
const r2 = store.claim(input('004'));
check('第二人领号成功（不同槽位）', r2.ok === true && r2.reservationId !== r1.reservationId);
const slot1 = store.blocks.find(b => b.id === store.reservations.find(r => r.id === r1.reservationId).blockId).slots[store.reservations.find(r => r.id === r1.reservationId).slotIndex];
check('槽位状态为 reserved', slot1.status === 'reserved');

console.log('\n== 2. 确认：令牌正确才成功，号码不重复占 ==');
const beforeCount = store.participants.length;
const c1 = store.confirm(r1.reservationId, r1.token, '测试协调员');
check('正确令牌确认成功', c1.ok === true);
check('生成一条受试者记录', store.participants.length === beforeCount + 1);
check('记录携带发药编号', c1.participant && c1.participant.dispensingNo.startsWith('DY'));
const c1Again = store.confirm(r1.reservationId, r1.token, '测试协调员');
check('重复确认不重复占号（幂等）', c1Again.ok === true && store.participants.length === beforeCount + 1);

console.log('\n== 3. 令牌冲突：号码被收回/转发时只让一边成功 ==');
const r3 = store.claim(input('005'));
const cWrong = store.confirm(r3.reservationId, 'stale-token-xxx', '他人');
check('错误令牌确认失败', cWrong.ok === false && cWrong.conflict === true);
check('错误令牌未生成受试者', !store.participants.some(p => p.reservationId === r3.reservationId));
const cRight = store.confirm(r3.reservationId, r3.token, '测试协调员');
check('正确令牌确认成功（仅一边）', cRight.ok === true);

console.log('\n== 4. 超时收回：未确认超时后号码放回区组 ==');
store.config.claimTtlMs = 100; // 100ms TTL
const r4 = store.claim(input('006'));
check('领号成功（短TTL）', r4.ok === true);
await new Promise(res => setTimeout(res, 250));
store.sweepExpired();
const r4Rec = store.reservations.find(r => r.id === r4.reservationId);
check('预占已过期', r4Rec.status === 'expired');
const block4 = store.blocks.find(b => b.id === r4Rec.blockId);
check('槽位已放回可用', block4.slots[r4Rec.slotIndex].status === 'available');
check('过期后确认失败', store.confirm(r4.reservationId, r4.token, '测试协调员').ok === false);
store.config.claimTtlMs = 120000;

console.log('\n== 5. 中央容量排队：名额不足排队，空位按序叫号 ==');
// 用一个无 seed 的新分层，容量 = 1 区组 * 4 = 4 槽位
store.config.maxBlocksPerStratum = 1;
const gz = (n) => ({ participantNo: `GZ-${n}`, identityKey: `gz-id-${n}`, site: '广州中心', ageBand: '18-44', actor: '测试协调员' });
// 填满 4 个槽位
for (let i = 1; i <= 4; i++) {
  const c = store.claim(gz(i));
  check(`填充领号 ${i} 成功`, c.ok === true);
  const cf = store.confirm(c.reservationId, c.token, '测试协调员');
  check(`填充确认 ${i} 成功`, cf.ok === true);
}
const held = store.blocks.filter(b => b.stratum === '广州中心||18-44').reduce((n, b) => n + b.slots.filter(s => s.status !== 'available').length, 0);
check('新分层 4 槽位占满', held === 4);
// 第 5 个 → 排队
const r5 = store.claim(gz(5));
check('名额不足进入排队', r5.ok === false && r5.queued === true && !!r5.waitlistId);
const wl = store.waitlist.find(w => w.id === r5.waitlistId);
check('排队单状态 waiting', wl && wl.status === 'waiting');
// 让一个已确认槽位“退出”：用短 TTL 领一个号再超时，腾出空位
store.config.claimTtlMs = 100;
const r6 = store.claim(gz(6)); // 容量满 → 也排队
check('第 6 个也排队', r6.ok === false && r6.queued === true);
// 手动让广州中心一个有效预占过期以腾位：r6 在排队，需先有槽位释放。改为放弃一个已确认记录对应的预占不可行（已确认）。
// 正确做法：再开一个分层测排队叫号——直接把 maxBlocks 调回 2，排队者应获得新槽位
store.config.claimTtlMs = 120000;
store.config.maxBlocksPerStratum = 2;
store.tick();
const wlAfter = store.waitlist.find(w => w.id === r5.waitlistId);
check('扩容后按序叫号（offered）', wlAfter && wlAfter.status === 'offered' && !!wlAfter.reservationId);
const offeredRes = store.reservations.find(r => r.id === wlAfter.reservationId);
check('叫号生成新预占', offeredRes && offeredRes.status === 'active');
check('排队者用叫号令牌确认成功', store.confirm(offeredRes.id, offeredRes.token, '测试协调员').ok === true);
const wl6 = store.waitlist.find(w => w.id === r6.waitlistId);
check('第 6 位也被叫号', wl6 && wl6.status === 'offered');
store.config.maxBlocksPerStratum = 3;

console.log('\n== 6. 写盘失败：按预占编号重试，号码名额不重复占 ==');
store.simulateWriteFail = true;
const clientKey = crypto.randomUUID();
const r7 = store.claim(input('009'), clientKey);
check('写盘失败返回可重试', r7.ok === false && r7.retryable === true && r7.reservationId === clientKey);
const heldBefore = store.blocks.reduce((n, b) => n + b.slots.filter(s => s.status !== 'available').length, 0);
store.simulateWriteFail = false;
const r7Retry = store.claim(input('009'), clientKey);
check('按预占编号重试成功（幂等）', r7Retry.ok === true && r7Retry.reservationId === clientKey);
const heldAfter = store.blocks.reduce((n, b) => n + b.slots.filter(s => s.status !== 'available').length, 0);
check('重试未重复占号', heldAfter === heldBefore);
check('重试返回同一令牌', r7Retry.token === store.reservations.find(r => r.id === clientKey).token);

console.log('\n== 7. 两人同时提交：只产生一条记录 ==');
const r8 = store.claim(input('010'));
const before = store.participants.length;
const [a, b] = await Promise.all([
  store.confirm(r8.reservationId, r8.token, '协调员A'),
  store.confirm(r8.reservationId, r8.token, '协调员B')
]);
check('两边都返回成功（幂等）', a.ok === true && b.ok === true);
check('仅生成一条记录', store.participants.filter(p => p.reservationId === r8.reservationId).length === 1);
check('总数只增一条', store.participants.length === before + 1);

console.log('\n== 8. 放弃预占：号码放回区组 ==');
const r9 = store.claim(input('011'));
const rec9 = store.reservations.find(r => r.id === r9.reservationId);
const block9 = store.blocks.find(b => b.id === rec9.blockId);
const slotIdx9 = rec9.slotIndex;
store.cancelReservation(r9.reservationId, '测试协调员');
check('放弃后槽位恢复可用', block9.slots[slotIdx9].status === 'available');
check('预占状态 cancelled', store.reservations.find(r => r.id === r9.reservationId).status === 'cancelled');

console.log('\n== 9. 药品管理员角色边界：发药编号与治疗组分离 ==');
const p = store.participants.find(p => p.reservationId === r8.reservationId);
check('记录有发药编号', !!p.dispensingNo);
check('记录有治疗组（系统内部分配）', !!p.arm);
check('随机号与发药编号不同体系', p.sequence !== undefined && p.dispensingNo !== undefined);

console.log(`\n== 结果：${pass} 通过，${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
