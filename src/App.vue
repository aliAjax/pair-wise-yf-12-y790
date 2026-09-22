<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  ORDER_STATUSES,
  PRODUCTS,
  SHORTAGE_TOLERANCE_L,
  canRemove,
  type StationLike,
  type UnloadingOrder,
} from "./unloading/rules";
import {
  availableCapacity,
  bindStations,
  cancelOrder,
  completeOrder,
  hasActiveJob,
  registerOrder,
  removeOrder,
  reviewOrder,
  startOrder,
  stationOf,
  tankOf,
  tanksOfStation,
  unloadState,
} from "./unloading/store";

type Field = {
  key: string;
  label: string;
  type?: "number" | "date" | "select";
  options?: readonly string[];
};

type RecordItem = {
  id: string;
  status: string;
  notes: string;
  createdAt: string;
  [key: string]: string | number;
};

const project = {
  "number": 21,
  "folder": "hxwl/frontend/hxwlfront-21",
  "framework": "vue",
  "title": "油站网点地图管理",
  "subtitle": "维护油站位置、营业状态和库存摘要。",
  "industry": "石油",
  "stack": [
    "Vue3",
    "Vite",
    "TypeScript",
    "Element Plus",
    "Leaflet"
  ],
  "storageKey": "hxwlfront-21-station-map",
  "formTitle": "新增油站",
  "primaryAction": "保存油站",
  "entityLabel": "油站",
  "statuses": [
    "营业中",
    "暂停营业",
    "库存紧张"
  ],
  "filters": [
    "全部区域",
    "东区",
    "西区",
    "机场线"
  ],
  "fields": [
    {
      "key": "station",
      "label": "油站名称"
    },
    {
      "key": "area",
      "label": "区域",
      "type": "select",
      "options": [
        "东区",
        "西区",
        "机场线"
      ]
    },
    {
      "key": "stock",
      "label": "库存摘要L",
      "type": "number"
    },
    {
      "key": "manager",
      "label": "负责人"
    }
  ],
  "records": [
    {
      "station": "东区一站",
      "area": "东区",
      "stock": 36000,
      "manager": "刘站长",
      "status": "营业中",
      "notes": "库存正常"
    },
    {
      "station": "机场快线站",
      "area": "机场线",
      "stock": 9000,
      "manager": "王站长",
      "status": "库存紧张",
      "notes": "柴油待补"
    }
  ],
  "metricLabels": [
    "油站数",
    "营业中",
    "库存紧张"
  ]
} as const;

const fields = project.fields as readonly Field[];
const statuses = [...project.statuses];

function createBlank() {
  return Object.fromEntries(fields.map((field) => [field.key, field.type === "number" ? 0 : ""]));
}

function loadRecords(): RecordItem[] {
  const raw = localStorage.getItem(project.storageKey);
  if (!raw) {
    return project.records.map((record, index) => ({
      ...record,
      id: `seed-${index + 1}`,
      createdAt: new Date(Date.now() - index * 86400000).toISOString()
    })) as RecordItem[];
  }
  try {
    return JSON.parse(raw) as RecordItem[];
  } catch {
    return [];
  }
}

const records = ref<RecordItem[]>(loadRecords());

// 卸油互锁台绑定站点状态：开工/完工直接读写站点状态与库存摘要，并复用站点持久化
bindStations(() => records.value as unknown as StationLike[], persist);
const form = reactive<Record<string, string | number>>(createBlank());
const note = ref("");
const filter = ref(project.filters[0]);

const filteredRecords = computed(() => {
  if (filter.value.startsWith("全部")) return records.value;
  return records.value.filter((record) => Object.values(record).includes(filter.value));
});

const metrics = computed(() => {
  const total = records.value.length;
  const second = records.value.filter((record) => record.status === statuses[1]).length;
  const third = records.value.filter((record) => record.status === statuses[2]).length;
  const numberValues = records.value.flatMap((record) =>
    fields.filter((field) => field.type === "number").map((field) => Number(record[field.key] || 0))
  );
  const sum = numberValues.reduce((acc, value) => acc + value, 0);
  return [total, second || sum, third || Math.round(sum / Math.max(total, 1))];
});

const chartRows = computed(() => statuses.map((status) => ({
  status,
  value: records.value.filter((record) => record.status === status).length
})));

const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

function persist() {
  localStorage.setItem(project.storageKey, JSON.stringify(records.value));
}

function nextStatus(status: string) {
  const index = statuses.indexOf(status);
  return statuses[(index + 1) % statuses.length];
}

function primaryText(record: RecordItem) {
  const first = fields[0];
  const second = fields[1];
  return [record[first.key], record[second.key]].filter(Boolean).join(" / ") || project.entityLabel;
}

function submit() {
  records.value = [
    {
      ...form,
      id: crypto.randomUUID(),
      status: statuses[0],
      notes: note.value || "暂无备注",
      createdAt: new Date().toISOString()
    } as RecordItem,
    ...records.value
  ];
  Object.assign(form, createBlank());
  note.value = "";
  persist();
}

function flow(record: RecordItem) {
  record.status = nextStatus(record.status);
  persist();
}

