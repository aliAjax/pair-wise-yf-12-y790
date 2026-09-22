/**
 * 卸油互锁台 · 持久化层
 * localStorage 读写与种子数据，无后端、无新增依赖。
 */

import type { Tank, UnloadingOrder } from "./rules";

export const UNLOADING_STORAGE_KEY = "hxwlfront-21-unloading";

export interface UnloadingSnapshot {
  version: 1;
  seq: number; // 已发放的提交顺序号
  tanks: Tank[];
  orders: UnloadingOrder[];
}

interface StationSeedRef {
  id: string;
  station: string;
}

/**
 * 种子油罐按油站名称挂靠到现有站点，库存合计与站点库存摘要一致。
 * 站点被删除时对应油罐不再生成，新增站点默认无油罐、不可登记。
 */
const SEED_TANKS: ReadonlyArray<{
  stationName: string;
  tanks: ReadonlyArray<Omit<Tank, "id" | "stationId">>;
}> = [
  {
    stationName: "东区一站",
    tanks: [
      { name: "1号罐", product: "92#汽油", capacity: 30000, stock: 18000 },
      { name: "2号罐", product: "95#汽油", capacity: 20000, stock: 12000 },
      { name: "3号罐", product: "0#柴油", capacity: 15000, stock: 6000 },
    ],
  },
  {
    stationName: "机场快线站",
    tanks: [
      { name: "1号罐", product: "95#汽油", capacity: 20000, stock: 5000 },
      { name: "2号罐", product: "0#柴油", capacity: 15000, stock: 4000 },
    ],
  },
];

export function seedTanks(stations: StationSeedRef[]): Tank[] {
  return SEED_TANKS.flatMap((group) => {
    const station = stations.find((item) => item.station === group.stationName);
    if (!station) return [];
    return group.tanks.map((tank, index) => ({
      ...tank,
      id: `tank-${station.id}-${index + 1}`,
      stationId: station.id,
    }));
  });
}

function blankSnapshot(stations: StationSeedRef[]): UnloadingSnapshot {
  return { version: 1, seq: 0, tanks: seedTanks(stations), orders: [] };
}

function normalize(raw: unknown, stations: StationSeedRef[]): UnloadingSnapshot {
  const fallback = blankSnapshot(stations);
  if (!raw || typeof raw !== "object") return fallback;
  const snapshot = raw as Partial<UnloadingSnapshot>;
  if (snapshot.version !== 1) return fallback;
  return {
    version: 1,
    seq: typeof snapshot.seq === "number" ? snapshot.seq : 0,
    tanks: Array.isArray(snapshot.tanks) ? snapshot.tanks : fallback.tanks,
    orders: Array.isArray(snapshot.orders) ? snapshot.orders : [],
  };
}

export function loadUnloading(stations: StationSeedRef[]): UnloadingSnapshot {
  try {
    const raw = localStorage.getItem(UNLOADING_STORAGE_KEY);
    if (!raw) return blankSnapshot(stations);
    return normalize(JSON.parse(raw), stations);
  } catch {
    return blankSnapshot(stations);
  }
}

export function saveUnloading(snapshot: UnloadingSnapshot): void {
  try {
    localStorage.setItem(UNLOADING_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 存储不可用（隐私模式等）时保持内存态，不阻断业务操作
  }
}
