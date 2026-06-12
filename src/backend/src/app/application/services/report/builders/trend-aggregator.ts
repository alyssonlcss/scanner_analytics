import { DailyTrendPoint } from '../types.js';
import { round2 } from '../csv-utils.js';

export interface TrendInput {
  fullDate: string; // "DD/MM/YYYY"
  team: string;
  value: number;
}

export function aggregateDailyTrends(
  inputs: TrendInput[],
  resolvedTeams?: Map<string, { base: string; teamType: 'propria' | 'parceira' }>
): {
  globalTrend: DailyTrendPoint[];
  trendByBase: Array<{ base: string; teamType: string; trend: DailyTrendPoint[] }>;
} {
  const parseFullDate = (s: string): number => {
    const parts = s.split('/');
    const d = parseInt(parts[0] ?? '0', 10);
    const m = parseInt(parts[1] ?? '1', 10);
    const y = parseInt(parts[2] ?? '2000', 10);
    return y * 10000 + m * 100 + d;
  };

  const toDdMm = (fullDate: string) => `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`;

  // Global aggregation
  const dateGlobalVals = new Map<string, number[]>();
  // Base aggregation: base|teamType -> date -> number[]
  const baseDateVals = new Map<string, Map<string, number[]>>();

  for (const { fullDate, team, value } of inputs) {
    // Global
    const gVals = dateGlobalVals.get(fullDate) ?? [];
    gVals.push(value);
    dateGlobalVals.set(fullDate, gVals);

    // By base
    if (resolvedTeams) {
      const res = resolvedTeams.get(team.toUpperCase().trim());
      if (res && res.base && res.teamType) {
        const pushToMap = (key: string) => {
          const dateMap = baseDateVals.get(key) ?? new Map<string, number[]>();
          const bVals = dateMap.get(fullDate) ?? [];
          bVals.push(value);
          dateMap.set(fullDate, bVals);
          baseDateVals.set(key, dateMap);
        };

        // Specific base + teamType
        pushToMap(`${res.base}|${res.teamType}`);
        // Specific base combined
        pushToMap(`${res.base}|All`);
        // Global combined by teamType
        pushToMap(`Média Global|${res.teamType}`);
        // Global combined totally
        pushToMap(`Média Global|All`);
      }
    }
  }

  const sortedDates = [...dateGlobalVals.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));

  const globalTrend: DailyTrendPoint[] = [];
  for (const fullDate of sortedDates) {
    const vals = dateGlobalVals.get(fullDate)!;
    if (vals.length > 0) {
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      globalTrend.push({ date: toDdMm(fullDate), avgValue: round2(avg) });
    }
  }

  const trendByBase: Array<{ base: string; teamType: string; trend: DailyTrendPoint[] }> = [];
  for (const [baseKey, dateMap] of baseDateVals.entries()) {
    const [base, teamType] = baseKey.split('|');
    const trend: DailyTrendPoint[] = [];
    
    // Fill all dates to maintain x-axis alignment
    for (const fullDate of sortedDates) {
      const vals = dateMap.get(fullDate) ?? [];
      const avg = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
      // Note: we can push 0 or null, but UI currently expects 0 for missing.
      trend.push({ date: toDdMm(fullDate), avgValue: round2(avg) });
    }
    trendByBase.push({ base: base!, teamType: teamType!, trend });
  }

  return { globalTrend, trendByBase };
}
