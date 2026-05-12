// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import type { CsvRow } from '../csv-utils.js';
import type { OsDiaTeamAnalysis, OsDiaOrderEvidence, UtilizacaoOrderEvidence, KpiInsight } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, parseDateTimeBr, minutesBetween, applyIntervalDiscount, round2, safeSum } from '../csv-utils.js';
import { nfBr, semOsDetailText, enrichOsDiaEvidence } from './enrich-utils.js';
import { calculateTempPrepValue, calculateSemOsValue } from '../builders/team-stats.builder.js';
import { KPI_ALIASES } from '../constants.js';

export function analyzeOsDia(deslocRows: CsvRow[], rankingRows: CsvRow[], kpis: KpiInsight[]): OsDiaTeamAnalysis[] {
    if (deslocRows.length === 0 || rankingRows.length === 0) {
      return [];
    }

    const OS_DIA_META = 4.4;
    const OS_DIA_PCT_THRESHOLD = 0.20;
    const TEMP_PREP_THRESHOLD_MIN      = 10; // demais OS: Lib.Anterior → A Caminho
    const TEMP_PREP_THRESHOLD_FIRST_MIN = 25; // 1ª OS da jornada: Início Calendário → A Caminho
    const SEM_OS_THRESHOLD_MIN = 10;
    const TOLERANCE_MIN = 5; // invisible grace margin — keeps displayed limits unchanged

    // 1. Determine under-performing teams from ranking (average OS/Dia < meta)
    const rankAcc = createAccessor(rankingRows[0]);
    const rankTeamCol = rankAcc.resolve(['Equipe', 'Team', 'Equipe Nome']);
    const rankOsDiaCol = rankAcc.resolve(KPI_ALIASES['OS Dia'] ?? []);

    if (!rankTeamCol || !rankOsDiaCol) {
      return [];
    }

    const teamOsDiaTotals = new Map<string, { sum: number; count: number }>();
    for (const row of rankingRows) {
      const team = String(row[rankTeamCol] ?? '').trim();
      const value = parseNumber(String(row[rankOsDiaCol] ?? ''));
      if (team && value !== null && Number.isFinite(value)) {
        const entry = teamOsDiaTotals.get(team) ?? { sum: 0, count: 0 };
        entry.sum += value;
        entry.count += 1;
        teamOsDiaTotals.set(team, entry);
      }
    }

    // Use the same 3 worst teams from the OS Dia KPI ranking opportunityTeams.
    // Fall back to all-below-meta if no KPI insight is available.
    const osDiaInsight = kpis.find((k) => k.kpi === 'OS Dia');
    const underPerforming = new Map<string, number>();
    if (osDiaInsight && osDiaInsight.opportunityTeams.length > 0) {
      for (const t of osDiaInsight.opportunityTeams) {
        underPerforming.set(t.team, t.value);
      }
    } else {
      for (const [team, { sum, count }] of teamOsDiaTotals.entries()) {
        const avg = sum / count;
        if (avg < OS_DIA_META) {
          underPerforming.set(team, avg);
        }
      }
    }

    if (underPerforming.size === 0) {
      return [];
    }

    // 2. Resolve deslocamento columns
    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol = deslocAcc.resolve(['Equipe']);
    const dateCol = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const caminhoCol = deslocAcc.resolve(['A_Caminho', 'A Caminho']);
    const despachadaCol = deslocAcc.resolve(['Despachada']);
    const liberadaCol = deslocAcc.resolve(['Liberada']);
    const firstDeslocCol = deslocAcc.resolve(['1º Desloc', '1o Desloc']);
    const firstDespachoCol = deslocAcc.resolve(['1º Despacho', '1o Despacho']);
    const intervaloCol = deslocAcc.resolve(['Intervalo']);
    const inicioIntervaloCol = deslocAcc.resolve(['Inicio Intervalo', 'Início Intervalo']);
    const fimIntervaloCol = deslocAcc.resolve(['Fim Intervalo']);
    const nrOrdemCol = deslocAcc.resolve(['Nr_Ordem', 'Nr Ordem', 'Numero Ordem']);
    const classeCol = deslocAcc.resolve(['CLASSE', 'Classe']);
    const causaCol = deslocAcc.resolve(['CAUSA', 'Causa']);
    const noLocalCol = deslocAcc.resolve(['No_Local', 'No Local']);
    const trOrdemCol     = deslocAcc.resolve(['TR Ordem', 'TR_Ordem']);
    const tlOrdemCol     = deslocAcc.resolve(['TL Ordem', 'TL_Ordem']);
    const hdTotalCol     = deslocAcc.resolve(['HD Total', 'HD_Total']);
    const tempoPadraoCol      = deslocAcc.resolve(['tempo_padrao', 'Tempo Padrao', 'Tempo_Padrao', 'TempoPadrao']);
    const inicioCalendarioCol  = deslocAcc.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
    const logInCorrigidoCol    = deslocAcc.resolve(['Log In Corrigido', 'LogIn Corrigido', 'Login Corrigido']);
    const logOffCorrigidoCol2  = deslocAcc.resolve(['Log Off Corrigido', 'LogOff Corrigido']);
    const retornoBaseCol       = deslocAcc.resolve(['Retorno a base', 'Retorno a Base', 'Retorno Base']);
    const horasExtrasCol       = deslocAcc.resolve(['Horas Extras', 'Horas extras']);

    if (!teamCol || !dateCol || !caminhoCol || !despachadaCol || !liberadaCol) {
      return [];
    }

    // 2b. Compute global average TL across ALL rows (used as threshold reference for tl_excede_hd)
    let globalTlSum = 0;
    let globalTlCount = 0;
    if (tlOrdemCol) {
      for (const row of deslocRows) {
        const v = parseNumber(String(row[tlOrdemCol] ?? ''));
        if (v !== null && Number.isFinite(v) && v > 0) {
          globalTlSum += v;
          globalTlCount++;
        }
      }
    }
    const globalAvgTlMin = globalTlCount > 0 ? round2(globalTlSum / globalTlCount) : 0;
    // Flag TL when it exceeds 25% above the global average (not % of HD)
    const TL_ABOVE_AVG_THRESHOLD = 1.25;

    // 3. Group by team+date, under-performing teams only
    const grouped = new Map<string, { team: string; rows: CsvRow[] }>();
    for (const row of deslocRows) {
      const team = String(row[teamCol] ?? '').trim();
      if (!underPerforming.has(team)) {
        continue;
      }
      const date = String(row[dateCol] ?? '').trim();
      const key = `${team}::${date}`;
      const entry = grouped.get(key) ?? { team, rows: [] };
      entry.rows.push(row);
      grouped.set(key, entry);
    }

    // 4. Collect evidence per team and accumulate HD totals
    const teamEvidences = new Map<string, OsDiaOrderEvidence[]>();
    const teamHdTotals = new Map<string, { sum: number; count: number }>();
    const teamTotalOrders = new Map<string, number>();
    const teamTempPrepSum = new Map<string, number>();
    const teamSemOrdemSum = new Map<string, number>();
    const teamDayCount = new Map<string, number>();
    const teamDailyIdles = new Map<string, number[]>();
    const teamHorasExtrasSum = new Map<string, number>();

    for (const { team, rows: groupRows } of grouped.values()) {
      teamDayCount.set(team, (teamDayCount.get(team) ?? 0) + 1);
      // sort by A_Caminho ascending (same logic as calculateTempPrepSemOs)
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

      // First order: TempPrep from 1º Desloc, SemOS from 1º Despacho (raw spreadsheet value)
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
        if (tempPrep.intervalApplied) {
          isInterACaminho = true;
        }
        tempPrepValues.push(tempPrep.value);

        const semOs = calculateSemOsValue({
          despachada, liberada,
          inicioIntervalo: semOsIntervalStart,
          fimIntervalo:    semOsIntervalEnd,
          intervaloMinutes: firstIntervalMinutes,
          isIntervalAlreadyApplied: isInterOrdem,
        });
        if (semOs.intervalApplied) {
          isInterOrdem = true;
        }
        semOsValues.push(semOs.value);
        semOsIntervalApplied.push(semOs.intervalApplied);
      }

      // SemOrdem: gap between last order's Liberada and Log Off Corrigido, minus 60min interval and retorno base avg
      const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
      let semOsFimJornadaMin = Number.NaN;
      let semOsFimIntervalDiscounted = false;
      let semOsFimRetornoBaseDiscount = 0;
      let semOsFimRetornoBaseUsedRow = false;
      if (logOffCorrigidoCol2 && liberadaCol) {
        const lastRow = ordered[ordered.length - 1];
        const lastLiberada = parseDateTimeBr(String(lastRow[liberadaCol] ?? ''));
        const logOff = parseDateTimeBr(String(lastRow[logOffCorrigidoCol2] ?? ''));
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

      // Accumulate HD Total
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

      // Accumulate TempPrep and SemOrdem per team
      for (const v of tempPrepValues) {
        if (Number.isFinite(v) && v > 0) {
          teamTempPrepSum.set(team, (teamTempPrepSum.get(team) ?? 0) + v);
        }
      }
      for (const v of semOsValues) {
        if (Number.isFinite(v) && v > 0) {
          teamSemOrdemSum.set(team, (teamSemOrdemSum.get(team) ?? 0) + v);
        }
      }
      const dayIdleTotal =
        tempPrepValues.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0) +
        semOsValues.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0);
      if (dayIdleTotal > 0) {
        const arr = teamDailyIdles.get(team) ?? [];
        arr.push(dayIdleTotal);
        teamDailyIdles.set(team, arr);
      }

      // Accumulate total order count for this team
      teamTotalOrders.set(team, (teamTotalOrders.get(team) ?? 0) + ordered.length);

      // Accumulate Horas Extras (per-jornada value — same for all OS in the group)
      if (horasExtrasCol) {
        const heVal = parseNumber(String(firstRow[horasExtrasCol] ?? ''));
        if (heVal !== null && Number.isFinite(heVal) && heVal > 0) {
          teamHorasExtrasSum.set(team, (teamHorasExtrasSum.get(team) ?? 0) + heVal);
        }
      }

      // Build evidence for flagged orders
      const evidences = teamEvidences.get(team) ?? [];
      for (let i = 0; i < ordered.length; i++) {
        const row     = ordered[i];
        const prevRow = i > 0 ? ordered[i - 1] : null;

        const trOrdemMin    = trOrdemCol     ? (parseNumber(String(row[trOrdemCol]     ?? '')) ?? 0)    : 0;
        const tlOrdemMin    = tlOrdemCol     ? (parseNumber(String(row[tlOrdemCol]     ?? '')) ?? 0)    : 0;
        const hdTotalMin    = hdTotalCol     ? (parseNumber(String(row[hdTotalCol]     ?? '')) ?? 0)    : 0;
        const tempoPadraoRaw = tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) : null;
        const tempPrepOs = tempPrepValues[i] ?? Number.NaN;
        const semOsMin   = semOsValues[i]    ?? Number.NaN;

        const hdPctTr = hdTotalMin > 0 ? round2((trOrdemMin / hdTotalMin) * 100) : 0;
        const hdPctTl = hdTotalMin > 0 ? round2((tlOrdemMin / hdTotalMin) * 100) : 0;

        const flags: OsDiaOrderEvidence['flags'] = [];
        if (hdTotalMin > 0 && trOrdemMin > hdTotalMin * OS_DIA_PCT_THRESHOLD) {
          flags.push('tr_excede_hd');
        }
        if (globalAvgTlMin > 0 && tlOrdemMin > globalAvgTlMin * TL_ABOVE_AVG_THRESHOLD) {
          flags.push('tl_excede_hd');
        }
        const tempPrepThreshold = (i === 0) ? TEMP_PREP_THRESHOLD_FIRST_MIN : TEMP_PREP_THRESHOLD_MIN;
        if (Number.isFinite(tempPrepOs) && tempPrepOs >= tempPrepThreshold + TOLERANCE_MIN) {
          flags.push('temp_prep_alto');
        }
        if (Number.isFinite(semOsMin) && semOsMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
          flags.push('sem_os_alto');
        }

        // Detect intervalo_deslocamento: interval between prev Liberada and current A Caminho
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
        if (hasIntervaloDeslocamento && inicioIntervaloDate && prevLiberadaDate) {
          const intDurMin = round2(minutesBetween(inicioIntervaloDate, prevLiberadaDate));
          if (intDurMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
            flags.push('sem_os_alto');
          }
        }

        // Remove duplicate flags
        const uniqueFlags = [...new Set(flags)] as OsDiaOrderEvidence['flags'];

        if (uniqueFlags.length === 0) {
          continue;
        }

        // Only include interval if it falls within [prev_liberada, liberada_atual]
        const intervaloNaJanela = Boolean(
          inicioIntervaloDate &&
          liberadaAtualDate &&
          inicioIntervaloDate.getTime() <= liberadaAtualDate.getTime() &&
          (prevLiberadaDate === null || inicioIntervaloDate.getTime() >= prevLiberadaDate.getTime()),
        );

        // Build sem_os_details
        const semOsDetails: NonNullable<OsDiaOrderEvidence['sem_os_details']> = [];
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
              semOsDetails.push({
                type: 'intervalo_deslocamento',
                min:  round2(semOsMin),
                from: prevLibStr,
                to:   inicioIntervaloRaw || undefined,
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
        // Only add intervalo_deslocamento when the interval was NOT already absorbed into the entre_ordens
        // discount (semOsIntervalApplied[i] === true). When interceptsDispatch or insideTolerance fires,
        // calculateSemOsValue returns minutesBetween(inicioIntervalo, prevLiberada), which is the exact same
        // window that intervalo_deslocamento would report — causing two sub-flags to point to the same time.
        if (hasIntervaloDeslocamento && inicioIntervaloDate && prevLiberadaDate && !semOsIntervalApplied[i]) {
          const intMin = round2(minutesBetween(inicioIntervaloDate, prevLiberadaDate));
          if (intMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
            semOsDetails.push({
              type: 'intervalo_deslocamento',
              min:  intMin,
              from: prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined,
              to:   inicioIntervaloRaw || undefined,
            });
          }
        }

        const semOsTotalMin = semOsDetails.length > 0 ? round2(semOsDetails.reduce((s, d) => s + d.min, 0)) : undefined;

        evidences.push({
          source:           'Scanner 4.4 - CE M300',
          date_ref:          dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
          nr_ordem:          nrOrdemCol ? String(row[nrOrdemCol] ?? '').trim()         : '',
          classe:            classeCol  ? String(row[classeCol]  ?? '').trim()         : '',
          causa:             causaCol   ? String(row[causaCol]   ?? '').trim()         : '',
          despachada:        despachadaCol        ? String(row[despachadaCol]        ?? '').trim() : '',
          a_caminho:                       String(row[caminhoCol]                     ?? '').trim(),
          no_local:          noLocalCol   ? String(row[noLocalCol]   ?? '').trim()    : '',
          liberada:          liberadaCol  ? String(row[liberadaCol]  ?? '').trim()    : '',
          inicio_intervalo:  intervaloNaJanela ? inicioIntervaloRaw : '',
          fim_intervalo:     intervaloNaJanela ? fimIntervaloRaw    : '',
          prev_liberada:     prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() : undefined,
          prev_nr_ordem:     prevRow && nrOrdemCol  ? String(prevRow[nrOrdemCol]  ?? '').trim() : undefined,
          prev_despachada:   prevRow && despachadaCol ? String(prevRow[despachadaCol] ?? '').trim() : undefined,
          inicio_calendario: inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
          log_in:            logInCorrigidoCol   ? String(row[logInCorrigidoCol]   ?? '').trim() || undefined : undefined,
          tr_ordem_min:      round2(trOrdemMin),
          tl_ordem_min:      round2(tlOrdemMin),
          hd_total_min:      round2(hdTotalMin),
          hd_pct_tr:         hdPctTr,
          hd_pct_tl:         hdPctTl,
          global_avg_tl_min: globalAvgTlMin,
          tempo_padrao_min:  tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) ? round2(tempoPadraoRaw) : undefined,
          temp_prep_os_min:  Number.isFinite(tempPrepOs) ? round2(tempPrepOs) : undefined,
          sem_os_details:    semOsDetails.length > 0 ? semOsDetails : undefined,
          sem_os_total_min:  semOsTotalMin,
          flags:             uniqueFlags,
        });
      }
      // Add fim de jornada to the last order's evidence
      const fimJornadaThreshold = retornoBaseAvg > 0 ? retornoBaseAvg * 0.15 : SEM_OS_THRESHOLD_MIN;
      if (Number.isFinite(semOsFimJornadaMin) && semOsFimJornadaMin >= fimJornadaThreshold + TOLERANCE_MIN) {
        const lastRow = ordered[ordered.length - 1];
        const lastNrOrdem = nrOrdemCol ? String(lastRow[nrOrdemCol] ?? '').trim() : '';
        const logOffStr = logOffCorrigidoCol2 ? String(lastRow[logOffCorrigidoCol2] ?? '').trim() : undefined;
        const liberadaStr = liberadaCol ? String(lastRow[liberadaCol] ?? '').trim() : undefined;
        const fimDetail: NonNullable<OsDiaOrderEvidence['sem_os_details']>[number] = {
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
          if (!existingEvidence.flags.includes('sem_os_alto')) {
            existingEvidence.flags.push('sem_os_alto');
          }
          // Show interval chip if discounted from fim_jornada window
          if (semOsFimIntervalDiscounted && !existingEvidence.inicio_intervalo) {
            existingEvidence.inicio_intervalo = fimInicioIntervalo;
            existingEvidence.fim_intervalo    = fimFimIntervalo;
          }
        } else {
          // Last order had no flags — create evidence entry with full info
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
            source:           'Scanner 4.4 - CE M300',
            date_ref:          dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
            nr_ordem:          lastNrOrdem,
            classe:            classeCol  ? String(row[classeCol]  ?? '').trim() : '',
            causa:             causaCol   ? String(row[causaCol]   ?? '').trim() : '',
            despachada:        despachadaCol ? String(row[despachadaCol] ?? '').trim() : '',
            a_caminho:         String(row[caminhoCol] ?? '').trim(),
            no_local:          noLocalCol ? String(row[noLocalCol] ?? '').trim() : '',
            liberada:          liberadaCol  ? String(row[liberadaCol]  ?? '').trim() : '',
            inicio_intervalo:  fimInicioIntervalo,
            fim_intervalo:     fimFimIntervalo,
            prev_liberada:     prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() : undefined,
            prev_nr_ordem:     prevRow && nrOrdemCol  ? String(prevRow[nrOrdemCol]  ?? '').trim() : undefined,
            prev_despachada:   prevRow && despachadaCol ? String(prevRow[despachadaCol] ?? '').trim() : undefined,
            inicio_calendario: inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
            log_in:            logInCorrigidoCol ? String(row[logInCorrigidoCol] ?? '').trim() || undefined : undefined,
            tr_ordem_min:      round2(trOrdemMin),
            tl_ordem_min:      round2(tlOrdemMin),
            hd_total_min:      round2(hdTotalMin),
            hd_pct_tr:         hdPctTr,
            hd_pct_tl:         hdPctTl,
            global_avg_tl_min: globalAvgTlMin,
            tempo_padrao_min:  tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) ? round2(tempoPadraoRaw) : undefined,
            sem_os_details:    [fimDetail],
            sem_os_total_min:  round2(semOsFimJornadaMin),
            flags:             ['sem_os_alto'],
          });
        }
      }
      teamEvidences.set(team, evidences);
    }

    // 5. Build result
    const distinctDates = dateCol ? countDistinctDates(deslocRows, dateCol) : 0;
    const result: OsDiaTeamAnalysis[] = [];
    for (const [team, osDiaValue] of underPerforming.entries()) {
      // Skip if no deslocamento rows found for this team
      if (!Array.from(grouped.values()).some((g) => g.team === team)) {
        continue;
      }

      const flaggedOrders = mergeEvidenceFlags(teamEvidences.get(team) ?? []);
      const prioritizedFlaggedOrders = enrichOsDiaEvidence(
        distinctDates > 7 ? selectTopOsDiaEvidences(flaggedOrders) : flaggedOrders,
      );
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
      const idleAnalysis: OsDiaTeamAnalysis['idleAnalysis'] =
        avgHdTotal > 0 && idlePct >= 10
          ? { idleMin, idlePct, horasExtras: round2((teamHorasExtrasSum.get(team) ?? 0) / dayCount) }
          : undefined;

      result.push({
        team,
        osDiaValue:  round2(osDiaValue),
        metaTarget:  OS_DIA_META,
        gap:         round2(OS_DIA_META - osDiaValue),
        hdTotalMin:  avgHdTotal,
        globalAvgTlMin,
        tempPrepTotalMin: tempPrepTotal,
        semOrdemTotalMin: semOrdemTotal,
        totalOrders,
        totalJornadas: dayCount,
        idleDays,
        idleAvgMin,
        flaggedOrders: prioritizedFlaggedOrders,
        summary: {
          countTrExceeds:    flaggedOrders.filter((e) => e.flags.includes('tr_excede_hd')).length,
          countTlExceeds:    flaggedOrders.filter((e) => e.flags.includes('tl_excede_hd')).length,
          countTempPrepAlto: flaggedOrders.filter((e) => e.flags.includes('temp_prep_alto')).length,
          countSemOsAlto:    flaggedOrders.filter((e) => e.flags.includes('sem_os_alto')).length,
        },
        idleAnalysis,
      });
    }

    return result.sort((a, b) => {
      // Primary: lowest OS/Dia first
      if (a.osDiaValue !== b.osDiaValue) return a.osDiaValue - b.osDiaValue;
      // Secondary: most total alerts first
      const aAlerts = a.summary.countTrExceeds + a.summary.countTlExceeds + a.summary.countTempPrepAlto + a.summary.countSemOsAlto;
      const bAlerts = b.summary.countTrExceeds + b.summary.countTlExceeds + b.summary.countTempPrepAlto + b.summary.countSemOsAlto;
      return bAlerts - aAlerts;
    }).slice(0, 3);
  }

  /**
   * Deduplicates an evidence array by nr_ordem/despachada+a_caminho key,
   * merging flags and sem_os_details of duplicate entries into one.
   */
