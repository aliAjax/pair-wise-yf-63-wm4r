<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useIntervalFn } from '@vueuse/core';
import { useTrialStore, stratumKey, parseStratum } from '~/stores/trial';
import type { TrialRole, RandomizeInput, WaitlistEntry, Block } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, reservations, waitlist, blocks, config } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);

const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm, values } = useForm<RandomizeInput>({
  validationSchema: schema,
  initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' }
});
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

/* ---------- 先领后确认：当前领号会话 ---------- */
const claimKey = ref(crypto.randomUUID());
const currentReservationId = ref('');
const currentToken = ref('');
const lastInput = ref<RandomizeInput | null>(null);

const now = ref(Date.now());
useIntervalFn(() => {
  now.value = Date.now();
  trial.tick();
}, 1000);

const fmt = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const remaining = (expiresAt: string) => Math.max(0, new Date(expiresAt).getTime() - now.value);
const shortId = (id: string) => `YF-${id.slice(0, 8).toUpperCase()}`;

const activeList = computed(() =>
  reservations.value
    .filter((r) => r.status === 'active')
    .sort((a, b) => new Date(b.claimedAt).getTime() - new Date(a.claimedAt).getTime())
);

const doClaim = handleSubmit((vals) => {
  lastInput.value = { ...vals };
  const res = trial.claim(vals, claimKey.value);
  if (res.ok) {
    currentReservationId.value = res.reservationId!;
    currentToken.value = res.token!;
    ElMessage.success(res.message);
  } else if (res.retryable) {
    currentReservationId.value = res.reservationId!;
    currentToken.value = res.token!;
    ElMessage.warning(res.message);
  } else if (res.queued) {
    ElMessage.info(res.message);
  } else {
    ElMessage.error(res.message);
  }
});

const retryClaim = () => {
  if (!lastInput.value) return;
  const res = trial.claim(lastInput.value, claimKey.value);
  if (res.ok) {
    currentReservationId.value = res.reservationId!;
    currentToken.value = res.token!;
    ElMessage.success(res.message);
  } else if (res.retryable) {
    ElMessage.warning(res.message);
  } else {
    ElMessage.error(res.message);
  }
};

const resetClaim = () => {
  claimKey.value = crypto.randomUUID();
  currentReservationId.value = '';
  currentToken.value = '';
};

const doConfirm = (reservationId?: string, token?: string) => {
  const id = reservationId ?? currentReservationId.value;
  const tok = token ?? currentToken.value;
  if (!id || !tok) return;
  const res = trial.confirm(id, tok, values.actor || '协调员');
  if (res.ok) {
    ElMessage.success(res.message);
    if (id === currentReservationId.value) resetClaim();
  } else {
    ElMessage.error(res.message);
  }
};

const doCancel = (reservationId: string) => {
  trial.cancelReservation(reservationId, values.actor || '协调员');
  if (reservationId === currentReservationId.value) resetClaim();
  ElMessage.info('预占已放弃，号码放回区组');
};

/** 排队叫号后，用预占单中的令牌确认（系统叫号时令牌随叫号送达） */
const confirmWaitlist = (w: WaitlistEntry) => {
  if (!w.reservationId) return;
  const r = reservations.value.find((x) => x.id === w.reservationId);
  if (!r) return;
  doConfirm(r.id, r.token);
};

/* ---------- 并发演示：重复提交不重复占号 / 令牌冲突只让一边成功 ---------- */
const demoDuplicateSubmit = async () => {
  if (!currentReservationId.value) return;
  const id = currentReservationId.value;
  const tok = currentToken.value;
  const [r1, r2] = await Promise.all([
    trial.confirm(id, tok, values.actor || '协调员'),
    trial.confirm(id, tok, values.actor || '协调员')
  ]);
  const count = participants.value.filter((p) => p.reservationId === id).length;
  ElMessage.success(`两边提交：${r1.ok ? '成功' : '失败'} / ${r2.ok ? '成功' : '失败'}，仅生成 ${count} 条受试者记录`);
  resetClaim();
};

const demoTokenConflict = async () => {
  if (!currentReservationId.value) return;
  const id = currentReservationId.value;
  const tok = currentToken.value;
  const [r1, r2] = await Promise.all([
    trial.confirm(id, tok, values.actor || '协调员'),
    trial.confirm(id, 'stale-token-other-coordinator', values.actor || '协调员')
  ]);
  ElMessage.warning(`持当前令牌：${r1.ok ? '成功' : '失败'}；持旧令牌：${r2.ok ? '成功' : '失败'}（号码已被收回/转发时仅一边成功）`);
  resetClaim();
};

/* ---------- 角色边界：治疗组隐藏，药品管理员只看发药编号 ---------- */
const visibleArm = (arm?: 'A' | 'B', status?: string) => {
  if (role.value === 'monitor' && status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};
const showSequence = computed(() => role.value !== 'pharmacist');

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', {
      inputType: 'textarea',
      inputValidator: (v) => Boolean(v?.trim()) || '揭盲原因不能为空',
      confirmButtonText: '确认并审计'
    });
    trial.emergencyUnblind(id, value, actor.value);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

