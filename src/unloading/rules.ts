/**
 * 卸油互锁台 · 规则层
 * 纯函数与领域常量，不依赖 Vue / 浏览器 API，可独立测试。
 *
 * 互锁口径：
 * - 登记时逐项校验，任一硬规则（罐容不足 / 油品不符 / 站点尚在营业 /
 *   待复核锁定 / 参数非法）不满足即整单拒绝，排期、库存、站点状态不变；
 * - 仅因时段重叠无法排期的单不占用资源，转入候单，取消释放罐位后按提交顺序补位；
 * - 完工短溢超过容差进入待复核，复核前该站不得再排新单。
 */

export const SHORTAGE_TOLERANCE_L = 50;

export const PRODUCTS = ["92#汽油", "95#汽油", "0#柴油"] as const;

export const ORDER_STATUSES = [
  "已排期",
  "候单中",
  "卸油中",
  "待复核",
  "已完工",
  "已取消",
  "已拒绝",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATION_OPERATING = "营业中";
export const STATION_PAUSED = "暂停营业";

export interface Tank {
  id: string;
  stationId: string;
  name: string;
  product: string;
  capacity: number; // 罐容 L
  stock: number; // 当前库存 L
}

/** 站点状态由油站页持有，互锁台只依赖这个最小结构 */
export interface StationLike {
  id: string;
  station: string;
  status: string;
  stock: number;
}

export interface UnloadingOrder {
  id: string;
  seq: number; // 提交顺序号，候单补位按此升序
  stationId: string;
  tankId: string;
  product: string;
  plannedVolume: number; // 来油体积 L
  actualVolume: number | null; // 实收体积 L，完工时回填
  slotStart: string; // 计划时段起（ISO）
  slotEnd: string; // 计划时段止（ISO）
  escort: string; // 押运员
  status: OrderStatus;
  reasons: string[]; // 拒绝原因 / 过程备注
  prevStationStatus: string | null; // 开工前的站点状态，完工恢复
  createdAt: string;
}

export interface RegistrationInput {
  tankId: string;
  product: string;
  plannedVolume: number;
  slotStart: string;
  slotEnd: string;
  escort: string;
}

export interface RuleContext {
  tank: Tank | undefined;
  station: StationLike | undefined;
  orders: UnloadingOrder[];
}

/** 只有这两种状态真正锁定油罐与时段 */
const BOOKING_STATUSES: readonly OrderStatus[] = ["已排期", "卸油中"];

export function isBooking(order: UnloadingOrder): boolean {
  return BOOKING_STATUSES.includes(order.status);
}

export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function availableCapacity(tank: Tank): number {
  return Math.max(0, tank.capacity - tank.stock);
}

export function isOperating(station: StationLike): boolean {
  return station.status === STATION_OPERATING;
}

/** 站点存在未复核的短溢单时，不得再排新单 */
export function hasPendingReview(
  orders: UnloadingOrder[],
  stationId: string
): boolean {
  return orders.some(
    (order) => order.stationId === stationId && order.status === "待复核"
  );
}

export function overlappingOrders(
  orders: UnloadingOrder[],
  tankId: string,
  slotStart: string,
  slotEnd: string,
  excludeId?: string
): UnloadingOrder[] {
  const start = Date.parse(slotStart);
  const end = Date.parse(slotEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) return [];
  return orders.filter(
    (order) =>
      order.id !== excludeId &&
      order.tankId === tankId &&
      isBooking(order) &&
      intervalsOverlap(start, end, Date.parse(order.slotStart), Date.parse(order.slotEnd))
  );
}

export const REASON_OVERLAP = "时段重叠";

/**
 * 登记校验：返回全部不满足的原因，空数组表示可排期。
 * 候单补位时复用同一套校验，保证口径一致。
 */
export function validateRegistration(
  input: RegistrationInput,
  ctx: RuleContext
): string[] {
  const reasons: string[] = [];

  const start = Date.parse(input.slotStart);
  const end = Date.parse(input.slotEnd);
  const slotValid =
    !Number.isNaN(start) && !Number.isNaN(end) && start < end;
  if (!slotValid) reasons.push("计划时段无效");

  if (!Number.isFinite(input.plannedVolume) || input.plannedVolume <= 0) {
    reasons.push("来油体积必须大于 0");
  }
  if (!input.escort.trim()) reasons.push("押运员必填");

  if (!ctx.tank) {
    reasons.push("油罐不存在");
    return reasons;
  }
  if (!ctx.station) {
    reasons.push("油站不存在");
    return reasons;
  }

  if (ctx.tank.product !== input.product) {
    reasons.push(`油品不符：${ctx.tank.name} 为 ${ctx.tank.product}`);
  }
  const free = availableCapacity(ctx.tank);
  if (free < input.plannedVolume) {
    reasons.push(`罐容不足：${ctx.tank.name} 余量 ${free}L`);
  }
  if (isOperating(ctx.station)) reasons.push("站点尚在营业");
  if (hasPendingReview(ctx.orders, ctx.station.id)) {
    reasons.push("存在待复核短溢单，不得再排新单");
  }
  if (slotValid) {
    const clashes = overlappingOrders(
      ctx.orders,
      ctx.tank.id,
      input.slotStart,
      input.slotEnd
    );
    if (clashes.length > 0) {
      reasons.push(`${REASON_OVERLAP}：与 ${clashes.length} 张在排单冲突`);
    }
  }
  return reasons;
}

/** 仅因时段重叠被挡下的单可转入候单，其余原因一律整单拒绝 */
export function isOverlapOnly(reasons: string[]): boolean {
  return (
    reasons.length > 0 &&
    reasons.every((reason) => reason.startsWith(REASON_OVERLAP))
  );
}

export function canCancel(order: UnloadingOrder): boolean {
  return order.status === "已排期" || order.status === "候单中";
}

/** 同站同时只允许一张卸油作业 */
export function hasActiveJob(
  orders: UnloadingOrder[],
  stationId: string
): boolean {
  return orders.some(
    (order) => order.stationId === stationId && order.status === "卸油中"
  );
}

export function canStart(
  order: UnloadingOrder,
  orders: UnloadingOrder[]
): boolean {
  return order.status === "已排期" && !hasActiveJob(orders, order.stationId);
}

export function canComplete(order: UnloadingOrder): boolean {
  return order.status === "卸油中";
}

export function canReview(order: UnloadingOrder): boolean {
  return order.status === "待复核";
}

export function canRemove(order: UnloadingOrder): boolean {
  return order.status === "已完工" || order.status === "已取消" || order.status === "已拒绝";
}

/** 短溢判定：实收与来油之差绝对值超过容差即待复核 */
export function discrepancy(planned: number, actual: number) {
  const diff = actual - planned;
  return { diff, overTolerance: Math.abs(diff) > SHORTAGE_TOLERANCE_L };
}
