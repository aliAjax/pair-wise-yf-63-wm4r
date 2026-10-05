<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import { failNextWrites } from '~/composables/useLocalPersist';
import type { Arm, ClaimInput, Reservation, TrialRole } from '~/types/trial';
import { HOLD_TTL_DEMO_MS } from '~/utils/allocation';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, reservations, waitlist, now } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const failNextWrite = ref(false);

const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({
  validationSchema: schema,
  initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '协调员王芳' }
});
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

/** 非空操作人，供业务调用使用 */
const who = computed(() => actor.value ?? '');
const capacity = computed(() => trial.capacityOf(site.value ?? '上海中心', ageBand.value ?? '45-64'));

/** 当前协调员持有的有效预占（本界面按操作人过滤，演示两个协调员时切换操作人即可看到隔离） */
const myHolds = computed<Reservation[]>(() =>
  reservations.value
    .filter((r) => r.status === 'reserved' && r.expiresAt > now.value && r.actor === who.value)
    .sort((a, b) => a.claimedAt - b.claimedAt)
);
const otherHolds = computed(() => reservations.value.filter((r) => r.status === 'reserved' && r.expiresAt > now.value && r.actor !== who.value));
const myWaiting = computed(() => waitlist.value.filter((w) => w.actor === who.value));

const countdown = (expiresAt: number) => Math.max(0, Math.ceil((expiresAt - now.value) / 1000));

/** 第一阶段：领号（可选注入一次写盘失败，随后界面按同 holdNo 自动重试） */
const submit = handleSubmit((values) => {
  if (offline.value) {
    const result = trial.queueOffline(values);
    result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
    if (result.ok) resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
    return;
  }

  const input: ClaimInput = { ...values, holdNo: crypto.randomUUID() };
  if (failNextWrite.value) {
    failNextWrites(1);
    ElMessage.warning('已模拟写盘失败：将按同一预占编号自动重试');
  }
  try {
    const outcome = trial.claim(input);
    reportClaim(outcome, false);
  } catch {
    // 写盘失败：引擎已在内存完成预占，按原 holdNo 幂等重试，不重复占号
    try {
      const replayed = trial.retryClaim(input);
      ElMessage.success('写盘已恢复，按预占编号重试成功（号码/名额未重复占用）');
      reportClaim(replayed, true);
    } catch (e) {
      ElMessage.error(`写盘失败且重试未成功：${(e as Error).message}，请稍后用同一预占编号再试 ${input.holdNo}`);
    }
  }
});

function reportClaim(outcome: ReturnType<typeof trial.claim>, replayed: boolean) {
  if (!outcome.ok) {
    ElMessage.error(outcome.message);
    return;
  }
  if (outcome.status === 'queued') {
    ElMessage.warning(outcome.message);
    resetForm({ values: { participantNo: '', identityKey: '', site: site.value, ageBand: ageBand.value, actor: actor.value } });
    return;
  }
  ElMessage.success(`领号成功：号码 ${outcome.sequence}，发药编号 ${outcome.kitNo}，请在 ${HOLD_TTL_DEMO_MS / 1000} 秒内确认${replayed ? '（幂等重试）' : ''}`);
  resetForm({ values: { participantNo: '', identityKey: '', site: site.value, ageBand: ageBand.value, actor: actor.value } });
}

/** 第二阶段：确认（CAS）。模拟写盘失败时按同 holdNo 重试。 */
const confirmHold = (hold: Reservation) => {
  if (failNextWrite.value) {
    failNextWrites(1);
    ElMessage.warning('已模拟确认写盘失败：将按同一预占编号自动重试');
  }
  try {
    const outcome = trial.confirm(hold.holdNo, hold.version, who.value);
    reportConfirm(outcome, false);
  } catch {
    try {
      const outcome = trial.retryConfirm(hold.holdNo, hold.version, who.value);
      ElMessage.success('写盘已恢复，确认重试成功');
      reportConfirm(outcome, true);
    } catch (e) {
      ElMessage.error(`确认写盘失败：${(e as Error).message}，预占编号 ${hold.holdNo}`);
    }
  }
};

function reportConfirm(outcome: ReturnType<typeof trial.confirm>, replayed: boolean) {
  if (outcome.ok) {
    ElMessage.success(`已确认入组：号码 ${outcome.sequence}，发药编号 ${outcome.kitNo}${outcome.replayed || replayed ? '（幂等回放，未重复占用）' : ''}`);
  } else if (outcome.code === 'conflict') {
    ElMessage.error(outcome.message);
  } else {
    ElMessage.warning(outcome.message);
  }
}

