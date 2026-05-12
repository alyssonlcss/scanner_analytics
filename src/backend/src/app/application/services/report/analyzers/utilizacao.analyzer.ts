import type { CsvRow } from '../csv-utils.js';
import type { UtilizacaoTeamAnalysis, UtilizacaoOrderEvidence, KpiInsight } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, round2, parseDateTimeBr, minutesBetween } from '../csv-utils.js';
import { calculateTempPrepValue, calculateSemOsValue } from '../builders/team-stats.builder.js';
import { selectTopUtilizacaoEvidences } from './os-dia.analyzer.js';

import { countDistinctDates, mergeEvidenceFlags } from './os-dia.analyzer.js';
export function analyzeUtilizacao(deslocRows: CsvRow[], kpis: KpiInsight[]): UtilizacaoTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const UTIL_META = 85;
    const IDLE_THRESHOLD_PCT = 15;
    const OS_DIA_PCT_THRESHOLD = 0.20;
    const TEMP_PREP_THRESHOLD_MIN = 10;
    const TEMP_PREP_THRESHOLD_FIRST_MIN = 25;
    const SEM_OS_THRESHOLD_MIN = 10;

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
      const semOsValues: number[]    = [];
      const semOsIntervalApplied: boolean[] = [];
      let isInterACaminho = false;
      let isInterOrdem    = false;

      tempPrepValues.push(firstDeslocCol   ? (parseNumber(String(firstRow[firstDeslocCol]   ?? '')) ?? Number.NaN) : Number.NaN);
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

      // SemOrdem: gap between last Liberada and Log Off Corrigido
      const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
      let semOsFimJornadaMin = Number.NaN;
      let semOsFimIntervalDiscounted = false;
      let semOsFimRetornoBaseDiscount = 0;
      let semOsFimRetornoBaseUsedRow = false;
      if (logOffCorrigidoCol && liberadaCol) {
        const lastRow = ordered[ordered.length - 1];
        const lastLiberada = parseDateTimeBr(String(lastRow[liberadaCol] ?? ''));
        const logOff = parseDateTimeBr(String(lastRow[logOffCorrigidoCol] ?? ''));
        if (lastLiberada && logOff && logOff.getTime() > lastLiberada.getTime()) {
          let gapMin = minutesBetween(logOff, lastLiberada);
          const intStart = inicioIntervaloCol ? parseDateTimeBr(String(lastRow[inicioIntervaloCol] ?? '')) : null;
          const intEnd   = fimIntervaloCol    ? parseDateTimeBr(String(lastRow[fimIntervaloCol]    ?? '')) : null;
          if (!isInterOrdem && intStart && intEnd &&
              intStart.getTime() >= lastLiberada.getTime() &&
              intEnd.getTime() <= logOff.getTime()) {
            const intDuration = minutesBetween(intEnd, intStart);
            gapMin -= Math.min(intDuration, 60);           // discount up to 60 min
            if (intDuration > 60) gapMin += (intDuration - 60); // excess over 60 is penalized
            semOsFimIntervalDiscounted = true;
          }
          // Subtract Retorno a Base: use row value if present, otherwise fall back to average
          const retornoBaseRow = retornoBaseCol ? parseNumber(String(lastRow[retornoBaseCol] ?? '')) : null;
          const retornoBaseDiscount = (retornoBaseRow !== null && Number.isFinite(retornoBaseRow) && retornoBaseRow > 0)
            ? retornoBaseRow
            : retornoBaseAvg;
          if (retornoBaseDiscount > 0) {
            gapMin -= retornoBaseDiscount;
            semOsFimRetornoBaseDiscount = retornoBaseDiscount;
            semOsFimRetornoBaseUsedRow = retornoBaseRow !== null && Number.isFinite(retornoBaseRow) && retornoBaseRow > 0;
          }
          if (gapMin > 0) {
            semOsFimJornadaMin = gapMin;
            semOsValues.push(gapMin);
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
        const tempPrepThreshold = (i === 0) ? TEMP_PREP_THRESHOLD_FIRST_MIN : TEMP_PREP_THRESHOLD_MIN;
        if (Number.isFinite(tempPrepOs) && tempPrepOs >= tempPrepThreshold) flags.push('temp_prep_alto');
        if (Number.isFinite(semOsMin) && semOsMin >= SEM_OS_THRESHOLD_MIN) flags.push('sem_os_alto');

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

        const uniqueFlags = [...new Set(flags)] as UtilizacaoOrderEvidence['flags'];
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
            });
          } else {
            const prevDespStr = prevRow && despachadaCol ? String(prevRow[despachadaCol] ?? '').trim() || undefined : undefined;
            const prevDespDate = prevDespStr ? parseDateTimeBr(prevDespStr) : null;
            const prevLibStr  = prevRow && liberadaCol  ? String(prevRow[liberadaCol]  ?? '').trim() || undefined : undefined;
            const prevLibDate  = prevLibStr  ? parseDateTimeBr(prevLibStr)  : null;
            const despachadaDate = despachadaCol ? parseDateTimeBr(String(row[despachadaCol] ?? '')) : null;
            // When the interval started before the dispatch (interceptsDispatch case), Início Intervalo
            // is the first event after Lib. Anterior — prioritize intervalo_deslocamento over entre_ordens.
            if (
              hasIntervaloDeslocamento &&
              semOsIntervalApplied[i] &&
              inicioIntervaloDate &&
              despachadaDate &&
              inicioIntervaloDate.getTime() < despachadaDate.getTime()
            ) {
              const overPct = globalAvgIntervaloDeslocMin > 0 && intervaloDeslocMin !== null
                ? round2(((intervaloDeslocMin - globalAvgIntervaloDeslocMin) / globalAvgIntervaloDeslocMin) * 100)
                : undefined;
              semOsDetails.push({
                type: 'intervalo_deslocamento',
                min:  round2(semOsMin),
                from: prevLibStr,
                to:   inicioIntervaloRaw || undefined,
                global_avg_min: globalAvgIntervaloDeslocMin > 0 ? round2(globalAvgIntervaloDeslocMin) : undefined,
                above_avg_pct: overPct,
              });
            } else {
              semOsDetails.push({
                type: 'entre_ordens',
                min:  round2(semOsMin),
                from: prevLibStr,
                to:   despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined,
                interval_discounted: semOsIntervalApplied[i] || undefined,
                desp_anterior: (prevDespDate && prevLibDate && prevDespDate.getTime() > prevLibDate.getTime()) ? prevDespStr : undefined,
              });
            }
          }
        }
        // Skip intervalo_deslocamento when the interval was already absorbed into entre_ordens
        // (semOsIntervalApplied[i] === true), to avoid two sub-flags pointing to the same time window.
        if (intervaloDeslocAboveGlobalAvg && intervaloDeslocMin !== null && !semOsIntervalApplied[i]) {
          const overPct = globalAvgIntervaloDeslocMin > 0
            ? round2(((intervaloDeslocMin - globalAvgIntervaloDeslocMin) / globalAvgIntervaloDeslocMin) * 100)
            : undefined;
          semOsDetails.push({
            type: 'intervalo_deslocamento',
            min:  intervaloDeslocMin,
            from: prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined,
            to:   inicioIntervaloRaw || undefined,
            global_avg_min: globalAvgIntervaloDeslocMin > 0 ? round2(globalAvgIntervaloDeslocMin) : undefined,
            above_avg_pct: overPct,
          });
        }

        const semOsTotalMin = semOsDetails.length > 0 ? round2(semOsDetails.reduce((s, d) => s + d.min, 0)) : undefined;

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
          sem_os_details:    semOsDetails.length > 0 ? semOsDetails : undefined,
          sem_os_total_min:  semOsTotalMin,
          flags:             uniqueFlags,
        });
      }

      // Add fim de jornada to the last order's evidence
      const fimJornadaThreshold = retornoBaseAvg > 0 ? retornoBaseAvg * 0.15 : SEM_OS_THRESHOLD_MIN;
      if (Number.isFinite(semOsFimJornadaMin) && semOsFimJornadaMin >= fimJornadaThreshold) {
        const lastRow = ordered[ordered.length - 1];
        const lastNrOrdem = nrOrdemCol ? String(lastRow[nrOrdemCol] ?? '').trim() : '';
        const logOffStr  = logOffCorrigidoCol ? String(lastRow[logOffCorrigidoCol] ?? '').trim() : undefined;
        const liberadaStr = liberadaCol ? String(lastRow[liberadaCol] ?? '').trim() : undefined;
        const fimDetail: NonNullable<UtilizacaoOrderEvidence['sem_os_details']>[number] = {
          type: 'fim_jornada',
          min:  round2(semOsFimJornadaMin),
          from: liberadaStr || undefined,
          to:   logOffStr || undefined,
          interval_discounted: semOsFimIntervalDiscounted || undefined,
          retorno_base_discounted: semOsFimRetornoBaseDiscount > 0 ? round2(semOsFimRetornoBaseDiscount) : undefined,
          retorno_base_used_row:   semOsFimRetornoBaseUsedRow || undefined,
        };

        const existingEvidence = evidences.find((e) => e.nr_ordem === lastNrOrdem);
        const fimInicioIntervalo = semOsFimIntervalDiscounted && inicioIntervaloCol ? String(lastRow[inicioIntervaloCol] ?? '').trim() : '';
        const fimFimIntervalo    = semOsFimIntervalDiscounted && fimIntervaloCol    ? String(lastRow[fimIntervaloCol]    ?? '').trim() : '';
        if (existingEvidence) {
          const details = existingEvidence.sem_os_details ?? [];
          details.push(fimDetail);
          existingEvidence.sem_os_details = details;
          existingEvidence.sem_os_total_min = round2(details.reduce((s, d) => s + d.min, 0));
          if (!existingEvidence.flags.includes('sem_os_alto')) existingEvidence.flags.push('sem_os_alto');
          // Show interval chip if discounted from fim_jornada window
          if (semOsFimIntervalDiscounted && !existingEvidence.inicio_intervalo) {
            existingEvidence.inicio_intervalo = fimInicioIntervalo;
            existingEvidence.fim_intervalo    = fimFimIntervalo;
          }
        } else {
          const i = ordered.length - 1;
          const row = lastRow;
          const trOrdemMin = trOrdemCol ? (parseNumber(String(row[trOrdemCol] ?? '')) ?? 0) : 0;
          const tlOrdemMin = tlOrdemCol ? (parseNumber(String(row[tlOrdemCol] ?? '')) ?? 0) : 0;
          const hdTotalMin = hdTotalCol ? (parseNumber(String(row[hdTotalCol] ?? '')) ?? 0) : 0;
          const hdPctTr = hdTotalMin > 0 ? round2((trOrdemMin / hdTotalMin) * 100) : 0;
          const hdPctTl = hdTotalMin > 0 ? round2((tlOrdemMin / hdTotalMin) * 100) : 0;
          const tempoPadraoRaw = tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) : null;
          const prevRow = i > 0 ? ordered[i - 1] : null;
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
            sem_os_details:    [fimDetail],
            sem_os_total_min:  round2(semOsFimJornadaMin),
            flags:             ['sem_os_alto'],
          });
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
        flaggedOrders: distinctDates > 7 ? selectTopUtilizacaoEvidences(flaggedOrders) : flaggedOrders,
        summary: {
          countTempPrepAlto: flaggedOrders.filter((e) => e.flags.includes('temp_prep_alto')).length,
          countSemOsAlto:    flaggedOrders.filter((e) => e.flags.includes('sem_os_alto')).length,
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