export function mergeEvidenceFlags<T extends {
    nr_ordem: string;
    despachada: string;
    a_caminho: string;
    flags: string[];
    sem_os_details?: Array<{ type: string; min: number; [k: string]: unknown }>;
    sem_os_total_min?: number;
  }>(evidences: T[]): T[] {
    const map = new Map<string, T>();
    for (const ev of evidences) {
      const key = ev.nr_ordem || `${ev.despachada}|${ev.a_caminho}`;
      const existing = map.get(key);
      if (existing) {
        for (const flag of ev.flags) {
          if (!(existing.flags as string[]).includes(flag)) {
            (existing.flags as string[]).push(flag);
          }
        }
        if (ev.sem_os_details?.length) {
          existing.sem_os_details = [...(existing.sem_os_details ?? []), ...ev.sem_os_details] as T['sem_os_details'];
          existing.sem_os_total_min = (existing.sem_os_details ?? []).reduce((s, d) => s + d.min, 0);
        }
      } else {
        map.set(key, { ...ev, flags: [...ev.flags] as T['flags'] });
      }
    }
    return Array.from(map.values());
  }

export function countDistinctDates(rows: CsvRow[], dateCol: string): number {
    const dates = new Set<string>();
    for (const row of rows) {
      const d = String(row[dateCol] ?? '').trim();
      if (d) dates.add(d);
    }
    return dates.size;
  }

