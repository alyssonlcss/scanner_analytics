import type { CsvRow } from '../csv-utils.js';
import type { UtilizacaoTeamAnalysis, UtilizacaoOrderEvidence, KpiInsight } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, round2, parseDateTimeBr, minutesBetween } from '../csv-utils.js';
import { calculateTempPrepValue, calculateSemOsValue } from '../builders/team-stats.builder.js';
import { enrichUtilizacaoEvidence } from './enrich-utils.js';

import { countDistinctDates, mergeEvidenceFlags } from './os-dia.analyzer.js';
export function analyzeUtilizacao(deslocRows: CsvRow[], kpis: KpiInsight[]): UtilizacaoTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const UTIL_META = 85;
    const IDLE_THRESHOLD_PCT = 15;
    const OS_DIA_PCT_THRESHOLD = 0.20;
    const TEMP_PREP_THRESHOLD_MIN = 10; // Desp. → A Caminho (all OS)
    const SEM_OS_THRESHOLD_MIN = 10;
    const TOLERANCE_MIN = 5; // invisible grace margin — keeps displayed limits unchanged

    const utilizacaoKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Utilização'));
    if (!utilizacaoKpi) return [];

    const underPerforming = new Map<string, number>();
    for (const t of utilizacaoKpi.opportunityTeams) {
      underPerforming.set(t.team, t.value);
    }
    if (underPerforming.size === 0) return [];

    // Resolve columns (same as analyzeOsDia)
    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol             = deslocAcc.resolve(['Equipe']);
    const dateCol             = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const caminhoCol          = deslocAcc.resolve(['A_Caminho', 'A Caminho']);
    const despachadaCol       = deslocAcc.resolve(['Despachada']);
    const liberadaCol         = deslocAcc.resolve(['Liberada']);
    const firstDeslocCol      = deslocAcc.resolve(['1º Desloc', '1o Desloc']);
    const firstDespachoCol    = deslocAcc.resolve(['1º Despacho', '1o Despacho']);
    const intervaloCol        = deslocAcc.resolve(['Intervalo']);
    const inicioIntervaloCol  = deslocAcc.resolve(['Inicio Intervalo', 'Início Intervalo']);
    const fimIntervaloCol     = deslocAcc.resolve(['Fim Intervalo']);
    const nrOrdemCol          = deslocAcc.resolve(['Nr_Ordem', 'Nr Ordem', 'Numero Ordem']);
    const classeCol           = deslocAcc.resolve(['CLASSE', 'Classe']);
    const causaCol            = deslocAcc.resolve(['CAUSA', 'Causa']);
    const noLocalCol          = deslocAcc.resolve(['No_Local', 'No Local']);
    const trOrdemCol          = deslocAcc.resolve(['TR Ordem', 'TR_Ordem']);
    const tlOrdemCol          = deslocAcc.resolve(['TL Ordem', 'TL_Ordem']);
    const hdTotalCol          = deslocAcc.resolve(['HD Total', 'HD_Total']);
    const tempoPadraoCol      = deslocAcc.resolve(['tempo_padrao', 'Tempo Padrao', 'Tempo_Padrao', 'TempoPadrao']);
    const inicioCalendarioCol = deslocAcc.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
    const logInCorrigidoCol   = deslocAcc.resolve(['Log In Corrigido', 'LogIn Corrigido', 'Login Corrigido']);
    const logOffCorrigidoCol  = deslocAcc.resolve(['Log Off Corrigido', 'LogOff Corrigido']);
    const retornoBaseCol      = deslocAcc.resolve(['Retorno a base', 'Retorno a Base', 'Retorno Base']);
    const horasExtrasCol      = deslocAcc.resolve(['Horas Extras', 'Horas extras']);
    // Timestamp of the first dispatch of the day (team-day aggregate)
    const horaPrimDespachoTsCol = deslocAcc.resolve(['Hora 1º Despacho', 'Hora 1o Despacho']);

    if (!teamCol || !dateCol || !caminhoCol || !despachadaCol || !liberadaCol) return [];

    // Baseline for sub-flag "Desl. Intervalo": global average without team-level filtering.
    const globalIntervaloDeslocValues: number[] = [];
    if (inicioIntervaloCol && fimIntervaloCol) {
      const allGrouped = new Map<string, CsvRow[]>();
      for (const row of deslocRows) {
        const team = String(row[teamCol] ?? '').trim();
        const date = String(row[dateCol] ?? '').trim();
        if (!team || !date) continue;
        const key = `${team}::${date}`;
        const rows = allGrouped.get(key) ?? [];
        rows.push(row);
        allGrouped.set(key, rows);
      }

      for (const rows of allGrouped.values()) {
        const orderedRows = [...rows].sort((a, b) => {
          const left = parseDateTimeBr(String(a[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const right = parseDateTimeBr(String(b[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return left - right;
        });

        for (let i = 1; i < orderedRows.length; i++) {
          const row = orderedRows[i];
          const prevRow = orderedRows[i - 1];
          const prevLiberadaDate = liberadaCol ? parseDateTimeBr(String(prevRow[liberadaCol] ?? '')) : null;
          const aCaminhoDate = parseDateTimeBr(String(row[caminhoCol] ?? ''));
          const inicioIntervaloRaw = String(row[inicioIntervaloCol] ?? '').trim();
          const fimIntervaloRaw = String(row[fimIntervaloCol] ?? '').trim();
          const inicioIntervaloDate = inicioIntervaloRaw ? parseDateTimeBr(inicioIntervaloRaw) : null;
          const fimIntervaloDate = fimIntervaloRaw ? parseDateTimeBr(fimIntervaloRaw) : null;

          const hasIntervaloDeslocamento = Boolean(
            prevLiberadaDate && aCaminhoDate &&
            inicioIntervaloDate && fimIntervaloDate &&
            inicioIntervaloDate.getTime() >= prevLiberadaDate.getTime() &&
            fimIntervaloDate.getTime() <= aCaminhoDate.getTime(),
          );
          if (!hasIntervaloDeslocamento || !inicioIntervaloDate || !prevLiberadaDate) continue;

          const intMin = minutesBetween(inicioIntervaloDate, prevLiberadaDate);
          if (Number.isFinite(intMin) && intMin > 0) {
            globalIntervaloDeslocValues.push(intMin);
          }
        }
      }
    }
    const globalAvgIntervaloDeslocMin = globalIntervaloDeslocValues.length > 0
      ? round2(globalIntervaloDeslocValues.reduce((sum, v) => sum + v, 0) / globalIntervaloDeslocValues.length)
      : 0;

    // Global avg of 1º Despacho (inicio_jornada) across all rows
    let globalIJSum = 0, globalIJCount = 0;
    if (firstDespachoCol) {
      for (const row of deslocRows) {
        const v = parseNumber(String(row[firstDespachoCol] ?? ''));
        if (v !== null && Number.isFinite(v) && v > 0 && v < 480) {
          globalIJSum += v;
          globalIJCount++;
        }
      }
    }
    const globalAvgInicioJornadaMin = globalIJCount > 0 ? round2(globalIJSum / globalIJCount) : 0;

    // Global avg of entre_ordens (between consecutive orders) across all teams/days
    const globalEntreOrdensValues: number[] = [];
    {
      const allGroupedEO = new Map<string, CsvRow[]>();
      for (const row of deslocRows) {
        const team = String(row[teamCol] ?? '').trim();
        const date = String(row[dateCol] ?? '').trim();
        if (!team || !date) continue;
        const rows = allGroupedEO.get(`${team}::${date}`) ?? [];
        rows.push(row);
        allGroupedEO.set(`${team}::${date}`, rows);
      }
      for (const rows of allGroupedEO.values()) {
        const orderedRows = [...rows].sort((a, b) => {
          const l = parseDateTimeBr(String(a[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const r = parseDateTimeBr(String(b[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return l - r;
        });
        for (let idx = 1; idx < orderedRows.length; idx++) {
          const prevLib = liberadaCol ? parseDateTimeBr(String(orderedRows[idx - 1][liberadaCol] ?? '')) : null;
          const desp    = despachadaCol ? parseDateTimeBr(String(orderedRows[idx][despachadaCol] ?? '')) : null;
          if (!prevLib || !desp) continue;
          const diffMin = minutesBetween(desp, prevLib);
          if (Number.isFinite(diffMin) && diffMin > 0 && diffMin < 480) {
            globalEntreOrdensValues.push(diffMin);
          }
        }
      }
    }
    const globalAvgEntreOrdensMin = globalEntreOrdensValues.length > 0
      ? round2(globalEntreOrdensValues.reduce((s, v) => s + v, 0) / globalEntreOrdensValues.length)
      : 0;

    // Global avg triagem (hora_despacho_anterior → despachada) across all rows with prior dispatch conflict
    const globalTriagemValues: number[] = [];
    if (horaPrimDespachoTsCol && despachadaCol) {
      const allGroupedTriagem = new Map<string, CsvRow[]>();
      for (const row of deslocRows) {
        const team = String(row[teamCol] ?? '').trim();
        const date = String(row[dateCol] ?? '').trim();
        if (!team || !date) continue;
        const rows2 = allGroupedTriagem.get(`${team}::${date}`) ?? [];
        rows2.push(row);
        allGroupedTriagem.set(`${team}::${date}`, rows2);
      }
      for (const rows2 of allGroupedTriagem.values()) {
        const orderedRows = [...rows2].sort((a, b) => {
          const l = parseDateTimeBr(String(a[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const r = parseDateTimeBr(String(b[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return l - r;
        });
        if (orderedRows.length === 0) continue;
        const firstRowTr = orderedRows[0];
        const hora1oRaw  = String(firstRowTr[horaPrimDespachoTsCol] ?? '').trim();
        const despRaw    = String(firstRowTr[despachadaCol] ?? '').trim();
        if (!hora1oRaw || !despRaw || hora1oRaw === despRaw) continue;
        const hora1oDt = parseDateTimeBr(hora1oRaw);
        const despDt   = parseDateTimeBr(despRaw);
        if (!hora1oDt || !despDt) continue;
        const tMin = minutesBetween(despDt, hora1oDt);
        if (Number.isFinite(tMin) && tMin > 0 && tMin < 480) globalTriagemValues.push(tMin);
      }
    }
    const globalAvgTriagemMin = globalTriagemValues.length > 0
      ? round2(globalTriagemValues.reduce((s, v) => s + v, 0) / globalTriagemValues.length)
      : 0;

    // Group by team+date, underperforming teams only
    const grouped = new Map<string, { team: string; date: string; rows: CsvRow[] }>();
    for (const row of deslocRows) {
      const team = String(row[teamCol] ?? '').trim();
      if (!underPerforming.has(team)) continue;
      const date = String(row[dateCol] ?? '').trim();
      if (!date) continue;
      const key = `${team}::${date}`;
      const entry = grouped.get(key) ?? { team, date, rows: [] };
      entry.rows.push(row);
      grouped.set(key, entry);
    }

    // Collect evidence per team (same pattern as analyzeOsDia)
    const teamEvidences = new Map<string, UtilizacaoOrderEvidence[]>();
    const teamAllBasicUtil = new Map<string, UtilizacaoOrderEvidence[]>();
    const teamAllBasicUtilSeen = new Map<string, Set<string>>();
    const teamHdTotals = new Map<string, { sum: number; count: number }>();
    const teamTotalOrders = new Map<string, number>();
    const teamTempPrepSum = new Map<string, number>();
    const teamSemOrdemSum = new Map<string, number>();
    const teamDayCount = new Map<string, number>();
    const teamDailyIdles = new Map<string, number[]>();
    const teamHorasExtrasSum = new Map<string, number>();
    // For jornada-level tracking (jornadasAbaixoMeta count)
    const teamJornadas = new Map<string, Array<{ htTotalMin: number; hdTotalMin: number }>>();

    for (const { team, date: _date, rows: groupRows } of grouped.values()) {
      teamDayCount.set(team, (teamDayCount.get(team) ?? 0) + 1);
      // Sort by A_Caminho ascending
      const ordered = [...groupRows].sort((a, b) => {
        const left  = parseDateTimeBr(String(a[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const right = parseDateTimeBr(String(b[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return left - right;
      });

      const firstRow = ordered[0];
      const firstIntervalMinutes = parseNumber(String(firstRow[intervaloCol ?? ''] ?? ''));
      const semOsIntervalStart = inicioIntervaloCol ? parseDateTimeBr(String(firstRow[inicioIntervaloCol] ?? '')) : null;
      const semOsIntervalEnd   = fimIntervaloCol    ? parseDateTimeBr(String(firstRow[fimIntervaloCol]    ?? '')) : null;

      const tempPrepValues: number[] = [];
      const ocisoValues: (number | undefined)[] = [];
      const semOsValues: number[]    = [];
      const semOsIntervalApplied: boolean[] = [];
      let isInterACaminho = false;
      let isInterOrdem    = false;

      // First order: TempPrep = Despachada → A Caminho; Ocioso = Início Cal. → A Caminho
      const aCaminhoFirst   = caminhoCol    ? parseDateTimeBr(String(firstRow[caminhoCol]    ?? '')) : null;
      const despachadaFirst = despachadaCol ? parseDateTimeBr(String(firstRow[despachadaCol] ?? '')) : null;
      tempPrepValues.push(aCaminhoFirst && despachadaFirst ? minutesBetween(aCaminhoFirst, despachadaFirst) : Number.NaN);
      const firstOcisoRaw = firstDeslocCol ? parseNumber(String(firstRow[firstDeslocCol] ?? '')) : null;
      if (firstOcisoRaw !== null && Number.isFinite(firstOcisoRaw)) {
        ocisoValues.push(round2(firstOcisoRaw));
      } else if (aCaminhoFirst && inicioCalendarioCol) {
        const inicioCalFirst = parseDateTimeBr(String(firstRow[inicioCalendarioCol] ?? ''));
        ocisoValues.push(inicioCalFirst ? round2(minutesBetween(aCaminhoFirst, inicioCalFirst)) : undefined);
      } else {
        ocisoValues.push(undefined);
      }
      semOsValues.push(   firstDespachoCol ? (parseNumber(String(firstRow[firstDespachoCol] ?? '')) ?? Number.NaN) : Number.NaN);
      semOsIntervalApplied.push(false);

      for (let i = 1; i < ordered.length; i++) {
        const current  = ordered[i];
        const previous = ordered[i - 1];

        const aCaminho        = parseDateTimeBr(String(current[caminhoCol]    ?? ''));
        const despachada      = parseDateTimeBr(String(current[despachadaCol] ?? ''));
        const liberada        = parseDateTimeBr(String(previous[liberadaCol]  ?? ''));
        const inicioIntervalo = inicioIntervaloCol ? parseDateTimeBr(String(current[inicioIntervaloCol] ?? '')) : null;
        const fimIntervalo    = fimIntervaloCol    ? parseDateTimeBr(String(current[fimIntervaloCol]    ?? '')) : null;
        const intervaloMinutes = parseNumber(String(current[intervaloCol ?? ''] ?? ''));

        const tempPrep = calculateTempPrepValue({
          aCaminho, despachada, liberada,
          inicioIntervalo, fimIntervalo, intervaloMinutes,
          isIntervalAlreadyApplied: isInterACaminho,
        });
        if (tempPrep.intervalApplied) isInterACaminho = true;
        tempPrepValues.push(tempPrep.value);
        // Ocioso for subsequent OS = A Caminho − prev Liberada
        ocisoValues.push(aCaminho && liberada ? round2(minutesBetween(aCaminho, liberada)) : undefined);

        const semOs = calculateSemOsValue({
          despachada, liberada,
          inicioIntervalo: semOsIntervalStart,
          fimIntervalo:    semOsIntervalEnd,
          intervaloMinutes: firstIntervalMinutes,
          isIntervalAlreadyApplied: isInterOrdem,
        });
        if (semOs.intervalApplied) isInterOrdem = true;
        semOsValues.push(semOs.value);
        semOsIntervalApplied.push(semOs.intervalApplied);
      }

      // SemOrdem: gap from last OS's Liberada (or Fim Intervalo when interval is in this window) to Log Off Corrigido.
      // The visible segment is: segmentStart → Log Off. If directGap ≤ retorno base → "Retorno a base"; else "Antes Log Off".
      const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
      let semOsFimJornadaMin = Number.NaN;   // excess above retorno base (for flag threshold)
      let semOsFimDirectGapMin = Number.NaN; // raw segment duration shown in report
      let semOsFimFrom: string | undefined;
      let semOsFimFromLabel: string | undefined;
      let semOsFimDeslIntervalMin = Number.NaN;
      let semOsFimRetornoBaseRowVal = 0;
      let semOsFimRetornoBaseUsedRow = false;
      let semOsFimAboveThreshold = false;
      let semOsFimHasIntervalInWindow = false;
      if (logOffCorrigidoCol && liberadaCol) {
        const lastRow = ordered[ordered.length - 1];
        const lastLiberada = parseDateTimeBr(String(lastRow[liberadaCol] ?? ''));
        const logOff = parseDateTimeBr(String(lastRow[logOffCorrigidoCol] ?? ''));
        if (lastLiberada && logOff && logOff.getTime() > lastLiberada.getTime()) {
          const lastIntStart = inicioIntervaloCol ? parseDateTimeBr(String(lastRow[inicioIntervaloCol] ?? '')) : null;
          const lastIntEnd   = fimIntervaloCol    ? parseDateTimeBr(String(lastRow[fimIntervaloCol]    ?? '')) : null;
          // Interval is in the fim_jornada window when it falls between last Liberada and Log Off
          const hasIntervalInFimWindow = Boolean(
            lastIntStart && lastIntEnd &&
            lastIntStart.getTime() >= lastLiberada.getTime() &&
            lastIntEnd.getTime() <= logOff.getTime(),
          );
          semOsFimHasIntervalInWindow = hasIntervalInFimWindow;
          // Segment start: Fim Intervalo (when interval in window) or Liberada
          const segmentStart = hasIntervalInFimWindow && lastIntEnd ? lastIntEnd : lastLiberada;
          semOsFimFrom = hasIntervalInFimWindow && fimIntervaloCol
            ? String(lastRow[fimIntervaloCol] ?? '').trim() || undefined
            : String(lastRow[liberadaCol] ?? '').trim() || undefined;
          semOsFimFromLabel = hasIntervalInFimWindow ? 'Fim Intervalo' : 'última Liberada';
          const directGapMin = minutesBetween(logOff, segmentStart);
          semOsFimDirectGapMin = directGapMin;
          // Desl. Intervalo for end-of-day interval: Liberada → Início Intervalo is sem_os time
          if (hasIntervalInFimWindow && lastIntStart) {
            semOsFimDeslIntervalMin = round2(minutesBetween(lastIntStart, lastLiberada));
            if (semOsFimDeslIntervalMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
              semOsValues.push(semOsFimDeslIntervalMin);
            }
          }
          // Retorno a Base: row value for display; avg for fallback threshold only
          const retornoBaseRow = retornoBaseCol ? parseNumber(String(lastRow[retornoBaseCol] ?? '')) : null;
          const retornoBaseRowVal = (retornoBaseRow !== null && Number.isFinite(retornoBaseRow) && retornoBaseRow > 0)
            ? retornoBaseRow : 0;
          if (retornoBaseRowVal > 0) {
            // Row has Retorno a base → segment relabeled "Retorno a base" in UI
            semOsFimRetornoBaseRowVal = round2(retornoBaseRowVal);
            semOsFimRetornoBaseUsedRow = true;
            // Flag if total gap exceeds global avg by ≥15 min (Antes Log Off — separate flag, not ociosidade)
            if (retornoBaseAvg > 0 && (directGapMin - retornoBaseAvg) >= 15) {
              semOsFimJornadaMin = round2(directGapMin - retornoBaseAvg);
              semOsFimAboveThreshold = true;
            }
          } else if (retornoBaseAvg > 0) {
            // Row empty: flag if ≥15 min above global avg (Antes Log Off — separate flag, not ociosidade)
            if ((directGapMin - retornoBaseAvg) >= 15) {
              semOsFimJornadaMin = round2(directGapMin - retornoBaseAvg);
              semOsFimAboveThreshold = true;
            }
          } else {
            // No retorno base data: fall back to SEM_OS_THRESHOLD_MIN (Antes Log Off — separate flag)
            if (directGapMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
              semOsFimJornadaMin = round2(directGapMin);
              semOsFimAboveThreshold = true;
            }
          }
        }
      }

      // Jornada-level HT/HD for jornadasAbaixoMeta count
      let htJornada = 0;
      for (const row of ordered) {
        const trMin = trOrdemCol ? (parseNumber(String(row[trOrdemCol] ?? '')) ?? 0) : 0;
        const tlMin = tlOrdemCol ? (parseNumber(String(row[tlOrdemCol] ?? '')) ?? 0) : 0;
        htJornada += trMin + tlMin;
      }
      let hdJornada = 0;
      if (logInCorrigidoCol && logOffCorrigidoCol) {
        let logInStr = '';
        let logOffStr = '';
        for (const row of ordered) {
          const c = String(row[logInCorrigidoCol] ?? '').trim();
          if (c) { logInStr = c; break; }
        }
        for (const row of ordered) {
          const c = String(row[logOffCorrigidoCol] ?? '').trim();
          if (c) { logOffStr = c; break; }
        }
        const logInDate  = parseDateTimeBr(logInStr);
        const logOffDate = parseDateTimeBr(logOffStr);
        if (logInDate && logOffDate && logOffDate.getTime() > logInDate.getTime()) {
          hdJornada = minutesBetween(logOffDate, logInDate);
        }
      }
      const jornadasList = teamJornadas.get(team) ?? [];
      jornadasList.push({ htTotalMin: round2(htJornada), hdTotalMin: round2(hdJornada) });
      teamJornadas.set(team, jornadasList);

      // Accumulate HD Total from column
      if (hdTotalCol) {
        for (const row of ordered) {
          const hdVal = parseNumber(String(row[hdTotalCol] ?? ''));
          if (hdVal !== null && Number.isFinite(hdVal)) {
            const e = teamHdTotals.get(team) ?? { sum: 0, count: 0 };
            e.sum += hdVal;
            e.count += 1;
            teamHdTotals.set(team, e);
          }
        }
      }

      // Accumulate TempPrep and SemOrdem
      for (const v of tempPrepValues) {
        if (Number.isFinite(v) && v > 0) teamTempPrepSum.set(team, (teamTempPrepSum.get(team) ?? 0) + v);
      }
      for (const v of semOsValues) {
        if (Number.isFinite(v) && v > 0) teamSemOrdemSum.set(team, (teamSemOrdemSum.get(team) ?? 0) + v);
      }
      const dayIdleTotal =
        tempPrepValues.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0) +
        semOsValues.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0);
      if (dayIdleTotal > 0) {
        const arr = teamDailyIdles.get(team) ?? [];
        arr.push(dayIdleTotal);
        teamDailyIdles.set(team, arr);
      }

      teamTotalOrders.set(team, (teamTotalOrders.get(team) ?? 0) + ordered.length);

      // Accumulate Horas Extras (per-jornada value — same for all OS in the group)
      if (horasExtrasCol) {
        const heVal = parseNumber(String(firstRow[horasExtrasCol] ?? ''));
        if (heVal !== null && Number.isFinite(heVal) && heVal > 0) {
          teamHorasExtrasSum.set(team, (teamHorasExtrasSum.get(team) ?? 0) + heVal);
        }
      }

      // Collect basic info for ALL orders (for "Ver mais" expansion, includes non-flagged)
      {
        const basicArr = teamAllBasicUtil.get(team) ?? [];
        const seen = teamAllBasicUtilSeen.get(team) ?? new Set<string>();
        for (let bIdx = 0; bIdx < ordered.length; bIdx++) {
          const row = ordered[bIdx];
          const prevRow = bIdx > 0 ? ordered[bIdx - 1] : null;
          const nr = nrOrdemCol ? String(row[nrOrdemCol] ?? '').trim() : '';
          const desp = despachadaCol ? String(row[despachadaCol] ?? '').trim() : '';
          const key = nr || desp;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const trMin = trOrdemCol ? (parseNumber(String(row[trOrdemCol] ?? '')) ?? 0) : 0;
          const tlMin = tlOrdemCol ? (parseNumber(String(row[tlOrdemCol] ?? '')) ?? 0) : 0;
          const hdMin = hdTotalCol ? (parseNumber(String(row[hdTotalCol] ?? '')) ?? 0) : 0;
          basicArr.push({
            nr_ordem: nr,
            date_ref: dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
            classe: classeCol ? String(row[classeCol] ?? '').trim() : '',
            causa: causaCol ? String(row[causaCol] ?? '').trim() : '',
            prev_liberada: prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined,
            despachada: desp,
            a_caminho: String(row[caminhoCol] ?? '').trim(),
            no_local: noLocalCol ? String(row[noLocalCol] ?? '').trim() : '',
            liberada: liberadaCol ? String(row[liberadaCol] ?? '').trim() : '',
            inicio_intervalo: inicioIntervaloCol ? String(row[inicioIntervaloCol] ?? '').trim() : '',
            fim_intervalo: fimIntervaloCol ? String(row[fimIntervaloCol] ?? '').trim() : '',
            inicio_calendario: bIdx === 0 && inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
            log_in: bIdx === 0 && logInCorrigidoCol ? String(row[logInCorrigidoCol] ?? '').trim() || undefined : undefined,
            tr_ordem_min: round2(trMin),
            tl_ordem_min: round2(tlMin),
            hd_total_min: round2(hdMin),
            hd_pct_tr: hdMin > 0 ? round2((trMin / hdMin) * 100) : 0,
            hd_pct_tl: hdMin > 0 ? round2((tlMin / hdMin) * 100) : 0,
            tempo_padrao_min: tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) ?? undefined : undefined,
            flags: [],
          });
        }
        teamAllBasicUtil.set(team, basicArr);
        teamAllBasicUtilSeen.set(team, seen);
      }

      // Build per-order evidence (exact same logic as analyzeOsDia)
      const evidences = teamEvidences.get(team) ?? [];
      for (let i = 0; i < ordered.length; i++) {
        const row     = ordered[i];
        const prevRow = i > 0 ? ordered[i - 1] : null;

        const trOrdemMin    = trOrdemCol     ? (parseNumber(String(row[trOrdemCol]     ?? '')) ?? 0) : 0;
        const tlOrdemMin    = tlOrdemCol     ? (parseNumber(String(row[tlOrdemCol]     ?? '')) ?? 0) : 0;
        const hdTotalMin    = hdTotalCol     ? (parseNumber(String(row[hdTotalCol]     ?? '')) ?? 0) : 0;
        const tempoPadraoRaw = tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) : null;
        const tempPrepOs = tempPrepValues[i] ?? Number.NaN;
        const semOsMin   = semOsValues[i]    ?? Number.NaN;

        const hdPctTr = hdTotalMin > 0 ? round2((trOrdemMin / hdTotalMin) * 100) : 0;
        const hdPctTl = hdTotalMin > 0 ? round2((tlOrdemMin / hdTotalMin) * 100) : 0;

        const flags: UtilizacaoOrderEvidence['flags'] = [];

        // Detect prior-dispatch conflict early so triagem_alto flag can be set alongside others
        let nrOrdemDespachoAnterior: string | undefined;
        let horaDespachoAnterior: string | undefined;
        let triagemMin: number | undefined;
        if (i === 0 && horaPrimDespachoTsCol && nrOrdemCol && despachadaCol) {
          const hora1oDespachoRaw = String(row[horaPrimDespachoTsCol] ?? '').trim();
          const thisDespachadaRaw = String(row[despachadaCol] ?? '').trim();
          if (hora1oDespachoRaw && thisDespachadaRaw && hora1oDespachoRaw !== thisDespachadaRaw) {
            const anteriorRow = ordered.find(
              (r) => String(r[despachadaCol] ?? '').trim() === hora1oDespachoRaw,
            );
            if (anteriorRow) {
              nrOrdemDespachoAnterior = String(anteriorRow[nrOrdemCol] ?? '').trim() || undefined;
              horaDespachoAnterior = hora1oDespachoRaw || undefined;
              const hora1oDt = parseDateTimeBr(hora1oDespachoRaw);
              const despachadaDt = parseDateTimeBr(thisDespachadaRaw);
              if (hora1oDt && despachadaDt) {
                const tMin = minutesBetween(despachadaDt, hora1oDt);
                if (Number.isFinite(tMin) && tMin > 0) triagemMin = round2(tMin);
              }
            }
          }
        }

        const tempPrepThreshold = TEMP_PREP_THRESHOLD_MIN;
        if (Number.isFinite(tempPrepOs) && tempPrepOs >= tempPrepThreshold + TOLERANCE_MIN) flags.push('temp_prep_alto');
        if (triagemMin !== undefined && triagemMin >= TEMP_PREP_THRESHOLD_MIN + TOLERANCE_MIN) flags.push('triagem_alto');
        // 1º Desloc.: Início Cal. → A Caminho, only for 1ª OS, threshold 25 min
        const ocisoForFlag = ocisoValues[i];
        if (i === 0 && ocisoForFlag !== undefined && ocisoForFlag >= 25) flags.push('primeiro_desloc_alto');
        if (Number.isFinite(semOsMin) && semOsMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) flags.push('sem_os_alto');
        if (hdTotalMin > 0 && trOrdemMin > hdTotalMin * OS_DIA_PCT_THRESHOLD) flags.push('tr_excede_hd');

        const prevLiberadaDate   = prevRow && liberadaCol ? parseDateTimeBr(String(prevRow[liberadaCol] ?? '')) : null;
        const aCaminhoDate       = parseDateTimeBr(String(row[caminhoCol] ?? ''));
        const liberadaAtualDate  = liberadaCol ? parseDateTimeBr(String(row[liberadaCol] ?? '')) : null;
        const inicioIntervaloRaw = inicioIntervaloCol ? String(row[inicioIntervaloCol] ?? '').trim() : '';
        const fimIntervaloRaw    = fimIntervaloCol    ? String(row[fimIntervaloCol]    ?? '').trim() : '';
        const inicioIntervaloDate = inicioIntervaloRaw ? parseDateTimeBr(inicioIntervaloRaw) : null;
        const fimIntervaloDate    = fimIntervaloRaw    ? parseDateTimeBr(fimIntervaloRaw)    : null;

        const hasIntervaloDeslocamento = Boolean(
          prevLiberadaDate && aCaminhoDate &&
          inicioIntervaloDate && fimIntervaloDate &&
          inicioIntervaloDate.getTime() >= prevLiberadaDate.getTime() &&
          fimIntervaloDate.getTime() <= aCaminhoDate.getTime(),
        );
        const intervaloDeslocMin = hasIntervaloDeslocamento && inicioIntervaloDate && prevLiberadaDate
          ? round2(minutesBetween(inicioIntervaloDate, prevLiberadaDate))
          : null;
        const intervaloDeslocAboveGlobalAvg = Boolean(
          intervaloDeslocMin !== null &&
          Number.isFinite(intervaloDeslocMin) &&
          globalAvgIntervaloDeslocMin > 0 &&
          intervaloDeslocMin > globalAvgIntervaloDeslocMin,
        );
        if (intervaloDeslocAboveGlobalAvg) flags.push('sem_os_alto');

        let uniqueFlags = [...new Set(flags)] as UtilizacaoOrderEvidence['flags'];
        if (uniqueFlags.length === 0) continue;

        const intervaloNaJanela = Boolean(
          inicioIntervaloDate &&
          liberadaAtualDate &&
          inicioIntervaloDate.getTime() <= liberadaAtualDate.getTime() &&
          (prevLiberadaDate === null || inicioIntervaloDate.getTime() >= prevLiberadaDate.getTime()),
        );

        const semOsDetails: NonNullable<UtilizacaoOrderEvidence['sem_os_details']> = [];
        if (Number.isFinite(semOsMin) && semOsMin >= SEM_OS_THRESHOLD_MIN) {
          if (i === 0) {
            semOsDetails.push({
              type: 'inicio_jornada',
              min:  round2(semOsMin),
              from: inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
              to:   despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined,
              global_avg_min: globalAvgInicioJornadaMin > 0 ? globalAvgInicioJornadaMin : undefined,
              above_avg_pct: globalAvgInicioJornadaMin > 0 ? round2((semOsMin - globalAvgInicioJornadaMin) / globalAvgInicioJornadaMin * 100) : undefined,
            });
          } else {
            const prevDespStr = prevRow && despachadaCol ? String(prevRow[despachadaCol] ?? '').trim() || undefined : undefined;
            const prevDespDate = prevDespStr ? parseDateTimeBr(prevDespStr) : null;
            const prevLibStr  = prevRow && liberadaCol  ? String(prevRow[liberadaCol]  ?? '').trim() || undefined : undefined;
            const prevLibDate  = prevLibStr  ? parseDateTimeBr(prevLibStr)  : null;
            const despachadaDate = despachadaCol ? parseDateTimeBr(String(row[despachadaCol] ?? '')) : null;
            // When the interval overlaps the dispatch window (interceptsDispatch case), calculateSemOsValue
            // already returns minutesBetween(inicioIntervalo, prevLiberada) as semOsMin — the exact
            // pre-interval travel time.
            // When the interval fits fully within the entre-ordens window (insideTolerance case),
            // semOsMin is the total discounted gap. We must split it into separate entries.
            if (
              hasIntervaloDeslocamento &&
              semOsIntervalApplied[i] &&
              inicioIntervaloDate &&
              despachadaDate &&
              inicioIntervaloDate.getTime() < despachadaDate.getTime()
            ) {
              const isInterceptsDispatch = Boolean(
                fimIntervaloDate && despachadaDate.getTime() < fimIntervaloDate.getTime(),
              );
              if (isInterceptsDispatch) {
                // semOsMin IS the pre-interval travel time (minutesBetween(inicioIntervalo, prevLiberada)).
                const interceptMin = round2(semOsMin);
                if (interceptMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
                  const overPct = globalAvgIntervaloDeslocMin > 0
                    ? round2(((interceptMin - globalAvgIntervaloDeslocMin) / globalAvgIntervaloDeslocMin) * 100)
                    : undefined;
                  semOsDetails.push({
                    type: 'intervalo_deslocamento',
                    min:  interceptMin,
                    from: prevLibStr,
                    to:   inicioIntervaloRaw || undefined,
                    global_avg_min: globalAvgIntervaloDeslocMin > 0 ? round2(globalAvgIntervaloDeslocMin) : undefined,
                    above_avg_pct: overPct,
                  });
                }
              } else {
                // insideTolerance: split into pre-interval travel (prevLiberada → inicioIntervalo)
                // and post-interval wait (fimIntervalo → despachada).
                if (intervaloDeslocMin !== null && intervaloDeslocMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
                  const overPct = globalAvgIntervaloDeslocMin > 0
                    ? round2(((intervaloDeslocMin - globalAvgIntervaloDeslocMin) / globalAvgIntervaloDeslocMin) * 100)
                    : undefined;
                  semOsDetails.push({
                    type: 'intervalo_deslocamento',
                    min:  intervaloDeslocMin,
                    from: prevLibStr,
                    to:   inicioIntervaloRaw || undefined,
                    global_avg_min: globalAvgIntervaloDeslocMin > 0 ? round2(globalAvgIntervaloDeslocMin) : undefined,
                    above_avg_pct: overPct,
                  });
                }
                if (fimIntervaloDate) {
                  const postIntervalMin = round2(minutesBetween(despachadaDate, fimIntervaloDate));
                  if (postIntervalMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
                    semOsDetails.push({
                      type: 'entre_ordens',
                      min:  postIntervalMin,
                      from: fimIntervaloRaw || undefined,
                      to:   despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined,
                      global_avg_min: globalAvgEntreOrdensMin > 0 ? globalAvgEntreOrdensMin : undefined,
                      above_avg_pct: globalAvgEntreOrdensMin > 0 ? round2((postIntervalMin - globalAvgEntreOrdensMin) / globalAvgEntreOrdensMin * 100) : undefined,
                    });
                  }
                }
              }
            } else {
              semOsDetails.push({
                type: 'entre_ordens',
                min:  round2(semOsMin),
                from: prevLibStr,
                to:   despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined,
                interval_discounted: semOsIntervalApplied[i] || undefined,
                desp_anterior: (prevDespDate && prevLibDate && prevDespDate.getTime() > prevLibDate.getTime()) ? prevDespStr : undefined,
                global_avg_min: globalAvgEntreOrdensMin > 0 ? globalAvgEntreOrdensMin : undefined,
                above_avg_pct: globalAvgEntreOrdensMin > 0 ? round2((semOsMin - globalAvgEntreOrdensMin) / globalAvgEntreOrdensMin * 100) : undefined,
              });
            }
          }
        }
        // Skip intervalo_deslocamento when the interval was already absorbed into entre_ordens
        // (semOsIntervalApplied[i] === true), to avoid two sub-flags pointing to the same time window.
        if (intervaloDeslocAboveGlobalAvg && intervaloDeslocMin !== null && !semOsIntervalApplied[i] && intervaloDeslocMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
          // When the current OS has a Despachada between prevLiberada and inicioIntervalo,
          // the "Desl. Intervalo" is measured from Despachada (not Lib. Anterior).
          const despachadaAtualDate = despachadaCol ? parseDateTimeBr(String(row[despachadaCol] ?? '')) : null;
          const useDespachadaAsFrom = Boolean(
            despachadaAtualDate && prevLiberadaDate && inicioIntervaloDate &&
            despachadaAtualDate.getTime() > prevLiberadaDate.getTime() &&
            despachadaAtualDate.getTime() < inicioIntervaloDate.getTime(),
          );
          const displayMin = useDespachadaAsFrom && despachadaAtualDate && inicioIntervaloDate
            ? round2(minutesBetween(inicioIntervaloDate, despachadaAtualDate))
            : intervaloDeslocMin;
          const fromStr = useDespachadaAsFrom
            ? (despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined)
            : (prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined);
          const overPct = globalAvgIntervaloDeslocMin > 0
            ? round2(((displayMin - globalAvgIntervaloDeslocMin) / globalAvgIntervaloDeslocMin) * 100)
            : undefined;
          semOsDetails.push({
            type: 'intervalo_deslocamento',
            min:  displayMin,
            from: fromStr,
            to:   inicioIntervaloRaw || undefined,
            global_avg_min: globalAvgIntervaloDeslocMin > 0 ? round2(globalAvgIntervaloDeslocMin) : undefined,
            above_avg_pct: overPct,
            from_label: useDespachadaAsFrom ? 'Despachada' : 'Lib. Anterior',
          });
        }

        const semOsTotalMin = semOsDetails.length > 0 ? round2(semOsDetails.reduce((s, d) => s + d.min, 0)) : undefined;

        // If no sem_os sub-flag qualified individually, suppress sem_os_alto to avoid an
        // empty "Sem Ordem/OS:" header in the report.
        if (semOsDetails.length === 0 && uniqueFlags.includes('sem_os_alto')) {
          uniqueFlags = uniqueFlags.filter((f) => f !== 'sem_os_alto') as UtilizacaoOrderEvidence['flags'];
          if (uniqueFlags.length === 0) continue;
        }

        // Detect prior-dispatch conflict for the first OS of the day (i === 0).
        // NOTE: detection already done above (before flags) — skip duplicate block.

        evidences.push({
          date_ref:          dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
          nr_ordem:          nrOrdemCol ? String(row[nrOrdemCol] ?? '').trim()         : '',
          classe:            classeCol  ? String(row[classeCol]  ?? '').trim()         : '',
          causa:             causaCol   ? String(row[causaCol]   ?? '').trim()         : '',
          despachada:        despachadaCol       ? String(row[despachadaCol]       ?? '').trim() : '',
          a_caminho:                       String(row[caminhoCol]                     ?? '').trim(),
          no_local:          noLocalCol  ? String(row[noLocalCol]  ?? '').trim()    : '',
          liberada:          liberadaCol ? String(row[liberadaCol] ?? '').trim()    : '',
          inicio_intervalo:  intervaloNaJanela ? inicioIntervaloRaw : '',
          fim_intervalo:     intervaloNaJanela ? fimIntervaloRaw    : '',
          prev_liberada:     prevRow && liberadaCol    ? String(prevRow[liberadaCol]    ?? '').trim() : undefined,
          prev_nr_ordem:     prevRow && nrOrdemCol     ? String(prevRow[nrOrdemCol]     ?? '').trim() : undefined,
          prev_despachada:   prevRow && despachadaCol  ? String(prevRow[despachadaCol]  ?? '').trim() : undefined,
          inicio_calendario: inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
          log_in:            logInCorrigidoCol   ? String(row[logInCorrigidoCol]   ?? '').trim() || undefined : undefined,
          tr_ordem_min:      round2(trOrdemMin),
          tl_ordem_min:      round2(tlOrdemMin),
          hd_total_min:      round2(hdTotalMin),
          hd_pct_tr:         hdPctTr,
          hd_pct_tl:         hdPctTl,
          tempo_padrao_min:  tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) ? round2(tempoPadraoRaw) : undefined,
          temp_prep_os_min:  Number.isFinite(tempPrepOs) ? round2(tempPrepOs) : undefined,
          triagem_min:       triagemMin,
          triagem_global_avg_min: (triagemMin !== undefined && globalAvgTriagemMin > 0) ? globalAvgTriagemMin : undefined,
          ocioso_min:        ocisoValues[i],
          sem_os_details:    semOsDetails.length > 0 ? semOsDetails : undefined,
          sem_os_total_min:  semOsTotalMin,
          flags:             uniqueFlags,
          nr_ordem_despacho_anterior: nrOrdemDespachoAnterior,
          hora_despacho_anterior:     horaDespachoAnterior,
        });
      }

      // Always attach fim_jornada to the last OS for timeline rendering (Log Off segment).
      // sem_os_alto activates when excess > 5 above retorno base (row), or > 20% above avg (row empty),
      // or when Desl. Intervalo before end-of-day interval is ≥10 min.
      {
        const lastRow = ordered[ordered.length - 1];
        const lastNrOrdem = nrOrdemCol ? String(lastRow[nrOrdemCol] ?? '').trim() : '';
        const logOffStr  = logOffCorrigidoCol ? String(lastRow[logOffCorrigidoCol] ?? '').trim() || undefined : undefined;
        const liberadaStr = liberadaCol ? String(lastRow[liberadaCol] ?? '').trim() || undefined : undefined;
        if (logOffStr) {
          const fimDeslAbove = Number.isFinite(semOsFimDeslIntervalMin) && semOsFimDeslIntervalMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN;
          const semOsAbove = fimDeslAbove; // fim_jornada is a separate flag, not part of ociosidade
          const fimDetail: NonNullable<UtilizacaoOrderEvidence['sem_os_details']>[number] = {
            type: 'fim_jornada',
            min:  Number.isFinite(semOsFimDirectGapMin) && semOsFimDirectGapMin > 0 ? round2(semOsFimDirectGapMin) : 0,
            from: semOsFimFrom ?? liberadaStr,
            to:   logOffStr,
            from_label: semOsFimFromLabel,
            retorno_base_discounted: semOsFimRetornoBaseRowVal > 0 ? semOsFimRetornoBaseRowVal : undefined,
            retorno_base_used_row:   semOsFimRetornoBaseUsedRow || undefined,
            excess_min: semOsFimAboveThreshold && Number.isFinite(semOsFimJornadaMin) && retornoBaseAvg > 0 ? round2(semOsFimJornadaMin) : undefined,
            global_avg_min: semOsFimAboveThreshold && retornoBaseAvg > 0 ? round2(retornoBaseAvg) : undefined,
          };
          const fimInicioIntervalo = semOsFimHasIntervalInWindow && inicioIntervaloCol ? String(lastRow[inicioIntervaloCol] ?? '').trim() : '';
          const fimFimIntervalo    = semOsFimHasIntervalInWindow && fimIntervaloCol    ? String(lastRow[fimIntervaloCol]    ?? '').trim() : '';
          const fimDeslDetail: NonNullable<UtilizacaoOrderEvidence['sem_os_details']>[number] | null = fimDeslAbove
            ? {
                type: 'intervalo_deslocamento',
                min:  round2(semOsFimDeslIntervalMin),
                from: liberadaStr,
                to:   fimInicioIntervalo || undefined,
                from_label: 'Liberada',
              }
            : null;

          const existingEvidence = evidences.find((e) => e.nr_ordem === lastNrOrdem);
          if (existingEvidence) {
            const details = existingEvidence.sem_os_details ?? [];
            details.push(fimDetail);
            if (fimDeslDetail) details.push(fimDeslDetail);
            existingEvidence.sem_os_details = details;
            if (semOsAbove) {
              // Only Desl. Intervalo counts toward ociosidade total
              const semOsOnlyDetails = details.filter((d) => d.type !== 'fim_jornada');
              existingEvidence.sem_os_total_min = round2(semOsOnlyDetails.reduce((s, d) => s + d.min, 0));
              if (!existingEvidence.flags.includes('sem_os_alto')) existingEvidence.flags.push('sem_os_alto');
            }
            if (semOsFimAboveThreshold && !existingEvidence.flags.includes('antes_log_off_alto')) {
              existingEvidence.flags.push('antes_log_off_alto');
            }
            // Show interval chip when interval is in the fim window
            if (semOsFimHasIntervalInWindow && !existingEvidence.inicio_intervalo) {
              existingEvidence.inicio_intervalo = fimInicioIntervalo;
              existingEvidence.fim_intervalo    = fimFimIntervalo;
            }
          } else if (semOsAbove || semOsFimAboveThreshold) {
            const i = ordered.length - 1;
            const row = lastRow;
            const trOrdemMin = trOrdemCol ? (parseNumber(String(row[trOrdemCol] ?? '')) ?? 0) : 0;
            const tlOrdemMin = tlOrdemCol ? (parseNumber(String(row[tlOrdemCol] ?? '')) ?? 0) : 0;
            const hdTotalMin = hdTotalCol ? (parseNumber(String(row[hdTotalCol] ?? '')) ?? 0) : 0;
            const hdPctTr = hdTotalMin > 0 ? round2((trOrdemMin / hdTotalMin) * 100) : 0;
            const hdPctTl = hdTotalMin > 0 ? round2((tlOrdemMin / hdTotalMin) * 100) : 0;
            const tempoPadraoRaw = tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) : null;
            const prevRow = i > 0 ? ordered[i - 1] : null;
            const allFimDetails = [fimDetail, ...(fimDeslDetail ? [fimDeslDetail] : [])];
            evidences.push({
              date_ref:          dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
              nr_ordem:          lastNrOrdem,
              classe:            classeCol ? String(row[classeCol] ?? '').trim() : '',
              causa:             causaCol  ? String(row[causaCol]  ?? '').trim() : '',
              despachada:        despachadaCol ? String(row[despachadaCol] ?? '').trim() : '',
              a_caminho:         String(row[caminhoCol] ?? '').trim(),
              no_local:          noLocalCol ? String(row[noLocalCol] ?? '').trim() : '',
              liberada:          liberadaCol  ? String(row[liberadaCol]  ?? '').trim() : '',
              inicio_intervalo:  fimInicioIntervalo,
              fim_intervalo:     fimFimIntervalo,
              prev_liberada:     prevRow && liberadaCol    ? String(prevRow[liberadaCol]    ?? '').trim() : undefined,
              prev_nr_ordem:     prevRow && nrOrdemCol     ? String(prevRow[nrOrdemCol]     ?? '').trim() : undefined,
              prev_despachada:   prevRow && despachadaCol  ? String(prevRow[despachadaCol]  ?? '').trim() : undefined,
              inicio_calendario: inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
              log_in:            logInCorrigidoCol   ? String(row[logInCorrigidoCol]   ?? '').trim() || undefined : undefined,
              tr_ordem_min:      round2(trOrdemMin),
              tl_ordem_min:      round2(tlOrdemMin),
              hd_total_min:      round2(hdTotalMin),
              hd_pct_tr:         hdPctTr,
              hd_pct_tl:         hdPctTl,
              tempo_padrao_min:  tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) ? round2(tempoPadraoRaw) : undefined,
              sem_os_details:    allFimDetails,
              sem_os_total_min:  semOsAbove ? round2(allFimDetails.filter((d) => d.type !== 'fim_jornada').reduce((s, d) => s + d.min, 0)) : undefined,
              flags:             [
                ...(semOsAbove ? ['sem_os_alto' as const] : []),
                ...(semOsFimAboveThreshold ? ['antes_log_off_alto' as const] : []),
                ...((hdTotalMin > 0 && trOrdemMin > hdTotalMin * OS_DIA_PCT_THRESHOLD) ? ['tr_excede_hd' as const] : []),
              ],
            });
          } else {
            // Below threshold: inject fimDetail into the basic order so timeline shows Log Off
            const basicOrders = teamAllBasicUtil.get(team) ?? [];
            const basicOrder = basicOrders.find((o) => o.nr_ordem === lastNrOrdem);
            if (basicOrder) {
              basicOrder.sem_os_details = (basicOrder.sem_os_details ?? []).concat(fimDetail);
            }
          }
        }
      }
      teamEvidences.set(team, evidences);
    }

    // Build result
    const distinctDates = dateCol ? countDistinctDates(deslocRows, dateCol) : 0;
    const result: UtilizacaoTeamAnalysis[] = [];
    for (const [team, utilizacaoValue] of underPerforming.entries()) {
      if (!Array.from(grouped.values()).some((g) => g.team === team)) continue;

      const flaggedOrders = mergeEvidenceFlags(teamEvidences.get(team) ?? []);
      const allBasic = teamAllBasicUtil.get(team) ?? [];
      const flaggedUtilByKey = new Map(flaggedOrders.map(o => [o.nr_ordem || `${o.despachada}|${o.a_caminho}`, o]));
      const seenExtra = new Set<string>();
      const allMerged: UtilizacaoOrderEvidence[] = [];
      for (const o of allBasic) {
        const key = o.nr_ordem || `${o.despachada}|${o.a_caminho}`;
        if (!seenExtra.has(key)) {
          seenExtra.add(key);
          allMerged.push(flaggedUtilByKey.get(key) ?? o);
        }
      }

      // Ordenação estritamente decrescente pelo tempo total ocioso
      allMerged.sort((a, b) => {
        const idleA = (a.ocioso_min ?? 0) + (a.temp_prep_os_min ?? 0) + (a.sem_os_total_min ?? 0);
        const idleB = (b.ocioso_min ?? 0) + (b.temp_prep_os_min ?? 0) + (b.sem_os_total_min ?? 0);
        return idleB - idleA;
      });

      const finalFlagged: UtilizacaoOrderEvidence[] = [];
      const finalExtra: UtilizacaoOrderEvidence[] = [];

      for (const o of allMerged) {
        if (finalFlagged.length < 10 && (o.flags?.length ?? 0) > 0) {
          finalFlagged.push(o);
        } else if (finalFlagged.length + finalExtra.length < 50) {
          finalExtra.push(o);
        }
      }

      const enrichedFlaggedOrders = enrichUtilizacaoEvidence(finalFlagged);
      const extraEnrichedFlaggedOrders = enrichUtilizacaoEvidence(finalExtra);
      const hdEntry       = teamHdTotals.get(team);
      const dayCount      = teamDayCount.get(team) ?? (hdEntry ? hdEntry.count : 1);
      const avgHdTotal    = hdEntry ? round2(hdEntry.sum / hdEntry.count) : 0;
      const totalOrders   = teamTotalOrders.get(team) ?? 0;
      const tempPrepTotal = round2((teamTempPrepSum.get(team) ?? 0) / dayCount);
      const semOrdemTotal = round2((teamSemOrdemSum.get(team) ?? 0) / dayCount);

      const idleMin = round2(tempPrepTotal + semOrdemTotal);
      const idlePct = avgHdTotal > 0 ? round2((idleMin / avgHdTotal) * 100) : 0;
      const allDailyIdles = teamDailyIdles.get(team) ?? [];
      const totalIdleSum  = allDailyIdles.reduce((a, b) => a + b, 0);
      const simpleAvgIdle = dayCount > 0 ? totalIdleSum / dayCount : 0;
      const aboveAvgIdles = allDailyIdles.filter((v) => v >= simpleAvgIdle);
      const idleDays    = aboveAvgIdles.length;
      const idleAvgMin  = idleDays > 0
        ? round2(aboveAvgIdles.reduce((a, b) => a + b, 0) / idleDays)
        : 0;
      const idleAnalysis: UtilizacaoTeamAnalysis['idleAnalysis'] =
        avgHdTotal > 0 && idlePct >= IDLE_THRESHOLD_PCT
          ? { idleMin, idlePct, horasExtras: round2((teamHorasExtrasSum.get(team) ?? 0) / dayCount) }
          : undefined;

      const allJornadas = teamJornadas.get(team) ?? [];
      const jornadasAbaixoMeta = allJornadas.filter(
        (j) => j.hdTotalMin > 0 && (j.htTotalMin / j.hdTotalMin) * 100 < UTIL_META,
      ).length;

      result.push({
        team,
        utilizacaoValue:  round2(utilizacaoValue),
        metaTarget:       UTIL_META,
        gap:              round2(UTIL_META - utilizacaoValue),
        hdTotalMin:       avgHdTotal,
        tempPrepTotalMin: tempPrepTotal,
        semOrdemTotalMin: semOrdemTotal,
        totalOrders,
        totalJornadas:    allJornadas.length,
        idleDays,
        idleAvgMin,
        jornadasAbaixoMeta,
        flaggedOrders: enrichedFlaggedOrders,
        extraFlaggedOrders: extraEnrichedFlaggedOrders,
        summary: {
          countTempPrepAlto: enrichedFlaggedOrders.filter((e) => e.flags.includes('temp_prep_alto')).length,
          countSemOsAlto:    enrichedFlaggedOrders.filter((e) => e.flags.includes('sem_os_alto')).length,
        },
        idleAnalysis,
      });
    }

    return result.sort((a, b) => {
      if (a.utilizacaoValue !== b.utilizacaoValue) return a.utilizacaoValue - b.utilizacaoValue;
      const aAlerts = a.summary.countTempPrepAlto + a.summary.countSemOsAlto;
      const bAlerts = b.summary.countTempPrepAlto + b.summary.countSemOsAlto;
      return bAlerts - aAlerts;
    }).slice(0, 3);
  }

  // ─── TME IMP Analyzer ─────────────────────────────────────────────────────