/** 演示两个协调员同时提交：用同一预占、同版本号连续提交两次，只让一边成功 */
const simulateConcurrentConfirm = (hold: Reservation) => {
  const first = trial.confirm(hold.holdNo, hold.version, who.value);
  const secondActor = who.value === '协调员王芳' ? '协调员李强' : '协调员王芳';
  const second = trial.confirm(hold.holdNo, hold.version, secondActor);
  reportConfirm(first, false);
  setTimeout(() => {
    if (second.ok) ElMessage.success(`${secondActor} 重试命中原结果`);
    else ElMessage.error(`${secondActor} 的并发提交：${second.message}`);
  }, 350);
};

const cancelHold = (hold: Reservation) => {
  trial.cancel(hold.holdNo, who.value);
  ElMessage.info(`已取消预占，号码 ${hold.sequence} 放回区组，排队者可立即补位`);
};

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', {
      inputType: 'textarea',
      inputValidator: (v) => Boolean(v?.trim()) || '揭盲原因不能为空',
      confirmButtonText: '确认并审计'
    });
    trial.emergencyUnblind(id, value, who.value);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

const dispense = (id: string) => {
  trial.dispense(id, who.value);
  ElMessage.success('已按发药编号登记出库');
};

const onCommitPending = (id: string) => {
  const result = trial.commitPending(id, who.value);
  if (!result) return;
  result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
};

/** 角色边界：治疗组列如何展示 */
const armDisplay = (row: { arm?: Arm; status: string }) => {
  if (role.value === 'pharmacist') return { text: '权限隐藏', tag: 'info' as const };
  if (role.value === 'monitor') {
    return row.status === 'unblinded' ? { text: row.arm ?? '未知', tag: 'danger' as const } : { text: '已隐藏', tag: 'info' as const };
  }
  return row.status === 'unblinded' ? { text: row.arm ?? '未知', tag: 'danger' as const } : { text: '已隐藏', tag: 'info' as const };
};

const auditTagType = (action: string) =>
  action === 'unblinded' || action === 'confirm-conflict' ? 'danger' : action === 'duplicate-blocked' || action === 'number-released' ? 'warning' : action === 'dispensed' ? 'success' : 'primary';

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((i) => i.status === 'unblinded').length,
  holds: reservations.value.filter((r) => r.status === 'reserved' && r.expiresAt > now.value).length,
  waiting: waitlist.value.length,
  pending: trial.pendingCount
}));

