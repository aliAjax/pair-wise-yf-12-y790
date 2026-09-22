/**
 * 卸油互锁台 · 状态层
 * 持有油罐与卸油单的响应式状态，所有状态迁移都走这里的动作，
 * 校验委托 rules.ts，读写委托 storage.ts。
 */

import { reactive } from "vue";
import {
  STATION_PAUSED,
  availableCapacity,
  canCancel,
  canComplete,
  canRemove,
  canReview,
  canStart,
  discrepancy,
  hasActiveJob,
  isOverlapOnly,
  validateRegistration,
  SHORTAGE_TOLERANCE_L,
  type OrderStatus,
  type RegistrationInput,
  type StationLike,
  type Tank,
  type UnloadingOrder,
} from "./rules";
import { loadUnloading, saveUnloading } from "./storage";

export const unloadState = reactive({
  ready: false,
  seq: 0,
  tanks: [] as Tank[],
  orders: [] as UnloadingOrder[],
});

/** 站点列表与持久化由油站页持有，这里只做绑定、不复制状态 */
interface StationHost {
  stations: () => StationLike[];
  persist: () => void;
}

let host: StationHost | null = null;

export function bindStations(
  stations: () => StationLike[],
  persist: () => void
): void {
  host = { stations, persist };
  if (unloadState.ready) return;
  const snapshot = loadUnloading(stations());
  unloadState.seq = snapshot.seq;
  unloadState.tanks = snapshot.tanks;
  unloadState.orders = snapshot.orders;
  unloadState.ready = true;
}

function persist(): void {
  saveUnloading({
    version: 1,
    seq: unloadState.seq,
    tanks: unloadState.tanks,
    orders: unloadState.orders,
  });
  host?.persist(); // 站点状态 / 库存摘要可能已联动变化
}

export function stationOf(stationId: string): StationLike | undefined {
  return host?.stations().find((station) => station.id === stationId);
}

export function tankOf(tankId: string): Tank | undefined {
  return unloadState.tanks.find((tank) => tank.id === tankId);
}

export function tanksOfStation(stationId: string): Tank[] {
  return unloadState.tanks.filter((tank) => tank.stationId === stationId);
}

/** 站点库存摘要 = 名下油罐库存合计 */
function syncStationStock(stationId: string): void {
  const station = stationOf(stationId);
  if (!station) return;
  station.stock = tanksOfStation(stationId).reduce(
    (sum, tank) => sum + tank.stock,
    0
  );
}

function toIso(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

export interface RegisterResult {
  order: UnloadingOrder;
  reasons: string[];
}

/**
 * 登记卸油单：
 * - 校验全部通过 -> 已排期；
 * - 仅时段重叠   -> 候单中（不占用罐位，等取消补位）；
 * - 其余任一原因 -> 已拒绝，整单作废，排期 / 库存 / 站点状态不变。
 */
export function registerOrder(input: RegistrationInput): RegisterResult {
  const tank = tankOf(input.tankId);
  const station = tank ? stationOf(tank.stationId) : undefined;
  const reasons = validateRegistration(input, {
    tank,
    station,
    orders: unloadState.orders,
  });
  const status: OrderStatus =
    reasons.length === 0 ? "已排期" : isOverlapOnly(reasons) ? "候单中" : "已拒绝";

  const order: UnloadingOrder = {
    id: crypto.randomUUID(),
    seq: ++unloadState.seq,
    stationId: station?.id ?? "",
    tankId: input.tankId,
    product: input.product,
    plannedVolume: input.plannedVolume,
    actualVolume: null,
    slotStart: toIso(input.slotStart),
    slotEnd: toIso(input.slotEnd),
    escort: input.escort.trim(),
    status,
    reasons,
    prevStationStatus: null,
    createdAt: new Date().toISOString(),
  };
  unloadState.orders.push(order);
  persist();
  return { order, reasons };
}

/** 候单按提交顺序补位：逐单重跑登记校验，通过即转已排期 */
function promoteWaiting(): void {
  const waiting = unloadState.orders
    .filter((order) => order.status === "候单中")
    .sort((a, b) => a.seq - b.seq);
  for (const order of waiting) {
    const tank = tankOf(order.tankId);
    const station = tank ? stationOf(tank.stationId) : undefined;
    const reasons = validateRegistration(
      {
        tankId: order.tankId,
        product: order.product,
        plannedVolume: order.plannedVolume,
        slotStart: order.slotStart,
        slotEnd: order.slotEnd,
        escort: order.escort,
      },
      { tank, station, orders: unloadState.orders }
    );
    if (reasons.length === 0) {
      order.status = "已排期";
      order.reasons = ["候单补位成功"];
    }
  }
}

/** 取消：释放油罐与时段，候单补位 */
export function cancelOrder(orderId: string): void {
  const order = unloadState.orders.find((item) => item.id === orderId);
  if (!order || !canCancel(order)) return;
  const released = order.status === "已排期";
  order.status = "已取消";
  order.reasons = [];
  if (released) promoteWaiting();
  persist();
}

/** 开工：站点转暂停营业，记下原状态待完工恢复 */
export function startOrder(orderId: string): boolean {
  const order = unloadState.orders.find((item) => item.id === orderId);
  if (!order || !canStart(order, unloadState.orders)) return false;
  const station = stationOf(order.stationId);
  if (!station) return false;
  order.prevStationStatus = station.status;
  station.status = STATION_PAUSED;
  order.status = "卸油中";
  persist();
  return true;
}

/**
 * 完工：按实收体积入库（不超过罐容上限），站点恢复原状态；
 * 短溢超容差 -> 待复核，复核前该站不得再排新单。
 */
export function completeOrder(orderId: string, actualVolume: number): boolean {
  const order = unloadState.orders.find((item) => item.id === orderId);
  if (!order || !canComplete(order)) return false;
  if (!Number.isFinite(actualVolume) || actualVolume < 0) return false;

  const tank = tankOf(order.tankId);
  const station = stationOf(order.stationId);
  order.actualVolume = actualVolume;
  if (tank) tank.stock = Math.min(tank.capacity, tank.stock + actualVolume);
  if (station) {
    station.status = order.prevStationStatus ?? station.status;
    syncStationStock(station.id);
  }

  const { diff, overTolerance } = discrepancy(order.plannedVolume, actualVolume);
  order.status = overTolerance ? "待复核" : "已完工";
  order.reasons = overTolerance
    ? [
        `短溢 ${diff > 0 ? "+" : ""}${diff}L，超 ${SHORTAGE_TOLERANCE_L}L 容差，待复核`,
      ]
    : [];
  persist();
  return true;
}

/** 复核归档：解除站点排新单锁定，并尝试让被锁挡住的候单补位 */
export function reviewOrder(orderId: string): void {
  const order = unloadState.orders.find((item) => item.id === orderId);
  if (!order || !canReview(order)) return;
  order.status = "已完工";
  order.reasons = [...order.reasons, "短溢已复核归档"];
  promoteWaiting();
  persist();
}

export function removeOrder(orderId: string): void {
  const order = unloadState.orders.find((item) => item.id === orderId);
  if (!order || !canRemove(order)) return;
  unloadState.orders = unloadState.orders.filter((item) => item.id !== orderId);
  persist();
}

export { availableCapacity, hasActiveJob };
