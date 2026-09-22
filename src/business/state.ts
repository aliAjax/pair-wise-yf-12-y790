// 卸油互锁台状态层：响应式编排。提交/取消/补位/开工/完工/复核的流转都在此落地，
// 判定委托规则层，落盘委托持久化层。

import { computed, reactive } from "vue";
import {
  type InterlockResult,
  type OrderDraftData,
  type OrderStatus,
  type StationStatus,
  type UnloadOrder,
  evaluateInterlock,
  needsReview,
  overlapReasons
} from "./rules";
import {
  type PersistedState,
  loadState,
  resetState,
  saveState
} from "./persistence";

export interface ActionFeedback {
  kind: "scheduled" | "waiting" | "rejected" | "info" | "ok";
  orderId?: string;
  message: string;
  reasons?: string[];
}

const initial: PersistedState = loadState();

const state = reactive<PersistedState>({
  version: initial.version,
  seq: initial.seq,
  stations: initial.stations,
  tanks: initial.tanks,
  orders: initial.orders
});

function persist() {
  saveState({
    version: state.version,
    seq: state.seq,
    stations: state.stations,
    tanks: state.tanks,
    orders: state.orders
  });
}

function orderCode(): string {
  const date = new Date();
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate()
  ).padStart(2, "0")}`;
  return `XY-${ymd}-${String(state.seq + 1).padStart(3, "0")}`;
}

function evaluate(data: OrderDraftData, excludeOrderId?: string): InterlockResult {
  return evaluateInterlock(
    data,
    { stations: state.stations, tanks: state.tanks, orders: state.orders },
    excludeOrderId
  );
}

/**
 * 候单补位：按提交顺序（seq）扫描候单。
 * 无任何冲突者补入排期；遇到首个仍无法通过的候单即停止，后续候单不得越位。
 * 返回本次被补位的单据。
 */
function promoteWaiting(): UnloadOrder[] {
  const promoted: UnloadOrder[] = [];
  const waiting = state.orders
    .filter((order) => order.status === "候单中")
    .sort((a, b) => a.seq - b.seq);

  for (const order of waiting) {
    const result = evaluate(order, order.id);
    if (!result.ok) {
      // 头单仍不满足：更新其等待/拒绝原因后停止扫描，杜绝越位。
      order.reasons = [
        ...result.hardViolations,
        ...overlapReasons(result.overlapOrders)
      ];
      break;
    }
    order.status = "已排期";
    order.scheduledAt = new Date().toISOString();
    order.reasons = [];
    promoted.push(order);
  }
  return promoted;
}

/**
 * 登记卸油单：
 * - 有硬性冲突（罐容不足/油品不符/营业中/待复核封锁等）：整单拒绝，原排期、库存、站点状态不变；
 * - 仅时段重叠：整单不锁罐，按提交顺序进入候单；
 * - 无冲突：直接锁定排期。
 */
function submitOrder(data: OrderDraftData): ActionFeedback {
  const result = evaluate(data);
  const seq = ++state.seq;
  const order: UnloadOrder = {
    ...data,
    id: crypto.randomUUID(),
    code: orderCode(),
    seq,
    status: "候单中",
    createdAt: new Date().toISOString(),
    reasons: []
  };

  if (result.hardViolations.length > 0) {
    order.status = "已拒绝";
    order.reasons = [
      ...result.hardViolations,
      ...overlapReasons(result.overlapOrders)
    ];
    state.orders.unshift(order);
    persist();
    return {
      kind: "rejected",
      orderId: order.id,
      message: `整单拒绝：${order.code} 未进入任何排期，原排期、库存与站点状态均未改动。`,
      reasons: order.reasons
    };
  }

  if (result.overlapOrders.length > 0) {
    order.reasons = overlapReasons(result.overlapOrders);
    state.orders.unshift(order);
    persist();
    return {
      kind: "waiting",
      orderId: order.id,
      message: `${order.code} 已进候单（第 ${seq} 顺位）：时段与在罐单据重叠，未占用油罐与时段，释放后按提交顺序补位。`,
      reasons: order.reasons
    };
  }

  order.status = "已排期";
  order.scheduledAt = new Date().toISOString();
  state.orders.unshift(order);
  persist();
  return {
    kind: "scheduled",
    orderId: order.id,
    message: `${order.code} 排期已锁定：油罐与时段占用成功。`
  };
}

/** 取消候单/已排期：释放油罐与时段，随后候单按提交顺序补位。 */
function cancelOrder(id: string): ActionFeedback {
  const order = state.orders.find((item) => item.id === id);
  if (!order || (order.status !== "候单中" && order.status !== "已排期")) {
    return { kind: "info", message: "仅候单中或已排期的单据可以取消。" };
  }
  order.status = "已取消";
  order.reasons = [];
  const promoted = promoteWaiting();
  persist();
  const tail =
    promoted.length > 0
      ? `补位成功：${promoted.map((item) => item.code).join("、")} 已锁入排期。`
      : "当前没有可补位的候单。";
  return { kind: "ok", orderId: id, message: `${order.code} 已取消，油罐与时段已释放。${tail}` };
}

/** 开工：站点转为暂停营业，记录其原状态供完工恢复。 */
function startOrder(id: string): ActionFeedback {
  const order = state.orders.find((item) => item.id === id);
  if (!order || order.status !== "已排期") {
    return { kind: "info", message: "仅已排期的单据可以开工。" };
  }
  const station = state.stations.find((item) => item.id === order.stationId);
  if (!station) return { kind: "info", message: "站点不存在，无法开工。" };

  order.prevStationStatus = station.status;
  station.status = "暂停营业";
  order.status = "作业中";
  order.startedAt = new Date().toISOString();
  persist();
  return {
    kind: "ok",
    orderId: id,
    message: `${order.code} 已开工：${station.name} 转为暂停营业（原状态 ${order.prevStationStatus}，完工后恢复）。`
  };
}

/**
 * 完工：按实收体积入库并恢复站点原状态；
 * 短溢超 50L：进入待复核，不入库、不恢复，该站不得再排新单，候单不得补入该站。
 */
function completeOrder(id: string, receivedVolume: number): ActionFeedback {
  const order = state.orders.find((item) => item.id === id);
  if (!order || order.status !== "作业中") {
    return { kind: "info", message: "仅作业中的单据可以完工。" };
  }
  if (!(Number.isFinite(receivedVolume) && receivedVolume >= 0)) {
    return { kind: "info", message: "实收体积必须为不小于 0 的升数。" };
  }

  const tank = state.tanks.find((item) => item.id === order.tankId);
  const station = state.stations.find((item) => item.id === order.stationId);
  const variance = receivedVolume - order.incomingVolume;

  if (needsReview(receivedVolume, order.incomingVolume)) {
    order.status = "待复核";
    order.finishedAt = new Date().toISOString();
    order.receivedVolume = receivedVolume;
    order.variance = variance;
    order.reasons = [
      `实收 ${receivedVolume}L 与来油计划 ${order.incomingVolume}L 相差 ${
        variance >= 0 ? "+" : ""
      }${variance}L，超过 50L 容差，转待复核`
    ];
    // 待复核不入库、站点保持暂停营业，且该站封锁新排期。
    persist();
    return {
      kind: "rejected",
      orderId: id,
      message: `${order.code} 短溢超 50L，进入待复核：库存未动、站点保持暂停营业，复核完成前该站不得再排新单。`,
      reasons: order.reasons
    };
  }

  order.status = "已完工";
  order.finishedAt = new Date().toISOString();
  order.receivedVolume = receivedVolume;
  order.variance = variance;
  order.reasons = [];
  if (tank) tank.stock += receivedVolume;
  if (station && order.prevStationStatus) station.status = order.prevStationStatus;

  // 时段与油罐随完工释放，候单补位。
  const promoted = promoteWaiting();
  persist();
  const tail =
    promoted.length > 0
      ? ` 候单补位：${promoted.map((item) => item.code).join("、")}。`
      : "";
  return {
    kind: "ok",
    orderId: id,
    message: `${order.code} 完工：实收 ${receivedVolume}L 已入库${
      tank ? `（${tank.code} 库存 ${tank.stock}L）` : ""
    }，${station?.name ?? "站点"} 恢复为 ${order.prevStationStatus}。${tail}`
  };
}

/** 复核通过：按实收体积补入库、恢复站点原状态，并尝试让该站候单补位。 */
function reviewOrder(id: string, receivedVolume?: number): ActionFeedback {
  const order = state.orders.find((item) => item.id === id);
  if (!order || order.status !== "待复核") {
    return { kind: "info", message: "仅待复核单据可以执行复核。" };
  }
  const volume = receivedVolume ?? order.receivedVolume ?? order.incomingVolume;
  if (!(Number.isFinite(volume) && volume >= 0)) {
    return { kind: "info", message: "复核确认体积必须为不小于 0 的升数。" };
  }

  const tank = state.tanks.find((item) => item.id === order.tankId);
  const station = state.stations.find((item) => item.id === order.stationId);

  // 复核也不得让库存超罐容。
  if (tank && tank.stock + volume > tank.capacity) {
    return {
      kind: "rejected",
      orderId: id,
      message: `复核拒绝入库：${tank.code} 库存 ${tank.stock}L + 实收 ${volume}L 超过罐容 ${tank.capacity}L，单据保持待复核。`
    };
  }

  order.status = "已完工";
  order.receivedVolume = volume;
  order.variance = volume - order.incomingVolume;
  order.reasons = [];
  if (tank) tank.stock += volume;
  if (station && order.prevStationStatus) station.status = order.prevStationStatus;

  const promoted = promoteWaiting();
  persist();
  const tail =
    promoted.length > 0
      ? ` 封锁解除，候单补位：${promoted.map((item) => item.code).join("、")}。`
      : " 封锁解除。";
  return {
    kind: "ok",
    orderId: id,
    message: `${order.code} 复核通过：实收 ${volume}L 已入库，站点恢复为 ${
      order.prevStationStatus ?? "原状态"
    }。${tail}`
  };
}

/** 手工调整站点营业状态；作业中站点被互锁占用，不允许切换。 */
function setStationStatus(stationId: string, status: StationStatus): ActionFeedback {
  const station = state.stations.find((item) => item.id === stationId);
  if (!station) return { kind: "info", message: "站点不存在。" };
  const occupied = state.orders.some(
    (order) => order.stationId === stationId && order.status === "作业中"
  );
  if (occupied) {
    return { kind: "info", message: `${station.name} 有卸油作业进行中，站点状态被互锁，无法手工切换。` };
  }
  station.status = status;
  // 由营业中转为暂停营业后，候单可能因此满足条件。
  const promoted = promoteWaiting();
  persist();
  const tail = promoted.length > 0
    ? ` 候单补位：${promoted.map((item) => item.code).join("、")}。`
    : "";
  return { kind: "ok", message: `${station.name} 已置为 ${status}。${tail}` };
}

function resetAll(): ActionFeedback {
  const seed = resetState();
  state.version = seed.version;
  state.seq = seed.seq;
  state.stations.splice(0, state.stations.length, ...seed.stations);
  state.tanks.splice(0, state.tanks.length, ...seed.tanks);
  state.orders.splice(0, state.orders.length, ...seed.orders);
  return { kind: "ok", message: "已恢复演示数据：站点、油罐、库存与排期全部重置。" };
}

/** 候单当前补位预判（仅展示，不改状态）。 */
function waitingSnapshot(order: UnloadOrder): { canPromote: boolean; reasons: string[] } {
  const result = evaluate(order, order.id);
  return {
    canPromote: result.ok,
    reasons: [...result.hardViolations, ...overlapReasons(result.overlapOrders)]
  };
}

const stations = computed(() => state.stations);
const tanks = computed(() => state.tanks);
const orders = computed(() =>
  [...state.orders].sort((a, b) => b.seq - a.seq)
);

function countByStatus(status: OrderStatus): number {
  return state.orders.filter((order) => order.status === status).length;
}

function tanksByStation(stationId: string) {
  return state.tanks.filter((tank) => tank.stationId === stationId);
}

function stationById(id: string) {
  return state.stations.find((station) => station.id === id);
}

function tankById(id: string) {
  return state.tanks.find((tank) => tank.id === id);
}

export function useUnloadStore() {
  return {
    state,
    stations,
    tanks,
    orders,
    countByStatus,
    tanksByStation,
    stationById,
    tankById,
    waitingSnapshot,
    submitOrder,
    cancelOrder,
    startOrder,
    completeOrder,
    reviewOrder,
    setStationStatus,
    resetAll
  };
}
