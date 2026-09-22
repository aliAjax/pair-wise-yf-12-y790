// 卸油互锁台持久化层：只负责 localStorage 的读写与初始种子数据，不含业务判定。

import type { Station, Tank, UnloadOrder } from "./rules";

const STORAGE_KEY = "hxwlfront-21-unload-interlock";
const STORAGE_VERSION = 1;

export interface PersistedState {
  version: number;
  seq: number;
  stations: Station[];
  tanks: Tank[];
  orders: UnloadOrder[];
}

function isoAt(daysFromNow: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

export function createSeedState(): PersistedState {
  const stations: Station[] = [
    { id: "st-east", name: "东区一站", area: "东区", manager: "刘站长", status: "营业中" },
    { id: "st-airport", name: "机场快线站", area: "机场线", manager: "王站长", status: "库存紧张" },
    { id: "st-west", name: "西区二站", area: "西区", manager: "赵站长", status: "暂停营业" }
  ];

  const tanks: Tank[] = [
    { id: "tk-e-92", stationId: "st-east", code: "东区1#罐", product: "92#汽油", capacity: 40000, stock: 36000 },
    { id: "tk-e-95", stationId: "st-east", code: "东区2#罐", product: "95#汽油", capacity: 30000, stock: 12000 },
    { id: "tk-a-0", stationId: "st-airport", code: "机场1#罐", product: "0#柴油", capacity: 25000, stock: 9000 },
    { id: "tk-a-92", stationId: "st-airport", code: "机场2#罐", product: "92#汽油", capacity: 20000, stock: 15500 },
    { id: "tk-w-0", stationId: "st-west", code: "西区1#罐", product: "0#柴油", capacity: 30000, stock: 8000 }
  ];

  // 种子排期：西区二站已暂停营业，明日上午 09:00-11:00 已占用西区1#罐。
  const orders: UnloadOrder[] = [
    {
      id: "seed-order-1",
      code: "XY-DEMO-001",
      seq: 1,
      stationId: "st-west",
      tankId: "tk-w-0",
      product: "0#柴油",
      incomingVolume: 10000,
      startAt: isoAt(1, 9),
      endAt: isoAt(1, 11),
      escort: "孙押运",
      notes: "夜间补库排期示例",
      status: "已排期",
      createdAt: isoAt(-2, 10),
      scheduledAt: isoAt(-2, 10),
      reasons: []
    }
  ];

  return { version: STORAGE_VERSION, seq: 1, stations, tanks, orders };
}

export function loadState(): PersistedState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createSeedState();
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (
      parsed.version !== STORAGE_VERSION ||
      !Array.isArray(parsed.stations) ||
      !Array.isArray(parsed.tanks) ||
      !Array.isArray(parsed.orders)
    ) {
      return createSeedState();
    }
    return {
      version: STORAGE_VERSION,
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
      stations: parsed.stations ?? [],
      tanks: parsed.tanks ?? [],
      orders: parsed.orders ?? []
    };
  } catch {
    return createSeedState();
  }
}

export function saveState(state: PersistedState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetState(): PersistedState {
  const seed = createSeedState();
  saveState(seed);
  return seed;
}
