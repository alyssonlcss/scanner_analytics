import type { CsvRow } from '../csv-utils.js';
import type { KpiInsight, KpiRankItem, KpiTeamScore, DailyTrendPoint, PerTeamDailyPoint } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, round2, scoreKpi } from '../csv-utils.js';
import { KPI_DEDUP_BY_DATE, KPI_DIRECTIONS, KPI_ALIASES, KPI_THRESHOLDS, KPI_DESLOC_DAILY_CONFIG } from '../constants.js';
import { aggregateDailyTrends, TrendInput } from './trend-aggregator.js';

export function buildKpiInsights(rows: CsvRow[]): KpiInsight[] {
    if (rows.length === 0) {
      return [];
    }

    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe', 'Team', 'Equipe Nome']);
    if (!teamCol) {
      return [];
    }
    const dateCol = accessor.resolve(['Data Referência', 'Data Referencia']);

    const insights: KpiInsight[] = [];

    for (const [kpi, aliases] of Object.entries(KPI_ALIASES)) {
      const kpiCol = accessor.resolve(aliases);
      if (!kpiCol) {
        continue;
      }

      const teamTotals = new Map<string, { sum: number; count: number }>();
      const dedupByDate = KPI_DEDUP_BY_DATE.has(kpi);
      const seenTeamDate = dedupByDate ? new Set<string>() : null;

      for (const row of rows) {
        const team = String(row[teamCol] ?? '').trim();
        const value = parseNumber(String(row[kpiCol] ?? ''));

        if (!team || value === null || !Number.isFinite(value)) {
          continue;
        }

        if (seenTeamDate !== null && dateCol) {
          const date = String(row[dateCol] ?? '').trim();
          const key = `${team}|${date}`;
          if (seenTeamDate.has(key)) continue;
          seenTeamDate.add(key);
        }

        const current = teamTotals.get(team) ?? { sum: 0, count: 0 };
        current.sum += value;
        current.count += 1;
        teamTotals.set(team, current);
      }

      const values: KpiRankItem[] = Array.from(teamTotals.entries())
        .map(([team, totals]) => ({
          team,
          value: totals.sum / Math.max(totals.count, 1),
        }))
        .filter((item) => Number.isFinite(item.value));

      if (values.length === 0) {
        continue;
      }

      const direction = KPI_DIRECTIONS[kpi] ?? 'higher-is-better';
      const threshold = KPI_THRESHOLDS.find((t) => normalizeToken(t.kpi) === normalizeToken(kpi));
      const sorted = [...values].sort((a, b) => direction === 'higher-is-better' ? b.value - a.value : a.value - b.value);

      const scores: KpiTeamScore[] = values.map((item) => ({
        team: item.team,
        rawValue: round2(item.value),
        score: threshold ? round2(scoreKpi(item.value, threshold)) : round2(item.value),
      })).sort((a, b) => b.score - a.score);

      const average = round2(values.reduce((sum, item) => sum + item.value, 0) / Math.max(values.length, 1));

      const failingTeams = threshold
        ? sorted.filter((item) =>
            direction === 'higher-is-better' ? item.value < threshold.meta : item.value > threshold.meta,
          )
        : [];

      insights.push({
        kpi,
        direction,
        topTeams: sorted.slice(0, 3).map((item) => ({ ...item, value: round2(item.value) })),
        opportunityTeams: failingTeams.slice(-3).reverse().map((item) => ({ ...item, value: round2(item.value) })),
        scores,
        average,
        metaTarget: threshold?.meta ?? 0,
        chartConfig: threshold ? {
          worst: threshold.worst,
          best: threshold.best,
          direction: threshold.direction === 'higher-is-better' ? 'h' : 'l',
          meta: threshold.meta,
        } : undefined,
      });
    }

    return insights;
  }

  /**
   * Computes a per-day global average for a KPI by reading the Tab_Completa-Deslocamentos CSV.
   * Groups rows by date then by team (first row per team-day wins for team-level aggregate columns),
   * computes the KPI value per team-day, then averages across teams.
   */
