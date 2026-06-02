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
    const TEMP_PREP_THRESHOLD_MIN      = 10; // Desp. → A Caminho (all OS)
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
    // Timestamp of the first dispatch of the day (team-day aggregate) — different from the duration column firstDespachoCol
    const horaPrimDespachoTsCol = deslocAcc.resolve(['Hora 1º Despacho', 'Hora 1o Despacho']);

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

    // Global avg TR across ALL rows (used as threshold for flag_temp_reparo_excedido)
    let globalTrSum = 0;
    let globalTrCount = 0;
    if (trOrdemCol) {
      for (const row of deslocRows) {
        const v = parseNumber(String(row[trOrdemCol] ?? ''));
        if (v !== null && Number.isFinite(v) && v > 0) {
          globalTrSum += v;
          globalTrCount++;
        }
      }
    }
    const globalAvgTrMin = globalTrCount > 0 ? round2(globalTrSum / globalTrCount) : 0;

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
    const teamAllBasicOrders = new Map<string, OsDiaOrderEvidence[]>();
    const teamAllBasicSeenForTeam = new Map<string, Set<string>>();
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
        if (tempPrep.intervalApplied) {
          isInterACaminho = true;
        }
        tempPrepValues.push(tempPrep.value);
        // Ocioso for subsequent OS = A Caminho − prev Liberada, interval excluded
        {
          let ocisoMin: number | undefined;
          if (aCaminho && liberada) {
            let raw = minutesBetween(aCaminho, liberada);
            if (inicioIntervalo && fimIntervalo) {
              const overlapStart = Math.max(inicioIntervalo.getTime(), liberada.getTime());
              const overlapEnd   = Math.min(fimIntervalo.getTime(), aCaminho.getTime());
              if (overlapEnd > overlapStart) {
                raw -= (overlapEnd - overlapStart) / 60000;
              }
            }
            ocisoMin = round2(Math.max(0, raw));
          }
          ocisoValues.push(ocisoMin);
        }

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

      // SemOrdem: gap from last OS's Liberada (or Fim Intervalo when interval is in the fim window) to Log Off.
      // Segment type is always 'fim_jornada' / "Antes Log Off" with full directGap as min.
      // Flag activates when: (row retornoBase present) excess > 5 min; (row empty) directGap > avg * 1.2.
      const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
      let semOsFimJornadaMin = Number.NaN;       // excess above retorno base (shown in flag text)
      let semOsFimDirectGapMin = Number.NaN;     // total segment duration (shown in report)
      let semOsFimDeslIntervalMin = Number.NaN;  // Liberada → Início Intervalo (end-of-day interval)
      let semOsFimFrom: string | undefined;
      let semOsFimFromLabel: string | undefined;
      let semOsFimRetornoBaseRowVal = 0;          // row-level retorno base (display only)
      let semOsFimRetornoBaseUsedRow = false;
      let semOsFimAboveThreshold = false;
      let semOsFimHasIntervalInWindow = false;
      if (logOffCorrigidoCol2 && liberadaCol) {
        const lastRow = ordered[ordered.length - 1];
        const lastLiberada = parseDateTimeBr(String(lastRow[liberadaCol] ?? ''));
        const logOff = parseDateTimeBr(String(lastRow[logOffCorrigidoCol2] ?? ''));
        if (lastLiberada && logOff && logOff.getTime() > lastLiberada.getTime()) {
          const lastIntStart = inicioIntervaloCol ? parseDateTimeBr(String(lastRow[inicioIntervaloCol] ?? '')) : null;
          const lastIntEnd   = fimIntervaloCol    ? parseDateTimeBr(String(lastRow[fimIntervaloCol]    ?? '')) : null;
          // Interval is in the fim window when it falls entirely between last Liberada and Log Off
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

      // Collect basic info for ALL orders (for "Ver mais" expansion, includes non-flagged)
      {
        const basicArr = teamAllBasicOrders.get(team) ?? [];
        const seen = teamAllBasicSeenForTeam.get(team) ?? new Set<string>();
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
          // Interval window check: only show interval in the card where it belongs
          const basicInicioIntervaloRaw = inicioIntervaloCol ? String(row[inicioIntervaloCol] ?? '').trim() : '';
          const basicFimIntervaloRaw    = fimIntervaloCol    ? String(row[fimIntervaloCol]    ?? '').trim() : '';
          const basicInicioIntervaloDate = basicInicioIntervaloRaw ? parseDateTimeBr(basicInicioIntervaloRaw) : null;
          const basicLiberadaAtualDate   = liberadaCol ? parseDateTimeBr(String(row[liberadaCol] ?? '')) : null;
          const basicPrevLiberadaDate    = prevRow && liberadaCol ? parseDateTimeBr(String(prevRow[liberadaCol] ?? '')) : null;
          const basicIntervaloNaJanela   = Boolean(
            basicInicioIntervaloDate &&
            basicLiberadaAtualDate &&
            basicInicioIntervaloDate.getTime() <= basicLiberadaAtualDate.getTime() &&
            (basicPrevLiberadaDate === null || basicInicioIntervaloDate.getTime() >= basicPrevLiberadaDate.getTime()),
          );
          basicArr.push({
            source: 'Scanner 4.4 - CE M300',
            date_ref: dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
            nr_ordem: nr,
            classe: classeCol ? String(row[classeCol] ?? '').trim() : '',
            causa: causaCol ? String(row[causaCol] ?? '').trim() : '',
            prev_liberada: prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined,
            despachada: desp,
            a_caminho: String(row[caminhoCol] ?? '').trim(),
            no_local: noLocalCol ? String(row[noLocalCol] ?? '').trim() : '',
            liberada: liberadaCol ? String(row[liberadaCol] ?? '').trim() : '',
            inicio_intervalo: basicIntervaloNaJanela ? basicInicioIntervaloRaw : '',
            fim_intervalo:    basicIntervaloNaJanela ? basicFimIntervaloRaw    : '',
            inicio_calendario: bIdx === 0 && inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
            tr_ordem_min: round2(trMin),
            tl_ordem_min: round2(tlMin),
            hd_total_min: round2(hdMin),
            hd_pct_tr: hdMin > 0 ? round2((trMin / hdMin) * 100) : 0,
            hd_pct_tl: hdMin > 0 ? round2((tlMin / hdMin) * 100) : 0,
            global_avg_tl_min: globalAvgTlMin,
            global_avg_tr_min: globalAvgTrMin,
            tempo_padrao_min: tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) ?? undefined : undefined,
            ocioso_min: ocisoValues[bIdx],
            flags: [],
          });
        }
        teamAllBasicOrders.set(team, basicArr);
        teamAllBasicSeenForTeam.set(team, seen);
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
        if (globalAvgTlMin > 0 && tlOrdemMin > globalAvgTlMin && hdTotalMin > 0 && tlOrdemMin > hdTotalMin * 0.20) {
          flags.push('tl_excede_hd');
        }

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
        if (Number.isFinite(tempPrepOs) && tempPrepOs >= tempPrepThreshold + TOLERANCE_MIN) {
          flags.push('temp_prep_alto');
        }
        if (triagemMin !== undefined && triagemMin >= TEMP_PREP_THRESHOLD_MIN + TOLERANCE_MIN) {
          flags.push('triagem_alto');
        }
        // 1º Desloc.: Início Cal. → A Caminho, only for 1ª OS, threshold 25 min
        const ocisoForFlag = ocisoValues[i];
        if (i === 0 && ocisoForFlag !== undefined && ocisoForFlag >= 25) {
          flags.push('primeiro_desloc_alto');
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
              global_avg_min: globalAvgInicioJornadaMin > 0 ? globalAvgInicioJornadaMin : undefined,
              above_avg_pct: globalAvgInicioJornadaMin > 0 ? round2((semOsMin - globalAvgInicioJornadaMin) / globalAvgInicioJornadaMin * 100) : undefined,
            });
          } else {
            const prevDespStr = prevRow && despachadaCol ? String(prevRow[despachadaCol] ?? '').trim() || undefined : undefined;
            const prevDespDate = prevDespStr ? parseDateTimeBr(prevDespStr) : null;
            const prevLibStr  = prevRow && liberadaCol  ? String(prevRow[liberadaCol]  ?? '').trim() || undefined : undefined;
            const prevLibDate  = prevLibStr  ? parseDateTimeBr(prevLibStr)  : null;
            const despachadaDate = despachadaCol ? parseDateTimeBr(String(row[despachadaCol] ?? '')) : null;
            // When the interval overlaps the dispatch window (interceptsDispatch case), Início Intervalo
            // is the first event after Lib. Anterior — calculateSemOsValue already returns
            // minutesBetween(inicioIntervalo, prevLiberada), so semOsMin is the exact pre-interval time.
            //
            // When the interval fits fully within the entre-ordens window (insideTolerance case),
            // semOsMin includes BOTH the pre-interval travel AND the post-interval wait. We must split
            // them into separate sem_os_details entries so the report is accurate.
            if (
              hasIntervaloDeslocamento &&
              semOsIntervalApplied[i] &&
              inicioIntervaloDate &&
              despachadaDate &&
              inicioIntervaloDate.getTime() < despachadaDate.getTime()
            ) {
              // interceptsDispatch: despachada falls inside the interval → semOsMin is already the
              // exact pre-interval travel time (minutesBetween(inicioIntervalo, prevLiberada)).
              const isInterceptsDispatch = Boolean(
                fimIntervaloDate && despachadaDate.getTime() < fimIntervaloDate.getTime(),
              );
              if (isInterceptsDispatch) {
                const interceptMin = round2(semOsMin);
                if (interceptMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
                  semOsDetails.push({
                    type: 'intervalo_deslocamento',
                    min:  interceptMin,
                    from: prevLibStr,
                    to:   inicioIntervaloRaw || undefined,
                  });
                }
              } else {
                // insideTolerance: the interval fits entirely between prevLiberada and despachada.
                // Split into: pre-interval travel (prevLiberada → inicioIntervalo) and
                //             post-interval wait  (fimIntervalo → despachada).
                const deslocIntervalMin = round2(minutesBetween(inicioIntervaloDate, prevLiberadaDate!));
                if (deslocIntervalMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
                  semOsDetails.push({
                    type: 'intervalo_deslocamento',
                    min:  deslocIntervalMin,
                    from: prevLibStr,
                    to:   inicioIntervaloRaw || undefined,
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
        // Only add intervalo_deslocamento when the interval was NOT already handled above
        // (semOsIntervalApplied[i] === true covers both interceptsDispatch and insideTolerance).
        if (hasIntervaloDeslocamento && inicioIntervaloDate && prevLiberadaDate && !semOsIntervalApplied[i]) {
          // When the current OS has a Despachada between prevLiberada and inicioIntervalo,
          // the "Desl. Intervalo" is measured from Despachada (not Lib. Anterior).
          const despachadaAtualDate = despachadaCol ? parseDateTimeBr(String(row[despachadaCol] ?? '')) : null;
          const useDespachadaAsFrom = Boolean(
            despachadaAtualDate &&
            despachadaAtualDate.getTime() > prevLiberadaDate.getTime() &&
            despachadaAtualDate.getTime() < inicioIntervaloDate.getTime(),
          );
          const intFrom  = useDespachadaAsFrom ? despachadaAtualDate! : prevLiberadaDate;
          const intFromStr = useDespachadaAsFrom
            ? (despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined)
            : (prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined);
          const intMin = round2(minutesBetween(inicioIntervaloDate, intFrom));
          if (intMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN) {
            semOsDetails.push({
              type: 'intervalo_deslocamento',
              min:  intMin,
              from: intFromStr,
              to:   inicioIntervaloRaw || undefined,
              from_label: useDespachadaAsFrom ? 'Despachada' : 'Lib. Anterior',
            });
          }
        }

        const semOsTotalMin = semOsDetails.length > 0 ? round2(semOsDetails.reduce((s, d) => s + d.min, 0)) : undefined;

        // Detect prior-dispatch conflict for the first OS of the day (i === 0).
        // If Hora 1º Despacho (team-day aggregate timestamp) differs from this OS's Despachada,
        // another OS was dispatched first. Find that OS's Nr_Ordem to show the warning flag.
        // NOTE: detection already done above (before flags) — skip duplicate block.

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
          global_avg_tr_min: globalAvgTrMin,
          tempo_padrao_min:  tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) ? round2(tempoPadraoRaw) : undefined,
          temp_prep_os_min:  Number.isFinite(tempPrepOs) ? round2(tempPrepOs) : undefined,
          triagem_min:       triagemMin,
          triagem_global_avg_min: (triagemMin !== undefined && globalAvgTriagemMin > 0) ? globalAvgTriagemMin : undefined,
          ocioso_min:        ocisoValues[i],
          flag_temp_reparo_excedido: (
            globalAvgTrMin > 0 && trOrdemMin > globalAvgTrMin &&
            tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) && tempoPadraoRaw > 0 &&
            trOrdemMin > tempoPadraoRaw
          ) ? true : undefined,
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
        const logOffStr = logOffCorrigidoCol2 ? String(lastRow[logOffCorrigidoCol2] ?? '').trim() || undefined : undefined;
        const liberadaStr = liberadaCol ? String(lastRow[liberadaCol] ?? '').trim() || undefined : undefined;
        if (logOffStr) {
          const fimDeslAbove = Number.isFinite(semOsFimDeslIntervalMin) && semOsFimDeslIntervalMin >= SEM_OS_THRESHOLD_MIN + TOLERANCE_MIN;
          const semOsAbove = fimDeslAbove; // fim_jornada is a separate flag, not part of ociosidade
          const fimDetail: NonNullable<OsDiaOrderEvidence['sem_os_details']>[number] = {
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
          // Desl. Intervalo detail for end-of-day interval (Liberada → Início Intervalo)
          const fimDeslDetail: NonNullable<OsDiaOrderEvidence['sem_os_details']>[number] | null = fimDeslAbove
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
              if (!existingEvidence.flags.includes('sem_os_alto')) {
                existingEvidence.flags.push('sem_os_alto');
              }
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
            const allFimDetails = [fimDetail, ...(fimDeslDetail ? [fimDeslDetail] : [])];
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
              global_avg_tr_min: globalAvgTrMin,
              tempo_padrao_min:  tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) ? round2(tempoPadraoRaw) : undefined,
              flag_temp_reparo_excedido: (
                globalAvgTrMin > 0 && trOrdemMin > globalAvgTrMin &&
                tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) && tempoPadraoRaw > 0 &&
                trOrdemMin > tempoPadraoRaw
              ) ? true : undefined,
              sem_os_details:    allFimDetails,
              sem_os_total_min:  semOsAbove ? round2(allFimDetails.filter((d) => d.type !== 'fim_jornada').reduce((s, d) => s + d.min, 0)) : undefined,
              flags:             [
                ...(semOsAbove ? ['sem_os_alto' as const] : []),
                ...(semOsFimAboveThreshold ? ['antes_log_off_alto' as const] : []),
              ],
            });
          } else {
            // Below threshold: inject fimDetail into the basic order so timeline shows Log Off
            const basicOrders = teamAllBasicOrders.get(team) ?? [];
            const basicOrder = basicOrders.find((o) => o.nr_ordem === lastNrOrdem);
            if (basicOrder) {
              basicOrder.sem_os_details = (basicOrder.sem_os_details ?? []).concat(fimDetail);
            }
          }
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
      const topFlagged = distinctDates > 7 ? selectTopOsDiaEvidences(flaggedOrders) : flaggedOrders.slice(0, 10);
      const prioritizedFlaggedOrders = enrichOsDiaEvidence(topFlagged);
      // Extras: all orders (flagged + non-flagged) not in top-displayed
      const allBasic = teamAllBasicOrders.get(team) ?? [];
      const flaggedByKey = new Map(flaggedOrders.map(o => [o.nr_ordem || `${o.despachada}|${o.a_caminho}`, o]));
      const seenExtra = new Set<string>();
      const allMerged: OsDiaOrderEvidence[] = [];
      for (const o of allBasic) {
        const key = o.nr_ordem || `${o.despachada}|${o.a_caminho}`;
        if (!seenExtra.has(key)) { seenExtra.add(key); allMerged.push(flaggedByKey.get(key) ?? o); }
      }
      const topKeys = new Set(topFlagged.map((o) => o.nr_ordem || `${o.despachada}|${o.a_caminho}`));
      const extraFlaggedOrders = enrichOsDiaEvidence(
        allMerged.filter((o) => !topKeys.has(o.nr_ordem || `${o.despachada}|${o.a_caminho}`)),
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
        extraFlaggedOrders,
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
