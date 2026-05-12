import type { CsvRow } from '../csv-utils.js';
import type { PrimeiroLoginTeamAnalysis, PrimeiroLoginDayEvidence, KpiInsight } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, round2, parseDateTimeBr, minutesBetween } from '../csv-utils.js';
import { enrichLoginEvidence } from './enrich-utils.js';
import { countDistinctDates } from './os-dia.analyzer.js';

export function analyzePrimeiroLogin(deslocRows: CsvRow[], kpis: KpiInsight[]): PrimeiroLoginTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const LOGIN_META = 8;

    const loginKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('1º Login'));
    if (!loginKpi) return [];

    const teamsToAnalyze = new Map<string, { value: number }>();
    for (const t of loginKpi.opportunityTeams) teamsToAnalyze.set(t.team, { value: t.value });
    if (teamsToAnalyze.size === 0) return [];

    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol            = deslocAcc.resolve(['Equipe']);
    const dateCol            = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const inicioCalCol       = deslocAcc.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
    const logInCorrigidoCol  = deslocAcc.resolve(['Log In Corrigido', 'LogIn Corrigido', 'Login Corrigido']);
    const primeiroLoginCorCol = deslocAcc.resolve(['1º Login Corrigido', '1o Login Corrigido']);
    const primeiroLoginCol   = deslocAcc.resolve(['1º Login', '1o Login']);

    // Resolves the login-delay in minutes for a given row.
    // Priority: pre-computed numeric column → time-difference fallback (Log In Corrigido − Inicio Calendário).
    const resolveLoginMin = (row: CsvRow): number | null => {
      if (primeiroLoginCorCol) {
        const v = parseNumber(String(row[primeiroLoginCorCol] ?? ''));
        if (v !== null && Number.isFinite(v)) return v;
      }
      if (primeiroLoginCol) {
        const v = parseNumber(String(row[primeiroLoginCol] ?? ''));
        if (v !== null && Number.isFinite(v)) return v;
      }
      // Fallback: compute from the login TIME minus the jornada start TIME.
      if (!inicioCalCol || !logInCorrigidoCol) return null;
      const dateRef   = dateCol ? String(row[dateCol] ?? '').trim() : '';
      const inicioCal = String(row[inicioCalCol] ?? '').trim();
      const logInCor  = String(row[logInCorrigidoCol] ?? '').trim();
      if (!inicioCal || !logInCor) return null;
      const mkDate = (t: string) => {
        if (t.includes('/')) return parseDateTimeBr(t);
        return parseDateTimeBr(dateRef ? `${dateRef} ${t}` : `01/01/2000 ${t}`);
      };
      const inicioDate = mkDate(inicioCal);
      const loginDate  = mkDate(logInCor);
      if (!inicioDate || !loginDate) return null;
      const diff = minutesBetween(loginDate, inicioDate);
      return Number.isFinite(diff) && diff >= 0 ? round2(diff) : 0;
    };

    if (!teamCol) return [];

    const distinctDates = dateCol ? countDistinctDates(deslocRows, dateCol) : 0;

    // Global: collect distinct jornada (team+date) first login values
    const globalLoginValues: number[] = [];
    const seenGlobal = new Set<string>();
    for (const row of deslocRows) {
      const team = teamCol ? String(row[teamCol] ?? '').trim() : '';
      const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
      const key = `${team}|${date}`;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      const loginMin = resolveLoginMin(row);
      if (loginMin !== null && Number.isFinite(loginMin) && loginMin >= 0) globalLoginValues.push(loginMin);
    }
    const globalAvgLogin = globalLoginValues.length > 0
      ? globalLoginValues.reduce((s, x) => s + x, 0) / globalLoginValues.length : 0;

    const result: PrimeiroLoginTeamAnalysis[] = [];

    for (const [team, { value: loginValue }] of teamsToAnalyze.entries()) {
      const teamNorm = normalizeToken(team);
      let teamRows = deslocRows.filter((r) => String(r[teamCol] ?? '').trim() === team);
      if (teamRows.length === 0) {
        teamRows = deslocRows.filter((r) => normalizeToken(String(r[teamCol] ?? '').trim()) === teamNorm);
      }
      if (teamRows.length === 0) continue;

      // Deduplicate by date (one row per day for jornada-level metrics)
      const seenDates = new Set<string>();
      const jornadaRows: CsvRow[] = [];
      for (const row of teamRows) {
        const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
        if (!seenDates.has(date)) { seenDates.add(date); jornadaRows.push(row); }
      }

      const teamLoginValues: number[] = [];
      for (const row of jornadaRows) {
        const v = resolveLoginMin(row);
        if (v !== null && Number.isFinite(v) && v >= 0) teamLoginValues.push(v);
      }
      const teamAvgLogin = teamLoginValues.length > 0
        ? teamLoginValues.reduce((s, x) => s + x, 0) / teamLoginValues.length : 0;

      const diasAcimaMetaCount = teamLoginValues.filter((v) => v > LOGIN_META).length;

      const flaggedDays: PrimeiroLoginDayEvidence[] = [];
      let countLoginTardio = 0;
      let countLoginMuitoTardio = 0;

      for (const row of jornadaRows) {
        const loginMin = resolveLoginMin(row);
        if (loginMin === null || !Number.isFinite(loginMin)) continue;

        const flags: PrimeiroLoginDayEvidence['flags'] = [];
        // login_muito_tardio: > meta * 2 (acima de 16 min)
        // login_tardio: > meta (acima de 8 min)
        if (loginMin > LOGIN_META * 2) { flags.push('login_muito_tardio'); countLoginMuitoTardio++; }
        else if (loginMin > LOGIN_META) { flags.push('login_tardio'); countLoginTardio++; }

        if (flags.length === 0) continue;

        flaggedDays.push({
          date_ref: dateCol ? String(row[dateCol] ?? '').trim() : '',
          inicio_calendario: inicioCalCol ? String(row[inicioCalCol] ?? '').trim() : '',
          log_in_corrigido:  logInCorrigidoCol ? String(row[logInCorrigidoCol] ?? '').trim() : '',
          primeiro_login_min: round2(loginMin),
          team_avg_login_min: round2(teamAvgLogin),
          global_avg_login_min: round2(globalAvgLogin),
          flags,
        });
      }

      flaggedDays.sort((a, b) => b.primeiro_login_min - a.primeiro_login_min);

      result.push({
        team,
        primeiroLoginValue: loginValue,
        metaTarget: LOGIN_META,
        gap: round2(loginValue - LOGIN_META),
        avgLoginMin: round2(teamAvgLogin),
        globalAvgLoginMin: round2(globalAvgLogin),
        totalDays: jornadaRows.length,
        diasAcimaMetaCount,
        flaggedDays: enrichLoginEvidence(
          distinctDates > 7 ? flaggedDays.slice(0, 10) : flaggedDays,
          LOGIN_META,
        ),
        summary: { countLoginTardio, countLoginMuitoTardio },
      });
    }

    return result.sort((a, b) => b.primeiroLoginValue - a.primeiroLoginValue);
  }

  // ─── 1º Desloc. Analyzer ──────────────────────────────────────────────────
