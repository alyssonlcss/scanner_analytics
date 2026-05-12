import type { CsvRow } from '../csv-utils.js';
import type { EficienciaTeamAnalysis, EficienciaOrderEvidence, KpiInsight } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, round2, percentile } from '../csv-utils.js';
import { enrichEficienciaEvidence } from './enrich-utils.js';
import { countDistinctDates, mergeEvidenceFlags } from './os-dia.analyzer.js';

export function analyzeEficiencia(deslocRows: CsvRow[], rankingRows: CsvRow[], kpis: KpiInsight[]): EficienciaTeamAnalysis[] {
    if (deslocRows.length === 0 || rankingRows.length === 0) {
      console.log('[Eficiencia Analysis] No deslocamentos or ranking data');
      return [];
    }

    // 1. Get Eficiencia KPI insight and determine teams to analyze
    const eficienciaKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Eficiência'));
    if (!eficienciaKpi) {
      console.log('[Eficiencia Analysis] Eficiência KPI not found in kpis:', kpis.map(k => k.kpi));
      return [];
    }

    console.log('[Eficiencia Analysis] Found Eficiência KPI:', {
      average: eficienciaKpi.average,
      topTeams: eficienciaKpi.topTeams,
      opportunityTeams: eficienciaKpi.opportunityTeams,
    });

    const teamsToAnalyze = new Map<string, { value: number; type: 'top_performer' | 'underperformer' }>();
    
    // Top 3 teams (check for masked efficiency)
    for (const t of eficienciaKpi.topTeams) {
      teamsToAnalyze.set(t.team, { value: t.value, type: 'top_performer' });
    }
    
    // Bottom 3 teams (check for issues)
    for (const t of eficienciaKpi.opportunityTeams) {
      teamsToAnalyze.set(t.team, { value: t.value, type: 'underperformer' });
    }

    console.log('[Eficiencia Analysis] Teams to analyze:', Array.from(teamsToAnalyze.keys()));

    if (teamsToAnalyze.size === 0) {
      return [];
    }

    // 2. Resolve deslocamento columns
    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol = deslocAcc.resolve(['Equipe']);
    const aCaminhoCol = deslocAcc.resolve(['A_Caminho', 'A Caminho']);
    const noLocalCol = deslocAcc.resolve(['No_Local', 'No Local']);
    const liberadaCol = deslocAcc.resolve(['Liberada']);
    const nrOrdemCol = deslocAcc.resolve(['Nr_Ordem', 'Nr Ordem', 'Numero Ordem']);
    const classeCol = deslocAcc.resolve(['CLASSE', 'Classe']);
    const causaCol = deslocAcc.resolve(['CAUSA', 'Causa']);
    const despachadaCol = deslocAcc.resolve(['Despachada']);
    const tlOrdemCol = deslocAcc.resolve(['TL Ordem', 'TL_Ordem']);
    const trOrdemCol = deslocAcc.resolve(['TR Ordem', 'TR_Ordem']);
    const tempoPadraoCol = deslocAcc.resolve(['tempo_padrao', 'Tempo Padrao', 'Tempo_Padrao', 'TempoPadrao']);
    const hdTotalCol = deslocAcc.resolve(['HD Total', 'HD_Total']);
    const dateCol = deslocAcc.resolve(['Data Referência', 'Data Referencia']);

    if (!teamCol || !aCaminhoCol || !noLocalCol || !liberadaCol) {
      return [];
    }

    // 3. Calculate global averages for displacement and execution times
    const allDisplacementTimes: number[] = [];
    const allExecutionTimes: number[] = [];

    for (const row of deslocRows) {
      const tlMin = tlOrdemCol ? parseNumber(String(row[tlOrdemCol] ?? '')) : null;
      const trMin = trOrdemCol ? parseNumber(String(row[trOrdemCol] ?? '')) : null;
      
      if (tlMin !== null && Number.isFinite(tlMin) && tlMin > 0) {
        allDisplacementTimes.push(tlMin);
      }
      if (trMin !== null && Number.isFinite(trMin) && trMin > 0) {
        allExecutionTimes.push(trMin);
      }
    }

    const globalAvgDeslocamento = allDisplacementTimes.length > 0
      ? allDisplacementTimes.reduce((s, v) => s + v, 0) / allDisplacementTimes.length
      : 0;
    
    const globalAvgExecucao = allExecutionTimes.length > 0
      ? allExecutionTimes.reduce((s, v) => s + v, 0) / allExecutionTimes.length
      : 0;

    console.log('[Eficiencia Analysis] Global averages:', {
      displacement: globalAvgDeslocamento,
      execution: globalAvgExecucao,
      totalDisplacements: allDisplacementTimes.length,
      totalExecutions: allExecutionTimes.length,
    });

    // 4. Analyze each team
    const distinctDates = dateCol ? countDistinctDates(deslocRows, dateCol) : 0;
    const result: EficienciaTeamAnalysis[] = [];

    for (const [team, { value: eficienciaValue, type: analysisType }] of teamsToAnalyze.entries()) {
      // Get all orders for this team — try exact match first, then normalized fallback
      const teamNorm = normalizeToken(team);
      let teamRows = deslocRows.filter((row) => String(row[teamCol] ?? '').trim() === team);
      if (teamRows.length === 0) {
        teamRows = deslocRows.filter((row) => normalizeToken(String(row[teamCol] ?? '').trim()) === teamNorm);
      }

      // Calculate team averages
      const teamDisplacementTimes: number[] = [];
      const teamExecutionTimes: number[] = [];
      const teamTempoPadraoTimes: number[] = [];

      for (const row of teamRows) {
        const tlMin = tlOrdemCol ? parseNumber(String(row[tlOrdemCol] ?? '')) : null;
        const trMin = trOrdemCol ? parseNumber(String(row[trOrdemCol] ?? '')) : null;
        const tpMin = tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) : null;
        
        if (tlMin !== null && Number.isFinite(tlMin) && tlMin > 0) {
          teamDisplacementTimes.push(tlMin);
        }
        if (trMin !== null && Number.isFinite(trMin) && trMin > 0) {
          teamExecutionTimes.push(trMin);
        }
        if (tpMin !== null && Number.isFinite(tpMin) && tpMin > 0) {
          teamTempoPadraoTimes.push(tpMin);
        }
      }

      const avgDeslocamentoMin = teamDisplacementTimes.length > 0
        ? teamDisplacementTimes.reduce((s, v) => s + v, 0) / teamDisplacementTimes.length
        : 0;
      
      const avgExecucaoMin = teamExecutionTimes.length > 0
        ? teamExecutionTimes.reduce((s, v) => s + v, 0) / teamExecutionTimes.length
        : 0;

      const avgTempoPadraoMin = teamTempoPadraoTimes.length > 0
        ? teamTempoPadraoTimes.reduce((s, v) => s + v, 0) / teamTempoPadraoTimes.length
        : 0;

      console.log(`[Eficiencia Analysis] Team ${team} (${analysisType}):`, {
        eficienciaValue,
        avgDeslocamentoMin,
        avgExecucaoMin,
        totalOrders: teamRows.length,
      });

      // 5. Thresholds
      const shortDisplacementThreshold = globalAvgDeslocamento > 0 ? globalAvgDeslocamento * 0.25 : 0;
      const lowTrThreshold = globalAvgExecucao > 0 ? globalAvgExecucao * 0.20 : 0;
      const TR_HD_THRESHOLD = 0.20;

      // Simulation: what would efficiency be if missing tempo_padrão were replaced with global avg TR?
      const tempoPadraoVazioOrders: EficienciaOrderEvidence[] = [];
      let simSumTp = 0;
      let simSumTr = 0;
      let hasAnyVazio = false;
      for (const row of teamRows) {
        const trRaw = trOrdemCol ? parseNumber(String(row[trOrdemCol] ?? '')) : null;
        const tpRaw = tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) : null;
        if (trRaw !== null && Number.isFinite(trRaw) && trRaw > 0) {
          simSumTr += trRaw;
          if (tpRaw !== null && Number.isFinite(tpRaw) && tpRaw > 0) {
            simSumTp += tpRaw;
          } else {
            simSumTp += globalAvgExecucao;
            hasAnyVazio = true;
          }
        }
      }
      const simulatedEficiencia = hasAnyVazio && simSumTr > 0
        ? round2((simSumTp / simSumTr) * 100)
        : undefined;

      // Collect flagged orders first (order-level flags)
      const flaggedOrders: EficienciaOrderEvidence[] = [];
      if (nrOrdemCol) {
        for (const row of teamRows) {
          const tlMin = tlOrdemCol ? parseNumber(String(row[tlOrdemCol] ?? '')) : null;
          const trMin = trOrdemCol ? parseNumber(String(row[trOrdemCol] ?? '')) : null;
          const hdMin = hdTotalCol ? (parseNumber(String(row[hdTotalCol] ?? '')) ?? 0) : 0;
          const tpMin = tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) : null;
          const hdPctTr = hdMin > 0 && trMin !== null && Number.isFinite(trMin) ? round2((trMin / hdMin) * 100) : 0;
          const orderFlags: EficienciaOrderEvidence['flags'] = [];

          // TR muito baixo: TR < 20% do tempo_padrão OU TR < 20% da média global de TR
          // TR muito baixo: evidência de falsa eficiência — apenas para top performers
          const trIsValid = trMin !== null && Number.isFinite(trMin) && trMin > 0;
          const trMuitoBaixo = analysisType === 'top_performer' && trIsValid && (
            (tpMin !== null && Number.isFinite(tpMin) && tpMin > 0 && trMin! < tpMin * 0.20) &&
            (lowTrThreshold > 0 && trMin! < lowTrThreshold)
          );
          if (trMuitoBaixo) {
            orderFlags.push('tr_muito_baixo');
          }

          // deslocamento_curto: somente quando TR muito baixo E TL curto — apenas para top performers
          if (trMuitoBaixo && shortDisplacementThreshold > 0 && tlMin !== null && Number.isFinite(tlMin) && tlMin > 0 && tlMin <= shortDisplacementThreshold) {
            orderFlags.push('deslocamento_curto');
          }

          // TR excede HD ou TR excede 200% do tempo_padrão — apenas para equipes abaixo da média
          if (analysisType === 'underperformer') {
            const trExcedeHd = hdMin > 0 && trMin !== null && Number.isFinite(trMin) && trMin > hdMin * TR_HD_THRESHOLD;
            const trExcedeTempoPadrao = tpMin !== null && Number.isFinite(tpMin) && tpMin > 0 &&
              trMin !== null && Number.isFinite(trMin) && trMin > tpMin * 2.0;
            if (trExcedeHd || trExcedeTempoPadrao) {
              orderFlags.push('tr_excede_hd');
            }
          }

          if (orderFlags.length > 0) {
            flaggedOrders.push({
              date_ref: dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
              nr_ordem: String(row[nrOrdemCol] ?? '').trim(),
              classe: classeCol ? String(row[classeCol] ?? '').trim() : '',
              causa: causaCol ? String(row[causaCol] ?? '').trim() : '',
              despachada: despachadaCol ? String(row[despachadaCol] ?? '').trim() : '',
              a_caminho: String(row[aCaminhoCol] ?? '').trim(),
              no_local: String(row[noLocalCol] ?? '').trim(),
              liberada: String(row[liberadaCol] ?? '').trim(),
              tl_ordem_min: tlMin !== null && Number.isFinite(tlMin) ? round2(tlMin) : 0,
              tr_ordem_min: trMin !== null && Number.isFinite(trMin) ? round2(trMin) : 0,
              hd_total_min: round2(hdMin),
              hd_pct_tr: hdPctTr,
              tempo_padrao_min: tpMin !== null && Number.isFinite(tpMin) ? round2(tpMin) : undefined,
              flags: orderFlags,
            });
          }

          // Vazio: order has TR but no tempo_padrão
          const isTpVazio = (tpMin === null || !Number.isFinite(tpMin) || tpMin <= 0) &&
            trMin !== null && Number.isFinite(trMin) && trMin > 0;
          if (isTpVazio) {
            tempoPadraoVazioOrders.push({
              date_ref: dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
              nr_ordem: String(row[nrOrdemCol] ?? '').trim(),
              classe: classeCol ? String(row[classeCol] ?? '').trim() : '',
              causa: causaCol ? String(row[causaCol] ?? '').trim() : '',
              despachada: despachadaCol ? String(row[despachadaCol] ?? '').trim() : '',
              a_caminho: String(row[aCaminhoCol] ?? '').trim(),
              no_local: String(row[noLocalCol] ?? '').trim(),
              liberada: String(row[liberadaCol] ?? '').trim(),
              tl_ordem_min: tlMin !== null && Number.isFinite(tlMin) ? round2(tlMin) : 0,
              tr_ordem_min: trMin !== null && Number.isFinite(trMin) ? round2(trMin) : 0,
              hd_total_min: round2(hdMin),
              hd_pct_tr: hdPctTr,
              tempo_padrao_min: undefined,
              flags: ['tempo_padrao_vazio'],
            });
          }
        }
      }

      // Deduplicate both arrays by nr_ordem, merging flags for the same OS
      const mergedFlaggedOrders = mergeEvidenceFlags(flaggedOrders);
      // Build a lookup map for O(1) key checks
      const flaggedOrdersMap = new Map(mergedFlaggedOrders.map((o) => [o.nr_ordem || `${o.despachada}|${o.a_caminho}`, o]));

      // Merge tempoPadraoVazioOrders into flaggedOrders:
      // - if OS already in flaggedOrders → add 'tempo_padrao_vazio' flag
      // - otherwise → append to flaggedOrders directly (all flags in one place)
      const tempoPadraoVazioDeduped = mergeEvidenceFlags(tempoPadraoVazioOrders);
      for (const order of tempoPadraoVazioDeduped) {
        const key = order.nr_ordem || `${order.despachada}|${order.a_caminho}`;
        const existing = flaggedOrdersMap.get(key);
        if (existing) {
          if (!existing.flags.includes('tempo_padrao_vazio')) {
            existing.flags.push('tempo_padrao_vazio');
          }
        } else {
          mergedFlaggedOrders.push(order);
          flaggedOrdersMap.set(key, order);
        }
      }

      // Team-level flags — computed after order loop
      const flags: EficienciaTeamAnalysis['flags'] = [];
      const countDeslocamentoCurtoCalc = mergedFlaggedOrders.filter((o) => o.flags.includes('deslocamento_curto')).length;
      if (countDeslocamentoCurtoCalc > 0) {
        flags.push('short_displacement');
      }

      const countTempoPadraoVazio = mergedFlaggedOrders.filter((o) => o.flags.includes('tempo_padrao_vazio')).length;
      const allFlagged = distinctDates > 7 ? mergedFlaggedOrders.slice(0, 10) : mergedFlaggedOrders;
      const enrichedFlagged = enrichEficienciaEvidence(allFlagged, {
        globalAvgExecucaoMin: round2(globalAvgExecucao),
        globalAvgDeslocamentoMin: round2(globalAvgDeslocamento),
      });

      // Always include all top 3 and bottom 3 teams
      result.push({
        team,
        eficienciaValue: round2(eficienciaValue),
        averageEficiencia: round2(eficienciaKpi.average),
        avgDeslocamentoMin: round2(avgDeslocamentoMin),
        avgExecucaoMin: round2(avgExecucaoMin),
        avgTempoPadraoMin: round2(avgTempoPadraoMin),
        globalAvgDeslocamentoMin: round2(globalAvgDeslocamento),
        globalAvgExecucaoMin: round2(globalAvgExecucao),
        analysisType,
        flags,
        flaggedOrders: enrichedFlagged,
        tempoPadraoVazioOrders: [],
        simulatedEficiencia,
        summary: {
          totalOrders: teamRows.length,
          countDeslocamentoCurto: mergedFlaggedOrders.filter((o) => o.flags.includes('deslocamento_curto')).length,
          countTrExcedeHd: mergedFlaggedOrders.filter((o) => o.flags.includes('tr_excede_hd')).length,
          countTempoPadraoVazio,
        },
      });
    }

    console.log(`[Eficiencia Analysis] Final result count: ${result.length}`);

    return result.sort((a, b) => {
      // Sort top performers first, then underperformers
      if (a.analysisType !== b.analysisType) {
        return a.analysisType === 'top_performer' ? -1 : 1;
      }
      // Within same type, sort by efficiency value (descending for top, ascending for bottom)
      return a.analysisType === 'top_performer'
        ? b.eficienciaValue - a.eficienciaValue
        : a.eficienciaValue - b.eficienciaValue;
    });
  }