let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  timer = setInterval(() => {
    trial.tick();
    trial.sweep();
  }, 1000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <main class="page">
    <header class="hero">
      <div>
        <el-tag type="success">GCP 本地原型 · 先领后确认</el-tag>
        <h1>{{ t('title') }}</h1>
        <p>分层区组发号两阶段：协调员先领号预占、处理后确认；超时放回、容量排队、并发只成一边</p>
      </div>
      <el-segmented
        v-model="role"
        :options="[{ label: '研究者/协调员', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]"
      />
    </header>

    <section class="stats">
      <div class="stat"><span>已确认入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>预占中（他人不可领）</span><b>{{ counts.holds }}</b></div>
      <div class="stat"><span>容量排队</span><b>{{ counts.waiting }}</b></div>
      <div class="stat"><span>紧急揭盲 / 待提交</span><b>{{ counts.unblinded }} / {{ counts.pending }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b>第一步 · 按分层区组领号</b>
            <div>
              <el-switch v-model="failNextWrite" active-text="模拟下次写盘失败" inline-prompt style="margin-right:14px" />
              <el-switch v-model="offline" active-text="模拟离线" inline-prompt />
            </div>
          </div>
        </template>
        <el-form label-position="top" @submit.prevent="submit">
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
          <el-form-item label="协调员" :error="errors.actor"><el-input v-model="actor" placeholder="协调员姓名" /></el-form-item>
          <el-alert
            :title="`本层中央容量：剩余 ${capacity.remaining}（总 ${capacity.total} / 已确认 ${capacity.used} / 预占 ${capacity.reserved} / 排队 ${capacity.waiting}）`"
            :type="capacity.remaining > 0 ? 'success' : 'error'"
            :closable="false"
            style="margin-bottom:12px"
          />
          <el-button type="primary" native-type="submit" style="width:100%">领取分层区组号码（预占 45 秒）</el-button>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><b>第二步 · 我的预占（处理期间他人领不到）</b></template>
        <el-empty v-if="myHolds.length === 0 && myWaiting.length === 0" description="暂无预占或排队" />
        <el-table v-else :data="myHolds" max-height="240">
          <el-table-column prop="participantNo" label="受试者" min-width="100" />
          <el-table-column prop="sequence" label="号码" width="70" />
          <el-table-column prop="kitNo" label="发药编号" width="100" />
          <el-table-column label="剩余确认时间" width="105">
            <template #default="{ row }">
              <el-tag :type="countdown(row.expiresAt) <= 10 ? 'danger' : 'warning'">{{ countdown(row.expiresAt) }} 秒</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="230">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="confirmHold(row as Reservation)">确认入组</el-button>
              <el-button size="small" type="warning" plain @click="simulateConcurrentConfirm(row as Reservation)">并发确认演示</el-button>
              <el-button size="small" type="danger" plain @click="cancelHold(row as Reservation)">临时退出</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-table v-if="myWaiting.length" :data="myWaiting" style="margin-top:10px" max-height="160">
          <el-table-column prop="participantNo" label="容量排队中" min-width="120" />
          <el-table-column prop="site" label="中心" min-width="90" />
          <el-table-column prop="ageBand" label="分层" width="90" />
          <el-table-column label="状态" width="150"><template #default><el-tag type="warning">等待名额/号码释放</el-tag></template></el-table-column>
        </el-table>
        <el-alert
          v-if="otherHolds.length"
          :title="`其他协调员正持有 ${otherHolds.length} 个预占，本界面不可确认其号码（按持号人边界隔离）`"
          type="info"
          :closable="false"
          style="margin-top:10px"
        />
      </el-card>
    </div>

    <el-card shadow="never" style="margin-top:20px">
      <template #header>
        <div style="display:flex;justify-content:space-between">
          <b>{{ role === 'pharmacist' ? '发药台账（仅发药编号）' : t('participants') }}</b>
          <el-tag>{{ role === 'investigator' ? '协调员视图' : role === 'pharmacist' ? '药品管理员视图：治疗组隐藏' : '监察员视图' }}</el-tag>
        </div>
      </template>
      <el-table :data="participants" max-height="420">
        <el-table-column prop="participantNo" label="受试者" min-width="105" />
        <el-table-column prop="site" label="中心" min-width="100" />
        <el-table-column prop="sequence" label="随机号码" width="90" />
        <el-table-column prop="kitNo" label="发药编号" width="110" />
        <el-table-column v-if="role !== 'pharmacist'" label="治疗组" width="100">
          <template #default="{ row }">
            <el-tag :type="armDisplay(row as { arm?: Arm; status: string }).tag">{{ armDisplay(row as { arm?: Arm; status: string }).text }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-else label="治疗组" width="100">
          <template #default><el-tooltip content="药品管理员按角色边界不可见治疗组"><el-tag type="info">••• 隐藏</el-tag></el-tooltip></template>
        </el-table-column>
        <el-table-column label="发药状态" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.dispensedAt" type="success">已发药</el-tag>
            <el-tag v-else type="info">未发药</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button v-if="role === 'pharmacist' && !row.dispensedAt" size="small" type="success" plain @click="dispense(row.id)">按编号发药</el-button>
            <el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">紧急揭盲</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header>
          <div style="display:flex;justify-content:space-between"><b>{{ t('pending') }}</b><b>中央容量看板</b></div>
        </template>
        <div style="display:flex;gap:16px">
          <div style="flex:1">
            <el-empty v-if="pending.length === 0" description="暂无离线待提交" :image-size="60" />
            <el-table v-else :data="pending" max-height="260">
              <el-table-column prop="payload.participantNo" label="受试者" min-width="100" />
              <el-table-column prop="status" label="状态" width="90" />
              <el-table-column label="操作" width="110">
                <template #default="{ row }">
                  <el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="onCommitPending(row.id)">联网领号+确认</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <div style="flex:1;max-height:260px;overflow:auto">
            <el-table :data="Object.entries(trial.capacityBoard)" size="small">
              <el-table-column label="分层（中心｜年龄）" min-width="150"><template #default="{ row }">{{ row[0] }}</template></el-table-column>
              <el-table-column label="余/总" width="70"><template #default="{ row }">{{ row[1].remaining }}/{{ row[1].total }}</template></el-table-column>
              <el-table-column label="预占" width="50"><template #default="{ row }">{{ row[1].reserved }}</template></el-table-column>
              <el-table-column label="排队" width="50"><template #default="{ row }">{{ row[1].waiting }}</template></el-table-column>
            </el-table>
          </div>
        </div>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline style="max-height:300px;overflow:auto">
          <el-timeline-item
            v-for="entry in audits"
            :key="entry.id"
            :timestamp="new Date(entry.at).toLocaleString()"
            :type="auditTagType(entry.action)"
          >
            <b>{{ entry.actor }} · {{ entry.action }}</b>
            <div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
.stats { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px; }
@media (max-width: 900px) { .stats { grid-template-columns: 1fr 1fr; } }
</style>