function remove(id: string) {
  records.value = records.value.filter((record) => record.id !== id);
  persist();
}

/* ---------- 卸油互锁台 ---------- */

const unloadForm = reactive({
  stationId: "",
  tankId: "",
  product: PRODUCTS[0] as string,
  plannedVolume: 0,
  slotStart: "",
  slotEnd: "",
  escort: "",
});

const registerFeedback = ref<{ kind: "success" | "waiting" | "rejected"; text: string } | null>(null);
const actualInputs = reactive<Record<string, number>>({});

const stationTanks = computed(() => tanksOfStation(unloadForm.stationId));

const sortedOrders = computed(() =>
  [...unloadState.orders].sort((a, b) => b.seq - a.seq)
);

const statusCounts = computed(() =>
  ORDER_STATUSES.map((status) => ({
    status,
    count: unloadState.orders.filter((order) => order.status === status).length
  })).filter((row) => row.count > 0)
);

const lockedStationNames = computed(() => {
  const names = new Set<string>();
  for (const order of unloadState.orders) {
    if (order.status === "待复核") names.add(stationName(order.stationId));
  }
  return [...names];
});

function stationName(id: string) {
  return stationOf(id)?.station ?? "（站点已删除）";
}

function tankName(id: string) {
  return tankOf(id)?.name ?? "（油罐已删除）";
}

function onStationPick() {
  unloadForm.tankId = "";
}

function onTankPick() {
  const tank = tankOf(unloadForm.tankId);
  if (tank) unloadForm.product = tank.product;
}

function submitUnloading() {
  const { order, reasons } = registerOrder({ ...unloadForm });
  if (order.status === "已排期") {
    registerFeedback.value = {
      kind: "success",
      text: `已排期：${stationName(order.stationId)} / ${tankName(order.tankId)}，${fmtTime(order.slotStart)} 起卸。`
    };
    resetUnloadForm();
  } else if (order.status === "候单中") {
    registerFeedback.value = {
      kind: "waiting",
      text: `时段重叠，整单不予排期，已转入候单（提交顺序 #${order.seq}），待罐位释放后按序补位。`
    };
    resetUnloadForm();
  } else {
    registerFeedback.value = {
      kind: "rejected",
      text: `整单拒绝：${reasons.join("；")}。原排期、库存与站点状态未变。`
    };
  }
}

function resetUnloadForm() {
  unloadForm.tankId = "";
  unloadForm.plannedVolume = 0;
  unloadForm.slotStart = "";
  unloadForm.slotEnd = "";
  unloadForm.escort = "";
}

function complete(order: UnloadingOrder) {
  const actual = Number(actualInputs[order.id] ?? order.plannedVolume);
  completeOrder(order.id, actual);
}

function fmtTime(iso: string) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso || "-";
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function diffText(order: UnloadingOrder) {
  if (order.actualVolume === null) return "—";
  const diff = order.actualVolume - order.plannedVolume;
  return `${diff > 0 ? "+" : ""}${diff}L`;
}

const STATUS_CLASS: Record<string, string> = {
  已排期: "st-booked",
  候单中: "st-waiting",
  卸油中: "st-active",
  待复核: "st-review",
  已完工: "st-done",
  已取消: "st-closed",
  已拒绝: "st-closed"
};