export function buildKpiDailyTrend(
    deslocRows: CsvRow[],
    kpiName: string,
    resolvedTeams?: Map<string, { base: string; teamType: 'propria' | 'parceira' }>
  ): { globalTrend: DailyTrendPoint[]; trendByBase: Array<{ base: string; teamType: string; trend: DailyTrendPoint[] }> } {
    if (deslocRows.length === 0) return { globalTrend: [], trendByBase: [] };

    const config = KPI_DESLOC_DAILY_CONFIG[kpiName];
    if (!config) return { globalTrend: [], trendByBase: [] };

    const acc = createAccessor(deslocRows[0]);
    const teamCol  = acc.resolve(['Equipe']);
    const dateCol  = acc.resolve(['Data Referência', 'Data Referencia']);

    if (!teamCol || !dateCol) return { globalTrend: [], trendByBase: [] };

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d  = parseInt(parts[0] ?? '0',  10);
      const m  = parseInt(parts[1] ?? '1',  10);
      const y  = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // ── countBy mode: count distinct values of a column per team per date ────
    if (config.countBy && config.countBy.length > 0) {
      const countByCol = acc.resolve(config.countBy);
      if (!countByCol) return { globalTrend: [], trendByBase: [] };

      // date → team → Set of distinct countBy values
      const dateTeamSets = new Map<string, Map<string, Set<string>>>();
      for (const row of deslocRows) {
        const date  = String(row[dateCol] ?? '').trim();
        const team  = String(row[teamCol] ?? '').trim();
        const value = String(row[countByCol] ?? '').trim();
        if (!date || !team || !value) continue;
        const teamMap = dateTeamSets.get(date) ?? new Map<string, Set<string>>();
        const teamSet = teamMap.get(team) ?? new Set<string>();
        teamSet.add(value);
        teamMap.set(team, teamSet);
        dateTeamSets.set(date, teamMap);
      }

      const sortedDates = [...dateTeamSets.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const inputs: TrendInput[] = [];

      for (const fullDate of sortedDates) {
        const teamMap = dateTeamSets.get(fullDate)!;
        for (const [team, teamSet] of teamMap.entries()) {
          inputs.push({ fullDate, team, value: teamSet.size });
        }
      }

      return aggregateDailyTrends(inputs, resolvedTeams);
    }

    // ── value mode: read a numeric column per team per date ──────────────────
    const valueCol  = acc.resolve(config.aliases);
    const value2Col = config.aliases2 ? acc.resolve(config.aliases2) : null;

    if (!valueCol) return { globalTrend: [], trendByBase: [] };
    if (config.aliases2 && !value2Col) return { globalTrend: [], trendByBase: [] };

    if (config.aliases2 && value2Col) {
      if (config.dedup) {
        // Dedup-ratio mode: HT/HD are fixed per (date, team) — take the first row per team-day
        // then compute ratio from that single pair of values.
        const dateTeamMap = new Map<string, Map<string, CsvRow>>();
        for (const row of deslocRows) {
          const date = String(row[dateCol] ?? '').trim();
          const team = String(row[teamCol] ?? '').trim();
          if (!date || !team) continue;
          const teamMap = dateTeamMap.get(date) ?? new Map<string, CsvRow>();
          if (!teamMap.has(team)) teamMap.set(team, row);
          dateTeamMap.set(date, teamMap);
        }

        const sortedDates = [...dateTeamMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
        const inputs: TrendInput[] = [];

        for (const fullDate of sortedDates) {
          const teamMap = dateTeamMap.get(fullDate)!;
          for (const [team, row] of teamMap.entries()) {
            const num = parseNumber(String(row[valueCol] ?? ''));
            const den = parseNumber(String(row[value2Col] ?? ''));
            if (num !== null && den !== null && den > 0 && Number.isFinite(num) && Number.isFinite(den)) {
              inputs.push({ fullDate, team, value: (num / den) * (config.scale ?? 1) });
            }
          }
        }

        return aggregateDailyTrends(inputs, resolvedTeams);
      }

      // Ratio mode: sum(numerator) / sum(denominator) per (date, team), then average across teams per date.
      // This ensures correctness for row-level columns (e.g. tempo_padrao / TR Ordem) where values
      // must be accumulated across all orders before dividing.
      const dateTeamSums = new Map<string, Map<string, { sumNum: number; sumDen: number }>>();
      for (const row of deslocRows) {
        const date = String(row[dateCol] ?? '').trim();
        const team = String(row[teamCol] ?? '').trim();
        if (!date || !team) continue;
        const num = parseNumber(String(row[valueCol] ?? ''));
        const den = parseNumber(String(row[value2Col] ?? ''));
        if (num === null || den === null || !Number.isFinite(num) || !Number.isFinite(den)) continue;
        const teamMap = dateTeamSums.get(date) ?? new Map<string, { sumNum: number; sumDen: number }>();
        const current = teamMap.get(team) ?? { sumNum: 0, sumDen: 0 };
        current.sumNum += num;
        current.sumDen += den;
        teamMap.set(team, current);
        dateTeamSums.set(date, teamMap);
      }

      const sortedDates = [...dateTeamSums.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const inputs: TrendInput[] = [];

      for (const fullDate of sortedDates) {
        const teamMap = dateTeamSums.get(fullDate)!;
        for (const [team, { sumNum, sumDen }] of teamMap.entries()) {
          if (sumDen > 0 && Number.isFinite(sumNum) && Number.isFinite(sumDen)) {
            inputs.push({ fullDate, team, value: (sumNum / sumDen) * (config.scale ?? 1) });
          }
        }
      }

      return aggregateDailyTrends(inputs, resolvedTeams);
    }

    // Single-column mode: first row per team-day (deduplication — column is a jornada-level value)
    const dateTeamMap = new Map<string, Map<string, CsvRow>>();
    for (const row of deslocRows) {
      const date = String(row[dateCol] ?? '').trim();
      const team = String(row[teamCol] ?? '').trim();
      if (!date || !team) continue;
      const teamMap = dateTeamMap.get(date) ?? new Map<string, CsvRow>();
      if (!teamMap.has(team)) teamMap.set(team, row);
      dateTeamMap.set(date, teamMap);
    }

    const sortedDates = [...dateTeamMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
    const inputs: TrendInput[] = [];

    for (const fullDate of sortedDates) {
      const teamMap = dateTeamMap.get(fullDate)!;

      for (const [team, row] of teamMap.entries()) {
        const v = parseNumber(String(row[valueCol] ?? ''));
        if (v !== null && Number.isFinite(v) && v >= 0) {
          inputs.push({ fullDate, team, value: config.scale ? v * config.scale : v });
        }
      }
    }

    return aggregateDailyTrends(inputs, resolvedTeams);
  }

  /**
   * Computes per-team daily values for a jornada-level column (one value per team × Data Referência).
   * Deduplicates by (team, date) taking the first row, then reads the numeric value.
   * Used for KPIs like 1º Login Corrigido, 1º Desloc, Retorno Base that repeat the same
   * number across all OS rows of the same day.
   */
export function buildPerTeamDailyValue(
    deslocRows: CsvRow[],
    candidates: string[],
  ): Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> {
    if (deslocRows.length === 0) return [];

    const acc = createAccessor(deslocRows[0]);
    const teamCol  = acc.resolve(['Equipe']);
    const dateCol  = acc.resolve(['Data Referência', 'Data Referencia']);
    const valueCol = acc.resolve(candidates);

    if (!teamCol || !dateCol || !valueCol) return [];

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d = parseInt(parts[0] ?? '0', 10);
      const m = parseInt(parts[1] ?? '1', 10);
      const y = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // team → date (dd/mm/yyyy) → first-row value (dedup: jornada-level, same for all OS of the day)
    const teamDateMap = new Map<string, Map<string, number>>();
    for (const row of deslocRows) {
      const date  = String(row[dateCol] ?? '').trim();
      const team  = String(row[teamCol] ?? '').trim();
      if (!date || !team) continue;
      const dateMap = teamDateMap.get(team) ?? new Map<string, number>();
      if (!dateMap.has(date)) {
        const v = parseNumber(String(row[valueCol] ?? ''));
        if (v !== null && Number.isFinite(v) && v >= 0) dateMap.set(date, v);
      }
      teamDateMap.set(team, dateMap);
    }

    const result: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> = [];

    for (const [team, dateMap] of teamDateMap) {
      if (dateMap.size === 0) continue;
      const sortedDates = [...dateMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const dailyPoints: PerTeamDailyPoint[] = sortedDates.map((fullDate) => ({
        date: `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`,
        value: round2(dateMap.get(fullDate)!),
      }));
      result.push({ team, dailyPoints });
    }

    result.sort((a, b) => a.team.localeCompare(b.team, 'pt-BR'));
    return result;
  }

  /**
   * Computes sum(numerator) / sum(denominator) per team per reference date.
   * Returns one entry per team with a chronologically sorted array of { date (dd/mm), value }.
   * Used to populate `perTeamDailyData` for ratio KPIs (e.g. Eficiência = sum(tempo_padrao)/sum(TR Ordem)*100)
   * so the analytic chart draws each team's actual value varying per date.
   */
export function buildPerTeamDailyRatio(
    deslocRows: CsvRow[],
    numCandidates: string[],
    denCandidates: string[],
    scale = 1,
  ): Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> {
    if (deslocRows.length === 0) return [];

    const acc = createAccessor(deslocRows[0]);
    const teamCol = acc.resolve(['Equipe']);
    const dateCol = acc.resolve(['Data Referência', 'Data Referencia']);
    const numCol  = acc.resolve(numCandidates);
    const denCol  = acc.resolve(denCandidates);

    if (!teamCol || !dateCol || !numCol || !denCol) return [];

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d = parseInt(parts[0] ?? '0', 10);
      const m = parseInt(parts[1] ?? '1', 10);
      const y = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // team → date (dd/mm/yyyy) → { sumNum, sumDen }
    const teamDateSums = new Map<string, Map<string, { sumNum: number; sumDen: number }>>();
    for (const row of deslocRows) {
      const date = String(row[dateCol] ?? '').trim();
      const team = String(row[teamCol] ?? '').trim();
      if (!date || !team) continue;
      const num = parseNumber(String(row[numCol] ?? ''));
      const den = parseNumber(String(row[denCol] ?? ''));
      if (num === null || den === null || !Number.isFinite(num) || !Number.isFinite(den)) continue;
      const dateMap = teamDateSums.get(team) ?? new Map<string, { sumNum: number; sumDen: number }>();
      const current = dateMap.get(date) ?? { sumNum: 0, sumDen: 0 };
      current.sumNum += num;
      current.sumDen += den;
      dateMap.set(date, current);
      teamDateSums.set(team, dateMap);
    }

    const result: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> = [];

    for (const [team, dateMap] of teamDateSums) {
      const sortedDates = [...dateMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const dailyPoints: PerTeamDailyPoint[] = [];
      for (const fullDate of sortedDates) {
        const { sumNum, sumDen } = dateMap.get(fullDate)!;
        if (sumDen > 0) {
          dailyPoints.push({
            date: `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`,
            value: round2((sumNum / sumDen) * scale),
          });
        }
      }
      if (dailyPoints.length > 0) result.push({ team, dailyPoints });
    }

    result.sort((a, b) => a.team.localeCompare(b.team, 'pt-BR'));
    return result;
  }

  /**
   * Counts distinct values of `countByCandidates` column per team per date.
   * Returns one entry per team with a chronologically sorted array of { date (dd/mm), value (count) }.
   * Used to populate `perTeamDailyData` for OS Dia so the analytic chart can draw non-flat team lines.
   */
export function buildPerTeamDailyCount(
    deslocRows: CsvRow[],
    countByCandidates: string[],
  ): Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> {
    if (deslocRows.length === 0) return [];

    const acc = createAccessor(deslocRows[0]);
    const teamCol   = acc.resolve(['Equipe']);
    const dateCol   = acc.resolve(['Data Referência', 'Data Referencia']);
    const countByCol = acc.resolve(countByCandidates);

    if (!teamCol || !dateCol || !countByCol) return [];

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d = parseInt(parts[0] ?? '0', 10);
      const m = parseInt(parts[1] ?? '1', 10);
      const y = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // team → date (dd/mm/yyyy) → Set<countByValue>
    const teamDateSets = new Map<string, Map<string, Set<string>>>();
    for (const row of deslocRows) {
      const date  = String(row[dateCol] ?? '').trim();
      const team  = String(row[teamCol] ?? '').trim();
      const value = String(row[countByCol] ?? '').trim();
      if (!date || !team || !value) continue;
      const dateMap = teamDateSets.get(team) ?? new Map<string, Set<string>>();
      const dateSet = dateMap.get(date) ?? new Set<string>();
      dateSet.add(value);
      dateMap.set(date, dateSet);
      teamDateSets.set(team, dateMap);
    }

    const result: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> = [];

    for (const [team, dateMap] of teamDateSets) {
      const sortedDates = [...dateMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const dailyPoints: PerTeamDailyPoint[] = sortedDates.map((fullDate) => ({
        date: `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`,
        value: dateMap.get(fullDate)!.size,
      }));
      result.push({ team, dailyPoints });
    }

    // Sort teams alphabetically for deterministic output
    result.sort((a, b) => a.team.localeCompare(b.team, 'pt-BR'));
    return result;
  }

  /**
   * Computes per-team daily TME IMP values:
   *   value(team, date) = avg(TR Ordem) for rows where status == "Improdutivo" AND TR Ordem > 20.
   * Only teams that have at least one qualifying row on any day are included.
   * Days where the team has no qualifying rows receive value = 0.
   * Also returns a global daily trend (avg across qualifying teams per date, ignoring 0s).
   */
export function buildPerTeamDailyTmeImp(
    deslocRows: CsvRow[],
    resolvedTeams?: Map<string, { base: string; teamType: 'propria' | 'parceira' }>
  ): {
    perTeam: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }>;
    globalTrend: DailyTrendPoint[];
    trendByBase: Array<{ base: string; teamType: string; trend: DailyTrendPoint[] }>;
  } {
    if (deslocRows.length === 0) return { perTeam: [], globalTrend: [], trendByBase: [] };

    const acc = createAccessor(deslocRows[0]);
    const teamCol   = acc.resolve(['Equipe']);
    const dateCol   = acc.resolve(['Data Referência', 'Data Referencia']);
    const statusCol = acc.resolve(['status', 'Status']);
    const trCol     = acc.resolve(['TR Ordem', 'TR_Ordem']);

    if (!teamCol || !dateCol || !statusCol || !trCol) return { perTeam: [], globalTrend: [], trendByBase: [] };

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d = parseInt(parts[0] ?? '0', 10);
      const m = parseInt(parts[1] ?? '1', 10);
      const y = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // Collect all dates each team appears on (to fill in 0s for days without Improdutivo)
    const teamAllDates = new Map<string, Set<string>>();
    // Qualifying rows: team → date → [TR Ordem values]
    const teamDateTrs  = new Map<string, Map<string, number[]>>();

    for (const row of deslocRows) {
      const date   = String(row[dateCol]   ?? '').trim();
      const team   = String(row[teamCol]   ?? '').trim();
      const status = String(row[statusCol] ?? '').trim();
      const trRaw  = parseNumber(String(row[trCol] ?? ''));

      if (!date || !team) continue;

      const allDates = teamAllDates.get(team) ?? new Set<string>();
      allDates.add(date);
      teamAllDates.set(team, allDates);

      if (status === 'Improdutivo' && trRaw !== null && trRaw > 0) {
        const dateMap = teamDateTrs.get(team) ?? new Map<string, number[]>();
        const vals    = dateMap.get(date) ?? [];
        vals.push(trRaw);
        dateMap.set(date, vals);
        teamDateTrs.set(team, dateMap);
      }
    }

    // Build per-team result — only teams with at least one qualifying row
    const perTeam: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> = [];
    for (const [team, impDateMap] of teamDateTrs) {
      const allDates   = teamAllDates.get(team) ?? new Set<string>();
      const sortedDates = [...allDates].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const dailyPoints: PerTeamDailyPoint[] = sortedDates.map((fullDate) => {
        const vals  = impDateMap.get(fullDate);
        const value = vals && vals.length > 0
          ? round2(vals.reduce((s, v) => s + v, 0) / vals.length)
          : 0;
        return { date: `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`, value };
      });
      perTeam.push({ team, dailyPoints });
    }
    perTeam.sort((a, b) => a.team.localeCompare(b.team, 'pt-BR'));

    // Build trend aggregation using raw values before perTeam transformation to keep correct logic
    const inputs: TrendInput[] = [];
    for (const [team, impDateMap] of teamDateTrs) {
      for (const [fullDate, vals] of impDateMap) {
        const value = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
        if (value > 0) {
          inputs.push({ fullDate, team, value });
        }
      }
    }
    const { globalTrend, trendByBase } = aggregateDailyTrends(inputs, resolvedTeams);

    // Ensure every team has an entry for every globalTrend date.
    const trendDateSet = new Set(globalTrend.map((t) => t.date));
    for (const entry of perTeam) {
      const existing = new Set(entry.dailyPoints.map((p) => p.date));
      for (const ddMm of trendDateSet) {
        if (!existing.has(ddMm)) {
          entry.dailyPoints.push({ date: ddMm, value: 0 });
        }
      }
      // Re-sort chronologically after filling gaps
      entry.dailyPoints.sort((a, b) => {
        const [da, ma] = a.date.split('/').map(Number);
        const [db, mb] = b.date.split('/').map(Number);
        return (ma! * 100 + da!) - (mb! * 100 + db!);
      });
    }

    return { perTeam, globalTrend, trendByBase };
  }

