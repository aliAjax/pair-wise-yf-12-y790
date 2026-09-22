// 卸油互锁规则（纯函数层）：不依赖 Vue、localStorage，只负责判定能不能排期。

export const PRODUCTS = ["92#汽油", "95#汽油", "0#柴油"] as const;
export type Product = (typeof PRODUCTS)[number];

export const STATION_STATUSES = ["营业中", "暂停营业", "库存紧张"] as const;
export type StationStatus = (typeof STATION_STATUSES)[number];

export const ORDER_STATUSES = [
  "候单中",
  "已排期",
  "作业中",
  "待复核",
  "已完工",
  "已取消",
  "已拒绝"
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// 短溢（实收与来油计划之差）允许的最大升数，超过进入待复核。
export const REVIEW_TOLERANCE_LITERS = 50;

// 占用油罐时段的单据状态：候单不占罐，完工/取消/拒绝/待复核均已释放罐位。
export const TANK_OCCUPYING: readonly OrderStatus[] = ["已排期", "作业中"];

export interface Station {
  id: string;
  name: string;
  area: string;
  manager: string;
  status: StationStatus;
}

export interface Tank {
  id: string;
  stationId: string;
  code: string;
  product: Product;
  capacity: number;
  stock: number;
}

export interface OrderDraftData {
  stationId: string;
  tankId: string;
  product: Product;
  incomingVolume: number; // 来油体积（计划接卸升数）
  startAt: string; // ISO 时间
  endAt: string;
  escort: string; // 押运员
  notes: string;
}

export interface UnloadOrder extends OrderDraftData {
  id: string;
  code: string;
  seq: number; // 提交顺序，候单补位按此排序
  status: OrderStatus;
  createdAt: string;
  scheduledAt?: string;
  startedAt?: string;
  finishedAt?: string;
  prevStationStatus?: StationStatus; // 开工前站点原状态，完工恢复用
  receivedVolume?: number; // 实收体积
  variance?: number; // 实收 - 来油计划
  reasons: string[]; // 拒绝原因或候单等待原因
}

export interface InterlockContext {
  stations: readonly Station[];
  tanks: readonly Tank[];
  orders: readonly UnloadOrder[];
}

export interface InterlockResult {
  ok: boolean; // 无任何互锁冲突，可直接锁定排期
  hardViolations: string[]; // 罐容/油品/营业状态等硬性冲突：整单拒绝
  overlapOrders: UnloadOrder[]; // 时段重叠的在罐单据：可进候单
}

/** ISO 时段半开区间判定：一端相等不算重叠（整点交接允许）。 */
export function windowsOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string
): boolean {
  return startA < endB && startB < endA;
}

export function needsReview(receivedVolume: number, incomingVolume: number): boolean {
  return Math.abs(receivedVolume - incomingVolume) > REVIEW_TOLERANCE_LITERS;
}

/** 同罐已排期/作业中单据占用的罐容：当前库存 + 各单计划来油体积之和。 */
export function reservedStock(
  tankId: string,
  orders: readonly UnloadOrder[],
  excludeOrderId?: string
): number {
  const occupying = orders.filter(
    (order) =>
      order.id !== excludeOrderId &&
      order.tankId === tankId &&
      TANK_OCCUPYING.includes(order.status)
  );
  return occupying.reduce((sum, order) => sum + order.incomingVolume, 0);
}

function formatWindow(order: UnloadOrder): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return `${fmt(order.startAt)}~${fmt(order.endAt)}`;
}

/**
 * 互锁校验。返回硬性违规（整单拒绝，原排期/库存/站点状态不变）与时段重叠（进候单）两类。
 * excludeOrderId 用于候单补位时排除被提升单据自身。
 */
export function evaluateInterlock(
  data: OrderDraftData,
  ctx: InterlockContext,
  excludeOrderId?: string
): InterlockResult {
  const hardViolations: string[] = [];
  const overlapOrders: UnloadOrder[] = [];

  const station = ctx.stations.find((item) => item.id === data.stationId);
  const tank = ctx.tanks.find((item) => item.id === data.tankId);

  if (!station) hardViolations.push("所选站点不存在");
  if (!tank) hardViolations.push("所选油罐不存在");
  if (station && tank && tank.stationId !== station.id) {
    hardViolations.push(`油罐 ${tank.code} 不属于站点 ${station.name}`);
  }
  if (!(Number.isFinite(data.incomingVolume) && data.incomingVolume > 0)) {
    hardViolations.push("来油体积必须为大于 0 的升数");
  }
  if (!data.startAt || !data.endAt || !(data.endAt > data.startAt)) {
    hardViolations.push("计划时段无效：结束时间必须晚于开始时间");
  }

  if (station && tank) {
    if (tank.product !== data.product) {
      hardViolations.push(
        `油品不符：${tank.code} 仅可接卸 ${tank.product}，本单油品为 ${data.product}`
      );
    }

    const reviewing = ctx.orders.some(
      (order) => order.stationId === station.id && order.status === "待复核"
    );
    if (reviewing) {
      hardViolations.push("站点存在待复核单据，短溢处理完成前不得再排新单");
    }

    if (station.status === "营业中") {
      hardViolations.push(`站点 ${station.name} 尚在营业，须先转为暂停营业后方可排期`);
    }

    const planned = reservedStock(tank.id, ctx.orders, excludeOrderId);
    const projected = tank.stock + planned + data.incomingVolume;
    if (projected > tank.capacity) {
      hardViolations.push(
        `罐容不足：${tank.code} 当前库存 ${tank.stock}L、已排期预留 ${planned}L，再接卸 ${data.incomingVolume}L 将达到 ${projected}L，超过罐容 ${tank.capacity}L`
      );
    }

    for (const order of ctx.orders) {
      if (order.id === excludeOrderId) continue;
      if (order.tankId !== tank.id || !TANK_OCCUPYING.includes(order.status)) continue;
      if (windowsOverlap(data.startAt, data.endAt, order.startAt, order.endAt)) {
        overlapOrders.push(order);
      }
    }
  }

  return {
    ok: hardViolations.length === 0 && overlapOrders.length === 0,
    hardViolations,
    overlapOrders
  };
}

export function overlapReasons(orders: readonly UnloadOrder[]): string[] {
  return orders.map(
    (order) => `时段重叠：与 ${order.code}（${formatWindow(order)}）争抢同一油罐`
  );
}
