import type { CsvRow } from '../csv-utils.js';
import type { RetornoBaseTeamAnalysis, RetornoBaseDayEvidence, KpiInsight } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, round2 } from '../csv-utils.js';
import { enrichRetornoEvidence } from './enrich-utils.js';
import { countDistinctDates } from './os-dia.analyzer.js';

export function analyzeRetornoBase(deslocRows: CsvRow[], kpis: KpiInsight[]): RetornoBaseTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const RETORNO_META = 40;

    const retornoKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'));
    if (!retornoKpi) return [];

    const teamsToAnalyze = new Map<string, { value: number }>();
    for (const t of retornoKpi.opportunityTeams) teamsToAnalyze.set(t.team, { value: t.value });
    if (teamsToAnalyze.size === 0) return [];

    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol          = deslocAcc.resolve(['Equipe']);
    const dateCol          = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const retornoBaseCol   = deslocAcc.resolve(['Retorno a base', 'Retorno a Base', 'Retorno Base']);
    const horaUltimaCol    = deslocAcc.resolve(['Hora Ultima Ordem', 'Hora Última Ordem']);
    const logOffCorCol     = deslocAcc.resolve(['Log Off Corrigido', 'LogOff Corrigido']);

    if (!teamCol) return [];

    const distinctDates = dateCol ? countDistinctDates(deslocRows, dateCol) : 0;

    // Global average
    const globalRetornoValues: number[] = [];
    const seenGlobal = new Set<string>();
    for (const row of deslocRows) {
      const team = teamCol ? String(row[teamCol] ?? '').trim() : '';
      const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
      const key = `${team}|${date}`;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      const v = retornoBaseCol ? parseNumber(String(row[retornoBaseCol] ?? '')) : null;
      if (v !== null && Number.isFinite(v) && v > 0) globalRetornoValues.push(v);
    }
    const globalAvgRetorno = globalRetornoValues.length > 0
      ? globalRetornoValues.reduce((s, x) => s + x, 0) / globalRetornoValues.length : 0;

    const result: RetornoBaseTeamAnalysis[] = [];

    for (const [team, { value: retornoValue }] of teamsToAnalyze.entries()) {
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

      const teamRetornoValues: number[] = [];
      for (const row of jornadaRows) {
        const v = retornoBaseCol ? parseNumber(String(row[retornoBaseCol] ?? '')) : null;
        if (v !== null && Number.isFinite(v) && v > 0) teamRetornoValues.push(v);
      }
      const teamAvgRetorno = teamRetornoValues.length > 0
        ? teamRetornoValues.reduce((s, x) => s + x, 0) / teamRetornoValues.length : 0;

      const diasAcimaMetaCount = teamRetornoValues.filter((v) => v > RETORNO_META).length;

      const flaggedDays: RetornoBaseDayEvidence[] = [];
      let countRetornoAlto = 0;
      let countRetornoMuitoAlto = 0;

      for (const row of jornadaRows) {
        const retornoMin = retornoBaseCol ? parseNumber(String(row[retornoBaseCol] ?? '')) : null;
        if (retornoMin === null || !Number.isFinite(retornoMin) || retornoMin <= 0) continue;

        const flags: RetornoBaseDayEvidence['flags'] = [];
        // retorno_muito_alto: > meta * 1.5 (> 60 min)
        // retorno_alto: > meta (> 40 min)
        if (retornoMin > RETORNO_META * 1.5) { flags.push('retorno_muito_alto'); countRetornoMuitoAlto++; }
        else if (retornoMin > RETORNO_META) { flags.push('retorno_alto'); countRetornoAlto++; }

        if (flags.length === 0) continue;

        flaggedDays.push({
          date_ref: dateCol ? String(row[dateCol] ?? '').trim() : '',
          retorno_base_min: round2(retornoMin),
          team_avg_retorno_min: round2(teamAvgRetorno),
          global_avg_retorno_min: round2(globalAvgRetorno),
          hora_ultima_ordem: horaUltimaCol ? String(row[horaUltimaCol] ?? '').trim() : '',
          log_off_corrigido: logOffCorCol  ? String(row[logOffCorCol] ?? '').trim()  : '',
          flags,
        });
      }

      flaggedDays.sort((a, b) => b.retorno_base_min - a.retorno_base_min);

      result.push({
        team,
        retornoBaseValue: retornoValue,
        metaTarget: RETORNO_META,
        gap: round2(retornoValue - RETORNO_META),
        avgRetornoMin: round2(teamAvgRetorno),
        globalAvgRetornoMin: round2(globalAvgRetorno),
        totalDays: jornadaRows.length,
        diasAcimaMetaCount,
        flaggedDays: enrichRetornoEvidence(
          distinctDates > 7 ? flaggedDays.slice(0, 10) : flaggedDays,
          RETORNO_META,
        ),
        summary: { countRetornoAlto, countRetornoMuitoAlto },
      });
    }

    return result.sort((a, b) => b.retornoBaseValue - a.retornoBaseValue);
  }