export function selectTopUtilizacaoEvidences(
    evidences: UtilizacaoOrderEvidence[],
    maxPerFlag = 2,
  ): UtilizacaoOrderEvidence[] {
    if (evidences.length === 0) return [];

    const selected = new Map<string, UtilizacaoOrderEvidence>();
    const flagOrder: Array<UtilizacaoOrderEvidence['flags'][number]> = ['temp_prep_alto', 'sem_os_alto'];

    for (const flag of flagOrder) {
      const topByFlag = evidences
        .filter((ev) => ev.flags.includes(flag))
        .sort((a, b) => {
          const scoreA = flag === 'temp_prep_alto' ? (a.temp_prep_os_min ?? 0) : (a.sem_os_total_min ?? 0);
          const scoreB = flag === 'temp_prep_alto' ? (b.temp_prep_os_min ?? 0) : (b.sem_os_total_min ?? 0);
          return scoreB - scoreA;
        })
        .slice(0, maxPerFlag);

      for (const ev of topByFlag) {
        const key = `${ev.nr_ordem}|${ev.despachada}|${ev.a_caminho}`;
        if (!selected.has(key)) {
          selected.set(key, ev);
        }
      }
    }

    return Array.from(selected.values())
      .sort((a, b) => {
        const scoreA = (a.temp_prep_os_min ?? 0) + (a.sem_os_total_min ?? 0);
        const scoreB = (b.temp_prep_os_min ?? 0) + (b.sem_os_total_min ?? 0);
        return scoreB - scoreA;
      })
      .slice(0, maxPerFlag * flagOrder.length);
  }