/* ---------- 区组可视化 ---------- */
const stratumBlocks = computed(() => {
  const map = new Map<string, Block[]>();
  for (const b of blocks.value) {
    if (!map.has(b.stratum)) map.set(b.stratum, []);
    map.get(b.stratum)!.push(b);
  }
  return Array.from(map.entries()).map(([key, bs]) => ({
    key,
    label: (() => {
      const { site: s, ageBand: a } = parseStratum(key);
      return `${s} · ${a}`;
    })(),
    blocks: bs.sort((x, y) => x.blockNo - y.blockNo)
  }));
});
const occupancy = (key: string) => {
  const { site: s, ageBand: a } = parseStratum(key);
  return trial.stratumOccupancy(s, a);
};
const slotType = (status: string) => (status === 'confirmed' ? 'success' : status === 'reserved' ? 'warning' : 'info');

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount,
  active: activeList.value.length,
  waiting: trial.waitingCount
}));

const ttlSeconds = computed(() => Math.round(config.value.claimTtlMs / 1000));
const setTtl = (sec: number) => {
  config.value.claimTtlMs = sec * 1000;
};
</script>

<template>
  <main class="page">
    <header class="hero">
      <div>
        <el-tag type="success">GCP 本地原型</el-tag>
        <h1>{{ t('title') }}</h1>
        <p>{{ t('subtitle') }}</p>
      </div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section class="stats">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>预占中</span><b>{{ counts.active }}</b></div>
      <div class="stat"><span>排队中</span><b>{{ counts.waiting }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
    </section>

    <div class="grid">
      <!-- 左列：领号 / 预占 / 排队 -->
      <div>
        <el-card shadow="never">
          <template #header>
            <b>① 领号（先领后确认）</b>
            <el-switch v-model="trial.simulateWriteFail" active-text="模拟写盘失败" style="float:right" />
          </template>
          <el-alert type="info" :closable="false" style="margin-bottom:12px">
            协调员按分层区组领号，处理期间他人领不到；超时未确认自动放回区组再发。
          </el-alert>
          <el-form label-position="top" @submit.prevent="doClaim">
            <el-form-item label="研究中心" :error="errors.site">
              <el-select v-model="site" style="width:100%">
                <el-option label="上海中心" value="上海中心" />
                <el-option label="广州中心" value="广州中心" />
                <el-option label="新加坡中心" value="新加坡中心" />
              </el-select>
            </el-form-item>
            <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
            <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
            <el-form-item label="年龄分层" :error="errors.ageBand">
              <el-radio-group v-model="ageBand">
                <el-radio-button value="18-44">18-44</el-radio-button>
                <el-radio-button value="45-64">45-64</el-radio-button>
                <el-radio-button value="65+">65+</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
            <el-button type="primary" native-type="submit" style="width:100%">按分层区组领号</el-button>
          </el-form>

          <div class="cfg">
            <span>区组大小</span>
            <el-select :model-value="config.blockSize" size="small" style="width:80px" @change="(v:number) => (config.blockSize = v)">
              <el-option :value="4" label="4" />
              <el-option :value="6" label="6" />
            </el-select>
            <span>每分层区组数</span>
            <el-select :model-value="config.maxBlocksPerStratum" size="small" style="width:80px" @change="(v:number) => (config.maxBlocksPerStratum = v)">
              <el-option :value="1" label="1" />
              <el-option :value="2" label="2" />
              <el-option :value="3" label="3" />
            </el-select>
            <span>预占时长</span>
            <el-select :model-value="ttlSeconds" size="small" style="width:90px" @change="setTtl">
              <el-option :value="30" label="30秒" />
              <el-option :value="120" label="2分钟" />
              <el-option :value="300" label="5分钟" />
            </el-select>
          </div>
        </el-card>

        <el-card v-if="currentReservationId" shadow="never" style="margin-top:16px">
          <template #header><b>② 确认入组</b></template>
          <el-descriptions :column="1" border>
            <el-descriptions-item label="预占编号"><span class="mono">{{ shortId(currentReservationId) }}</span></el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag v-if="trial.simulateWriteFail" type="danger">写盘失败，待重试</el-tag>
              <el-tag v-else type="warning">预占中 · 剩余 {{ fmt(remaining(activeList.find((r) => r.id === currentReservationId)?.expiresAt ?? new Date().toISOString())) }}</el-tag>
            </el-descriptions-item>
          </el-descriptions>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
            <el-button type="success" @click="doConfirm()">确认入组</el-button>
            <el-button @click="retryClaim" :disabled="!trial.simulateWriteFail">按预占编号重试领号</el-button>
            <el-button @click="demoDuplicateSubmit">模拟两人同时提交（同令牌）</el-button>
            <el-button @click="demoTokenConflict">模拟令牌冲突</el-button>
            <el-button type="danger" plain @click="doCancel(currentReservationId)">放弃预占</el-button>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top:16px">
          <template #header><b>当前预占（{{ activeList.length }}）</b></template>
          <el-empty v-if="activeList.length === 0" description="暂无有效预占" :image-size="60" />
          <div v-for="r in activeList" :key="r.id" class="resv">
            <div>
              <b class="mono">{{ shortId(r.id) }}</b>
              <el-tag size="small" type="warning" style="margin-left:6px">预占中</el-tag>
              <div class="muted">{{ parseStratum(r.stratum).site }} · {{ parseStratum(r.stratum).ageBand }} · 随机号 {{ r.sequence }} · 发药编号 {{ r.dispensingNo }}</div>
            </div>
            <div class="resv-actions">
              <span class="countdown">{{ fmt(remaining(r.expiresAt)) }}</span>
              <el-button size="small" type="success" @click="doConfirm(r.id, r.token)">确认</el-button>
              <el-button size="small" type="danger" plain @click="doCancel(r.id)">放弃</el-button>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top:16px">
          <template #header><b>中央容量排队（{{ waitlist.length }}）</b></template>
          <el-empty v-if="waitlist.length === 0" description="暂无排队" :image-size="60" />
          <el-table v-else :data="waitlist" size="small">
            <el-table-column prop="payload.participantNo" label="受试者" />
            <el-table-column label="分层">
              <template #default="{ row }">{{ parseStratum(row.stratum).site }} · {{ parseStratum(row.stratum).ageBand }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态">
              <template #default="{ row }">
                <el-tag v-if="row.status === 'waiting'" type="info">等待中</el-tag>
                <el-tag v-else-if="row.status === 'offered'" type="warning">已叫号</el-tag>
                <el-tag v-else type="success">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button v-if="row.status === 'offered'" size="small" type="success" @click="confirmWaitlist(row)">确认叫号</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </div>

      <!-- 右列：区组 / 受试者 / 待提交 / 审计 -->
      <div>
        <el-card shadow="never">
          <template #header><b>分层区组状态</b><span class="muted" style="float:right">灰=可用 橙=预占 绿=已确认</span></template>
          <div v-for="g in stratumBlocks" :key="g.key" class="stratum">
            <div class="stratum-head">
              <b>{{ g.label }}</b>
              <span class="muted">容量 {{ occupancy(g.key).held }}/{{ occupancy(g.key).total }} · 余 {{ occupancy(g.key).available }}</span>
            </div>
            <div v-for="b in g.blocks" :key="b.id" class="block-row">
              <span class="muted block-label">区组{{ b.blockNo }}</span>
              <el-tag
                v-for="(s, i) in b.slots"
                :key="i"
                :type="slotType(s.status)"
                size="small"
                effect="dark"
                class="slot"
              >{{ i + 1 }}</el-tag>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top:16px">
          <template #header>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>{{ t('participants') }}</b>
              <el-tag>{{ role }}</el-tag>
            </div>
          </template>
          <el-table :data="participants" max-height="420" size="small">
            <el-table-column prop="participantNo" label="受试者" min-width="110" />
            <el-table-column prop="site" label="中心" min-width="90" />
            <el-table-column prop="ageBand" label="年龄" min-width="80" />
            <el-table-column v-if="showSequence" prop="sequence" label="随机号" width="80" />
            <el-table-column v-if="role === 'pharmacist'" prop="dispensingNo" label="发药编号" width="110">
              <template #default="{ row }"><el-tag type="primary" effect="plain">{{ row.dispensingNo }}</el-tag></template>
            </el-table-column>
            <el-table-column label="治疗组" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="90" />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" style="margin-top:16px">
          <template #header>
            <b>{{ t('pending') }}</b>
            <el-switch v-model="offline" active-text="模拟离线" style="float:right" />
          </template>
          <el-alert v-if="offline" type="warning" :closable="false" style="margin-bottom:10px">
            离线状态下提交将进入待提交队列，联网后由授权人员确认入库。
          </el-alert>
          <el-empty v-if="pending.length === 0" description="暂无待提交记录" :image-size="60" />
          <el-table v-else :data="pending" size="small">
            <el-table-column prop="payload.participantNo" label="受试者" />
            <el-table-column prop="status" label="状态" width="90" />
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="trial.commitPending(row.id, actor)">确认入库</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" style="margin-top:16px">
          <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
          <el-timeline>
            <el-timeline-item
              v-for="entry in audits"
              :key="entry.id"
              :timestamp="new Date(entry.at).toLocaleString()"
              :type="entry.action === 'unblinded' ? 'danger' : entry.action === 'duplicate-blocked' || entry.action === 'claim-conflict' ? 'warning' : 'primary'"
            >
              <b>{{ entry.actor }} · {{ entry.action }}</b>
              <div>{{ entry.detail }}</div>
            </el-timeline-item>
          </el-timeline>
        </el-card>
      </div>
    </div>
  </main>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}
.cfg {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.resv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--el-border-color);
}
.resv:last-child {
  border-bottom: none;
}
.resv-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.countdown {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--el-color-warning);
}
.stratum {
  margin-bottom: 14px;
}
.stratum-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}
.block-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.block-label {
  width: 56px;
  flex-shrink: 0;
}
.slot {
  width: 28px;
  text-align: center;
  justify-content: center;
}
@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 600px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
