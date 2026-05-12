import type { CsvRow } from '../csv-utils.js';
import type { PrimeiroDeslocTeamAnalysis, PrimeiroDeslocDayEvidence, KpiInsight } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, round2, parseDateTimeBr, minutesBetween } from '../csv-utils.js';
import { enrichDeslocEvidence } from './enrich-utils.js';
import { countDistinctDates } from './os-dia.analyzer.js';

export function analyzePrimeiroDesloc(deslocRows: CsvRow[], kpis: KpiInsight[]): PrimeiroDeslocTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const DESLOC_META = 25;

    const deslocKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('1º Desloc.'));
    if (!deslocKpi) return [];

    const teamsToAnalyze = new Map<string, { value: number }>();
    for (const t of deslocKpi.opportunityTeams) teamsToAnalyze.set(t.team, { value: t.value });
    if (teamsToAnalyze.size === 0) return [];

    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol             = deslocAcc.resolve(['Equipe']);
    const dateCol             = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const primeiroDeslocCol   = deslocAcc.resolve(['1º Desloc', '1o Desloc']);
    const horaPrimDeslocCol   = deslocAcc.resolve(['Hora 1º Deslocamento', 'Hora 1o Deslocamento']);
    const horaPrimDespachoCol = deslocAcc.resolve(['Hora 1º Despacho', 'Hora 1o Despacho']);
    const inicioCalCol        = deslocAcc.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
    const logInCorrigidoCol   = deslocAcc.resolve(['Log In Corrigido', 'LogIn Corrigido', 'Login Corrigido']);
    const nrOrdemCol          = deslocAcc.resolve(['Nr_Ordem', 'Nr Ordem', 'Numero Ordem']);

    if (!teamCol) return [];

    const distinctDates = dateCol ? countDistinctDates(deslocRows, dateCol) : 0;

    // Threshold: first dispatch is considered "tardio" if > 10 min after inicio_calendario
    const DESPACHO_TARDIO_MIN = 10;

    // Global average
    const globalDeslocValues: number[] = [];
    const seenGlobal = new Set<string>();
    for (const row of deslocRows) {
      const team = teamCol ? String(row[teamCol] ?? '').trim() : '';
      const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
      const key = `${team}|${date}`;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      const v = primeiroDeslocCol ? parseNumber(String(row[primeiroDeslocCol] ?? '')) : null;
      if (v !== null && Number.isFinite(v) && v >= 0) globalDeslocValues.push(v);
    }
    const globalAvgDesloc = globalDeslocValues.length > 0
      ? globalDeslocValues.reduce((s, x) => s + x, 0) / globalDeslocValues.length : 0;

    const result: PrimeiroDeslocTeamAnalysis[] = [];

    for (const [team, { value: deslocValue }] of teamsToAnalyze.entries()) {
      const teamNorm = normalizeToken(team);
      let teamRows = deslocRows.filter((r) => String(r[teamCol] ?? '').trim() === team);
      if (teamRows.length === 0) {
        teamRows = deslocRows.filter((r) => normalizeToken(String(r[teamCol] ?? '').trim()) === teamNorm);
      }
      if (teamRows.length === 0) continue;

      // Deduplicate by date
      const seenDates = new Set<string>();
      const jornadaRows: CsvRow[] = [];
      for (const row of teamRows) {
        const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
        if (!seenDates.has(date)) { seenDates.add(date); jornadaRows.push(row); }
      }

      const teamDeslocValues: number[] = [];
      for (const row of jornadaRows) {
        const v = primeiroDeslocCol ? parseNumber(String(row[primeiroDeslocCol] ?? '')) : null;
        if (v !== null && Number.isFinite(v) && v >= 0) teamDeslocValues.push(v);
      }
      const teamAvgDesloc = teamDeslocValues.length > 0
        ? teamDeslocValues.reduce((s, x) => s + x, 0) / teamDeslocValues.length : 0;

      const diasAcimaMetaCount = teamDeslocValues.filter((v) => v > DESLOC_META).length;

      const flaggedDays: PrimeiroDeslocDayEvidence[] = [];
      let countDeslocLento = 0;
      let countDeslocMuitoLento = 0;
      let countSemDeslocRegistrado = 0;
      let countDespachioTardio = 0;

      for (const row of jornadaRows) {
        const deslocMin    = primeiroDeslocCol   ? parseNumber(String(row[primeiroDeslocCol] ?? '')) : null;
        const horaDesloc   = horaPrimDeslocCol   ? String(row[horaPrimDeslocCol] ?? '').trim() : '';
        const horaDespacho = horaPrimDespachoCol ? String(row[horaPrimDespachoCol] ?? '').trim() : '';
        const inicioCal    = inicioCalCol        ? String(row[inicioCalCol] ?? '').trim() : '';
        const logInCor     = logInCorrigidoCol   ? String(row[logInCorrigidoCol] ?? '').trim() : '';
        const dateRef      = dateCol ? String(row[dateCol] ?? '').trim() : '';

        // Compute despacho_apos_inicio_min: time from inicio_calendario to first dispatch
        // Also compute login_atraso_min: delay between inicio_calendario and actual login
        let despachoAposInicioMin = 0;
        let loginAtrasoMin = 0;
        const makeDate = (t: string) => {
          if (t.includes('/')) return parseDateTimeBr(t);
          const base = dateRef ? `${dateRef} ${t}` : `01/01/2000 ${t}`;
          return parseDateTimeBr(base);
        };
        if (inicioCal && horaDespacho) {
          const inicioDate  = makeDate(inicioCal);
          const dispDate    = makeDate(horaDespacho);
          if (inicioDate && dispDate) {
            const diff = minutesBetween(dispDate, inicioDate);
            if (Number.isFinite(diff) && diff >= 0) despachoAposInicioMin = round2(diff);
          }
        }
        if (inicioCal && logInCor) {
          const inicioDate = makeDate(inicioCal);
          const loginDate  = makeDate(logInCor);
          if (inicioDate && loginDate) {
            const diff = minutesBetween(loginDate, inicioDate);
            if (Number.isFinite(diff) && diff > 0) loginAtrasoMin = round2(diff);
          }
        }

        const flags: PrimeiroDeslocDayEvidence['flags'] = [];

        if (deslocMin === null || !Number.isFinite(deslocMin) || deslocMin < 0) {
          if (horaDespacho && !horaDesloc) {
            flags.push('sem_desloc_registrado');
            countSemDeslocRegistrado++;
          }
        } else {
          // desloc_muito_lento: > meta * 1.5 (> 37.5 min)
          // desloc_lento: > meta (> 25 min)
          if (deslocMin > DESLOC_META * 1.5) { flags.push('desloc_muito_lento'); countDeslocMuitoLento++; }
          else if (deslocMin > DESLOC_META)  { flags.push('desloc_lento');        countDeslocLento++; }
        }

        // despacho_tardio: first dispatch > DESPACHO_TARDIO_MIN after inicio_calendario
        // Only flagged as supplemental — requires a primary desloc flag to be present
        if (despachoAposInicioMin > DESPACHO_TARDIO_MIN && flags.length > 0) {
          flags.push('despacho_tardio');
          countDespachioTardio++;
        }

        if (flags.length === 0) continue;

        flaggedDays.push({
          date_ref:                   dateRef,
          nr_ordem:                   nrOrdemCol ? String(row[nrOrdemCol] ?? '').trim() : '',
          hora_primeiro_despacho:     horaDespacho,
          hora_primeiro_deslocamento: horaDesloc,
          inicio_calendario:          inicioCal,
          log_in_corrigido:           logInCor,
          primeiro_desloc_min:        deslocMin !== null && Number.isFinite(deslocMin) ? round2(deslocMin) : 0,
          despacho_apos_inicio_min:   despachoAposInicioMin,
          login_atraso_min:           loginAtrasoMin,
          team_avg_desloc_min:        round2(teamAvgDesloc),
          global_avg_desloc_min:      round2(globalAvgDesloc),
          is_primeira_os_jornada:     true,
          flags,
        });
      }

      flaggedDays.sort((a, b) => b.primeiro_desloc_min - a.primeiro_desloc_min);

      result.push({
        team,
        primeiroDeslocValue: deslocValue,
        metaTarget: DESLOC_META,
        gap: round2(deslocValue - DESLOC_META),
        avgDeslocMin: round2(teamAvgDesloc),
        globalAvgDeslocMin: round2(globalAvgDesloc),
        totalDays: jornadaRows.length,
        diasAcimaMetaCount,
        flaggedDays: enrichDeslocEvidence(
          distinctDates > 7 ? flaggedDays.slice(0, 10) : flaggedDays,
          DESLOC_META,
        ),
        summary: { countDeslocLento, countDeslocMuitoLento, countSemDeslocRegistrado, countDespachioTardio },
      });
    }

    return result.sort((a, b) => b.primeiroDeslocValue - a.primeiroDeslocValue);
  }

  // ─── Retorno Base Analyzer ────────────────────────────────────────────────