function statusClass(status: string) {
  return STATUS_CLASS[status] ?? "";
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业前端最小闭环</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="(label, index) in project.metricLabels" :key="label" class="metric">
          <span>{{ label }}</span>
          <strong>{{ metrics[index] }}</strong>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>{{ project.formTitle }}</h2>
          <div class="form-grid">
            <label v-for="field in fields" :key="field.key">
              {{ field.label }}
              <select v-if="field.type === 'select'" v-model="form[field.key]" required>
                <option value="">请选择</option>
                <option v-for="option in field.options" :key="option">{{ option }}</option>
              </select>
              <input v-else v-model="form[field.key]" :type="field.type || 'text'" required />
            </label>
            <label>
              备注
              <textarea v-model="note" placeholder="填写处理说明或现场备注" />
            </label>
            <button type="submit">{{ project.primaryAction }}</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>{{ project.entityLabel }}列表</h2>
            <select v-model="filter">
              <option v-for="item in project.filters" :key="item">{{ item }}</option>
            </select>
          </div>

          <div class="record-grid">
            <div v-if="filteredRecords.length === 0" class="empty">暂无匹配数据</div>
            <article v-for="record in filteredRecords" :key="record.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ primaryText(record) }}</p>
                <span class="status">{{ record.status }}</span>
              </div>
              <div class="details">
                <span v-for="field in fields" :key="field.key">{{ field.label }}: {{ record[field.key] }}</span>
              </div>
              <p class="note">{{ record.notes }}</p>
              <div class="actions">
                <button type="button" @click="flow(record)">流转状态</button>
                <button class="secondary" type="button" @click="navigator.clipboard?.writeText(primaryText(record))">复制摘要</button>
                <button class="danger" type="button" @click="remove(record.id)">删除</button>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>
      </section>

      <section class="workspace unload-section">
        <form class="panel" @submit.prevent="submitUnloading">
          <h2>卸油互锁台 · 登记卸油单</h2>
          <div class="form-grid">
            <label>
              油站
              <select v-model="unloadForm.stationId" required @change="onStationPick">
                <option value="">请选择</option>
                <option v-for="item in records" :key="item.id" :value="item.id">
                  {{ item.station }}（{{ item.status }}）
                </option>
              </select>
            </label>
            <label>
              油罐
              <select v-model="unloadForm.tankId" required @change="onTankPick">
                <option value="">请选择</option>
                <option v-for="tank in stationTanks" :key="tank.id" :value="tank.id">
                  {{ tank.name }} · {{ tank.product }} · 余量 {{ availableCapacity(tank) }}L
                </option>
              </select>
            </label>
            <p v-if="unloadForm.stationId && stationTanks.length === 0" class="hint">该站暂无油罐，无法登记卸油。</p>
            <label>
              油品
              <select v-model="unloadForm.product" required>
                <option v-for="item in PRODUCTS" :key="item">{{ item }}</option>
              </select>
            </label>
            <label>
              来油体积L
              <input v-model.number="unloadForm.plannedVolume" type="number" min="1" required />
            </label>
            <label>
              计划开始
              <input v-model="unloadForm.slotStart" type="datetime-local" required />
            </label>
            <label>
              计划结束
              <input v-model="unloadForm.slotEnd" type="datetime-local" required />
            </label>
            <label>
              押运员
              <input v-model="unloadForm.escort" placeholder="姓名 / 联系方式" required />
            </label>
            <button type="submit">登记卸油单</button>
            <p v-if="registerFeedback" class="alert" :class="registerFeedback.kind">{{ registerFeedback.text }}</p>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>卸油单与油罐库存</h2>
            <div class="chips">
              <span v-for="row in statusCounts" :key="row.status" class="chip">{{ row.status }} {{ row.count }}</span>
            </div>
          </div>

          <p v-if="lockedStationNames.length" class="banner">
            待复核锁定：{{ lockedStationNames.join("、") }} 存在短溢超 {{ SHORTAGE_TOLERANCE_L }}L 待复核单，复核归档前不得再排新单。
          </p>

          <table class="tank-table">
            <thead>
              <tr><th>油站 / 油罐</th><th>油品</th><th>库存 / 罐容</th><th>可卸余量</th></tr>
            </thead>
            <tbody>
              <tr v-for="tank in unloadState.tanks" :key="tank.id">
                <td>{{ stationName(tank.stationId) }} · {{ tank.name }}</td>
                <td>{{ tank.product }}</td>
                <td>{{ tank.stock }} / {{ tank.capacity }}L</td>
                <td>{{ availableCapacity(tank) }}L</td>
              </tr>
              <tr v-if="unloadState.tanks.length === 0"><td colspan="4" class="empty">暂无油罐</td></tr>
            </tbody>
          </table>

          <div class="record-grid">
            <div v-if="sortedOrders.length === 0" class="empty">暂无卸油单</div>
            <article v-for="order in sortedOrders" :key="order.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ stationName(order.stationId) }} / {{ tankName(order.tankId) }} · {{ order.product }}</p>
                <span class="status" :class="statusClass(order.status)">{{ order.status }}</span>
              </div>
              <div class="details">
                <span>来油体积: {{ order.plannedVolume }}L</span>
                <span>实收体积: {{ order.actualVolume === null ? "—" : `${order.actualVolume}L` }}</span>
                <span>计划时段: {{ fmtTime(order.slotStart) }} ~ {{ fmtTime(order.slotEnd) }}</span>
                <span>押运员: {{ order.escort }}</span>
                <span>提交顺序: #{{ order.seq }}</span>
                <span v-if="order.actualVolume !== null">短溢: {{ diffText(order) }}</span>
              </div>
              <p v-if="order.reasons.length" class="note">{{ order.reasons.join("；") }}</p>
              <div class="actions">
                <template v-if="order.status === '已排期'">
                  <button
                    type="button"
                    :disabled="hasActiveJob(unloadState.orders, order.stationId)"
                    :title="hasActiveJob(unloadState.orders, order.stationId) ? '站点已有卸油作业进行中' : ''"
                    @click="startOrder(order.id)"
                  >开工</button>
                  <button class="secondary" type="button" @click="cancelOrder(order.id)">取消</button>
                </template>
                <template v-else-if="order.status === '候单中'">
                  <button class="secondary" type="button" @click="cancelOrder(order.id)">取消候单</button>
                </template>
                <template v-else-if="order.status === '卸油中'">
                  <input
                    v-model.number="actualInputs[order.id]"
                    class="actual-input"
                    type="number"
                    min="0"
                    :placeholder="`实收体积L（计划 ${order.plannedVolume}）`"
                  />
                  <button type="button" @click="complete(order)">完工入库</button>
                </template>
                <template v-else-if="order.status === '待复核'">
                  <button type="button" @click="reviewOrder(order.id)">复核归档</button>
                </template>
                <button v-if="canRemove(order)" class="danger" type="button" @click="removeOrder(order.id)">删除</button>
              </div>
            </article>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
