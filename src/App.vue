<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  PRODUCTS,
  STATION_STATUSES,
  ORDER_STATUSES,
  type Product,
  type StationStatus,
  type UnloadOrder
} from "./business/rules";
import { type ActionFeedback, useUnloadStore } from "./business/state";

const store = useUnloadStore();
const { state, stations, orders, tanksByStation, stationById, tankById, waitingSnapshot } = store;

const filters = ["全部单据", ...ORDER_STATUSES] as const;
const filter = ref<(typeof filters)[number]>("全部单据");

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

function defaultLocal(daysFromNow: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

const form = reactive({
  stationId: state.stations[0]?.id ?? "",
  tankId: "",
  product: PRODUCTS[0] as Product,
  incomingVolume: "10000",
  startAt: defaultLocal(1, 9),
  endAt: defaultLocal(1, 11),
  escort: "",
  notes: ""
});

const tankOptions = computed(() => tanksByStation(form.stationId));

function syncStation() {
  const first = tankOptions.value[0];
  form.tankId = first?.id ?? "";
  if (first) form.product = first.product;
}

function syncTank() {
  const tank = tankById(form.tankId);
  if (tank) form.product = tank.product;
}

syncStation();

const formError = ref("");
const feedback = ref<ActionFeedback | null>(null);

function submit() {
  formError.value = "";
  if (!form.tankId) {
    formError.value = "请选择油罐";
    return;
  }
  const volume = Number(form.incomingVolume);
  if (!form.escort.trim()) {
    formError.value = "请填写押运员";
    return;
  }
  if (!form.startAt || !form.endAt || form.endAt <= form.startAt) {
    formError.value = "计划时段无效：结束时间必须晚于开始时间";
    return;
  }
  feedback.value = store.submitOrder({
    stationId: form.stationId,
    tankId: form.tankId,
    product: form.product,
    incomingVolume: volume,
    startAt: fromLocalInput(form.startAt),
    endAt: fromLocalInput(form.endAt),
    escort: form.escort.trim(),
    notes: form.notes.trim()
  });
  form.notes = "";
}

const filteredOrders = computed(() => {
  if (filter.value === "全部单据") return orders.value;
  return orders.value.filter((order) => order.status === filter.value);
});

const metrics = computed(() => [
  { label: "候单中", value: store.countByStatus("候单中") },
  { label: "已排期 / 作业中", value: store.countByStatus("已排期") + store.countByStatus("作业中") },
  { label: "待复核", value: store.countByStatus("待复核") },
  { label: "已完工", value: store.countByStatus("已完工") }
]);

function stationName(order: UnloadOrder): string {
  return stationById(order.stationId)?.name ?? "未知站点";
}

function tankCode(order: UnloadOrder): string {
  return tankById(order.tankId)?.code ?? "未知油罐";
}

function formatWindow(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusClass(status: string): string {
  if (status === "候单中") return "status-wait";
  if (status === "已排期") return "status-scheduled";
  if (status === "作业中") return "status-working";
  if (status === "待复核") return "status-review";
  if (status === "已拒绝" || status === "已取消") return "status-off";
  return "status-done";
}

function stationStatusClass(status: StationStatus): string {
  if (status === "营业中") return "station-open";
  if (status === "暂停营业") return "station-paused";
  return "station-tight";
}

function tankFill(tankId: string): number {
  const tank = store.tankById(tankId);
  if (!tank) return 0;
  return Math.round((tank.stock / tank.capacity) * 100);
}

function activeOrdersOnTank(tankId: string): UnloadOrder[] {
  return state.orders.filter(
    (order) => order.tankId === tankId && (order.status === "已排期" || order.status === "作业中")
  );
}

function reviewingOnStation(stationId: string): boolean {
  return state.orders.some(
    (order) => order.stationId === stationId && order.status === "待复核"
  );
}

function setStation(stationId: string, event: Event) {
  const status = (event.target as HTMLSelectElement).value as StationStatus;
  feedback.value = store.setStationStatus(stationId, status);
}

function cancel(id: string) {
  feedback.value = store.cancelOrder(id);
}

function start(id: string) {
  feedback.value = store.startOrder(id);
}

const completeInputs = reactive<Record<string, string>>({});
function completeDraft(order: UnloadOrder): string {
  if (!(order.id in completeInputs)) completeInputs[order.id] = String(order.incomingVolume);
  return completeInputs[order.id];
}
function finish(id: string) {
  feedback.value = store.completeOrder(id, Number(completeInputs[id]));
}

const reviewInputs = reactive<Record<string, string>>({});
function reviewDraft(order: UnloadOrder): string {
  if (!(order.id in reviewInputs)) {
    reviewInputs[order.id] = String(order.receivedVolume ?? order.incomingVolume);
  }
  return reviewInputs[order.id];
}
function review(id: string) {
  feedback.value = store.reviewOrder(id, Number(reviewInputs[id]));
}

function resetDemo() {
  feedback.value = store.resetAll();
  syncStation();
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业前端最小闭环 · 油站网点扩展</p>
          <h1>卸油互锁台</h1>
          <p class="subtitle">
            登记油罐、油品、来油体积、计划时段与押运员；时段重叠进候单按提交顺序补位，
            罐容不足 / 油品不符 / 站点营业中 / 待复核封锁则整单拒绝，原排期、库存与站点状态不变。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">TypeScript</span>
          <span class="tag">localStorage</span>
          <button class="secondary" type="button" @click="resetDemo">恢复演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <section class="stations">
        <article v-for="station in stations" :key="station.id" class="station-card">
          <div class="record-head">
            <div>
              <p class="record-title">{{ station.name }}</p>
              <p class="station-meta">{{ station.area }} · 负责人 {{ station.manager }}</p>
            </div>
            <div class="station-controls">
              <span class="status" :class="stationStatusClass(station.status)">{{ station.status }}</span>
              <label class="inline-select">
                营业状态
                <select :value="station.status" @change="setStation(station.id, $event)">
                  <option v-for="item in STATION_STATUSES" :key="item" :value="item">{{ item }}</option>
                </select>
              </label>
            </div>
          </div>
          <p v-if="reviewingOnStation(station.id)" class="banner banner-review">
            该站存在待复核短溢单：库存冻结待核，复核通过前不得再排新单。
          </p>
          <div class="tank-list">
            <div v-for="tank in tanksByStation(station.id)" :key="tank.id" class="tank-row">
              <div class="tank-info">
                <strong>{{ tank.code }}</strong>
                <span class="tank-product">{{ tank.product }}</span>
                <span class="tank-stock">{{ tank.stock }} / {{ tank.capacity }} L（{{ tankFill(tank.id) }}%）</span>
              </div>
              <div class="bar-track tank-bar">
                <div class="bar-fill" :style="{ width: `${tankFill(tank.id)}%` }" />
              </div>
              <div v-if="activeOrdersOnTank(tank.id).length" class="tank-badges">
                <span
                  v-for="busy in activeOrdersOnTank(tank.id)"
                  :key="busy.id"
                  class="mini-badge"
                  :class="statusClass(busy.status)"
                >
                  {{ busy.code }} · {{ formatWindow(busy.startAt) }} 起
                </span>
              </div>
            </div>
          </div>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>卸油登记</h2>
          <div class="form-grid">
            <label>
              油站
              <select v-model="form.stationId" @change="syncStation" required>
                <option v-for="station in stations" :key="station.id" :value="station.id">
                  {{ station.name }}（{{ station.status }}）
                </option>
              </select>
            </label>
            <label>
              油罐
              <select v-model="form.tankId" @change="syncTank" required>
                <option value="" disabled>请选择油罐</option>
                <option v-for="tank in tankOptions" :key="tank.id" :value="tank.id">
                  {{ tank.code }} · {{ tank.product }} · 余 {{ tank.capacity - tank.stock }}L
                </option>
              </select>
            </label>
            <label>
              油品
              <select v-model="form.product" required>
                <option v-for="item in PRODUCTS" :key="item" :value="item">{{ item }}</option>
              </select>
            </label>
            <label>
              来油体积 L
              <input v-model="form.incomingVolume" type="number" min="1" step="100" required />
            </label>
            <label>
              计划开始
              <input v-model="form.startAt" type="datetime-local" required />
            </label>
            <label>
              计划结束
              <input v-model="form.endAt" type="datetime-local" required />
            </label>
            <label>
              押运员
              <input v-model="form.escort" type="text" placeholder="填写随车押运员姓名" required />
            </label>
            <label>
              备注
              <textarea v-model="form.notes" placeholder="承运单号、车牌或现场备注（选填）" />
            </label>
            <p v-if="formError" class="banner banner-reject">{{ formError }}</p>
            <button type="submit">提交互锁校验</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>卸油单流转</h2>
            <select v-model="filter">
              <option v-for="item in filters" :key="item" :value="item">{{ item }}</option>
            </select>
          </div>

          <div
            v-if="feedback"
            class="banner"
            :class="{
              'banner-ok': feedback.kind === 'ok' || feedback.kind === 'scheduled',
              'banner-wait': feedback.kind === 'waiting',
              'banner-reject': feedback.kind === 'rejected',
              'banner-info': feedback.kind === 'info'
            }"
          >
            <strong>{{ feedback.message }}</strong>
            <ul v-if="feedback.reasons?.length">
              <li v-for="reason in feedback.reasons" :key="reason">{{ reason }}</li>
            </ul>
          </div>

          <div class="record-grid">
            <div v-if="filteredOrders.length === 0" class="empty">暂无匹配单据</div>
            <article v-for="order in filteredOrders" :key="order.id" class="record">
              <div class="record-head">
                <div>
                  <p class="record-title">{{ order.code }}</p>
                  <p class="station-meta">第 {{ order.seq }} 顺位提交 · 押运员 {{ order.escort }}</p>
                </div>
                <span class="status" :class="statusClass(order.status)">{{ order.status }}</span>
              </div>

              <div class="details">
                <span>站点：{{ stationName(order) }}</span>
                <span>油罐：{{ tankCode(order) }}</span>
                <span>油品：{{ order.product }}</span>
                <span>来油体积：{{ order.incomingVolume }} L</span>
                <span>计划时段：{{ formatWindow(order.startAt) }} ~ {{ formatWindow(order.endAt) }}</span>
                <span v-if="order.receivedVolume !== undefined">
                  实收：{{ order.receivedVolume }} L
                  <em v-if="order.variance !== undefined">（{{ order.variance >= 0 ? "+" : "" }}{{ order.variance }} L）</em>
                </span>
              </div>

              <p v-if="order.notes" class="note">{{ order.notes }}</p>

              <div v-if="order.status === '候单中'" class="banner banner-wait">
                <template v-if="store.waitingSnapshot(order).canPromote">
                  罐位已空，下次释放事件即可补位。
                </template>
                <template v-else>
                  当前仍被拦截：
                  <ul>
                    <li v-for="reason in store.waitingSnapshot(order).reasons" :key="reason">{{ reason }}</li>
                  </ul>
                </template>
              </div>

              <div v-if="order.reasons.length && (order.status === '已拒绝' || order.status === '待复核')" class="banner banner-reject">
                <ul>
                  <li v-for="reason in order.reasons" :key="reason">{{ reason }}</li>
                </ul>
              </div>

              <div v-if="order.status === '作业中'" class="inline-action">
                <label>
                  实收体积 L
                  <input
                    :value="completeDraft(order)"
                    @input="completeInputs[order.id] = ($event.target as HTMLInputElement).value"
                    type="number"
                    min="0"
                    step="10"
                  />
                </label>
                <button type="button" @click="finish(order.id)">完工入库 / 恢复站点</button>
              </div>

              <div v-if="order.status === '待复核'" class="inline-action">
                <label>
                  复核确认体积 L
                  <input
                    :value="reviewDraft(order)"
                    @input="reviewInputs[order.id] = ($event.target as HTMLInputElement).value"
                    type="number"
                    min="0"
                    step="10"
                  />
                </label>
                <button type="button" @click="review(order.id)">复核通过并入库</button>
              </div>

              <div class="actions">
                <button v-if="order.status === '已排期'" type="button" @click="start(order.id)">开工（暂停营业）</button>
                <button
                  v-if="order.status === '候单中' || order.status === '已排期'"
                  class="danger"
                  type="button"
                  @click="cancel(order.id)"
                >
                  取消（释放罐位）
                </button>
              </div>
            </article>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