export function selectTopOsDiaEvidences(
    evidences: OsDiaOrderEvidence[],
    maxPerFlag = 2,
  ): OsDiaOrderEvidence[] {
    if (evidences.length === 0) {
      return [];
    }

    const selected = new Map<string, OsDiaOrderEvidence>();
    const flagPriority: OsDiaOrderEvidence['flags'] = [
      'tr_excede_hd',
      'tl_excede_hd',
      'temp_prep_alto',
      'sem_os_alto',
    ];

    for (const flag of flagPriority) {
      const topByFlag = evidences
        .filter((evidence) => evidence.flags.includes(flag))
        .sort((left, right) => scoreOsDiaEvidenceForFlag(right, flag) - scoreOsDiaEvidenceForFlag(left, flag))
        .slice(0, maxPerFlag);

      for (const evidence of topByFlag) {
        const key = `${evidence.nr_ordem}|${evidence.despachada}|${evidence.a_caminho}`;
        if (!selected.has(key)) {
          selected.set(key, evidence);
        }
      }
    }

    return Array.from(selected.values())
      .sort((left, right) => scoreOsDiaEvidence(right) - scoreOsDiaEvidence(left))
      .slice(0, maxPerFlag * flagPriority.length);
  }

export function scoreOsDiaEvidenceForFlag(
    evidence: OsDiaOrderEvidence,
    flag: OsDiaOrderEvidence['flags'][number],
  ): number {
    switch (flag) {
      case 'tr_excede_hd':
        return evidence.hd_pct_tr;
      case 'tl_excede_hd':
        return evidence.hd_pct_tl;
      case 'temp_prep_alto':
        return evidence.temp_prep_os_min ?? 0;
      case 'sem_os_alto':
        return evidence.sem_os_total_min ?? 0;
      default:
        return 0;
    }
  }

export function scoreOsDiaEvidence(evidence: OsDiaOrderEvidence): number {
    return (
      evidence.hd_pct_tr +
      evidence.hd_pct_tl +
      (evidence.temp_prep_os_min ?? 0) +
      (evidence.sem_os_total_min ?? 0)
    );
  }

  // ─── Business logic text helpers — single source of truth for alert texts ──

  /** Formats a number for Portuguese locale display (used in pre-computed alert texts). */
