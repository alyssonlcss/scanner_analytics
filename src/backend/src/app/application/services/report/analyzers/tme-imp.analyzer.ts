import type { CsvRow } from '../csv-utils.js';
import type { TmeImpTeamAnalysis, TmeImpOrderEvidence, KpiInsight } from '../types.js';
import { createAccessor, parseNumber, normalizeToken, round2, parseDateTimeBr } from '../csv-utils.js';
import { enrichTmeImpEvidence } from './enrich-utils.js';
import { countDistinctDates } from './os-dia.analyzer.js';

export function analyzeTmeImp(deslocRows: CsvRow[], rankingRows: CsvRow[], kpis: KpiInsight[]): TmeImpTeamAnalysis[] {
    if (deslocRows.length === 0 || rankingRows.length === 0) return [];

    const TME_IMP_META = 20;

    const tmeKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('TME IMP'));
    if (!tmeKpi) return [];

    // Teams to analyze: bottom 3 worst only
    const teamsToAnalyze = new Map<string, { value: number; type: 'underperformer' }>();
    for (const t of tmeKpi.opportunityTeams) teamsToAnalyze.set(t.team, { value: t.value, type: 'underperformer' });
    if (teamsToAnalyze.size === 0) return [];

    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol      = deslocAcc.resolve(['Equipe']);
    const dateCol      = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const nrOrdemCol   = deslocAcc.resolve(['Nr_Ordem', 'Nr Ordem', 'Numero Ordem']);
    const classeCol    = deslocAcc.resolve(['CLASSE', 'Classe']);
    const causaCol     = deslocAcc.resolve(['CAUSA', 'Causa']);
    const despachadaCol = deslocAcc.resolve(['Despachada']);
    const aCaminhoCol  = deslocAcc.resolve(['A_Caminho', 'A Caminho']);
    const noLocalCol   = deslocAcc.resolve(['No_Local', 'No Local']);
    const liberadaCol  = deslocAcc.resolve(['Liberada']);
    const trOrdemCol   = deslocAcc.resolve(['TR Ordem', 'TR_Ordem']);
    const tlOrdemCol   = deslocAcc.resolve(['TL Ordem', 'TL_Ordem']);
    const tmeImpCol    = deslocAcc.resolve(['TR Ordem Imp SS', 'TR Ordem Imp SS equipe']);

    if (!teamCol) return [];

    const distinctDates = dateCol ? countDistinctDates(deslocRows, dateCol) : 0;

    // Global average TME IMP
    const allTmeValues: number[] = [];
    for (const row of deslocRows) {
      const v = tmeImpCol ? parseNumber(String(row[tmeImpCol] ?? '')) : null;
      if (v !== null && Number.isFinite(v) && v > 0) allTmeValues.push(v);
    }
    const globalAvgTme = allTmeValues.length > 0 ? allTmeValues.reduce((s, x) => s + x, 0) / allTmeValues.length : 0;

    const result: TmeImpTeamAnalysis[] = [];

    for (const [team, { value: tmeImpValue }] of teamsToAnalyze.entries()) {
      const teamNorm = normalizeToken(team);
      let teamRows = deslocRows.filter((r) => String(r[teamCol] ?? '').trim() === team);
      if (teamRows.length === 0) {
        teamRows = deslocRows.filter((r) => normalizeToken(String(r[teamCol] ?? '').trim()) === teamNorm);
      }
      if (teamRows.length === 0) continue;

      const teamTmeValues: number[] = [];
      for (const row of teamRows) {
        const v = tmeImpCol ? parseNumber(String(row[tmeImpCol] ?? '')) : null;
        if (v !== null && Number.isFinite(v) && v > 0) teamTmeValues.push(v);
      }
      const teamAvgTme = teamTmeValues.length > 0 ? teamTmeValues.reduce((s, x) => s + x, 0) / teamTmeValues.length : 0;

      // Sort team rows by despachada time to find prev_liberada per order
      const sortedTeamRows = [...teamRows].sort((a, b) => {
        const da = despachadaCol ? parseDateTimeBr(String(a[despachadaCol] ?? '')) : null;
        const db = despachadaCol ? parseDateTimeBr(String(b[despachadaCol] ?? '')) : null;
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da.getTime() - db.getTime();
      });
      // Build a map: nr_ordem -> prev_liberada
      const prevLiberadaMap = new Map<string, string>();
      for (let i = 1; i < sortedTeamRows.length; i++) {
        const curr = sortedTeamRows[i];
        const prev = sortedTeamRows[i - 1];
        const currNr = nrOrdemCol ? String(curr[nrOrdemCol] ?? '').trim() : '';
        const prevLib = liberadaCol ? String(prev[liberadaCol] ?? '').trim() : '';
        if (currNr) prevLiberadaMap.set(currNr, prevLib);
      }

      // Flag rule: orders where TME IMP exceeds 1.5x team average OR exceeds meta (20 min)
      const teamAvgThreshold = teamAvgTme * 1.5;

      const flaggedOrders: TmeImpOrderEvidence[] = [];
      const allOrders: TmeImpOrderEvidence[] = [];
      let countTmeMuitoAlto = 0;
      let countSemDeslocamento = 0;
      let countSemExecucao = 0;

      for (const row of teamRows) {
        const tmeMin = tmeImpCol ? parseNumber(String(row[tmeImpCol] ?? '')) : null;
        const tlMin  = tlOrdemCol ? parseNumber(String(row[tlOrdemCol] ?? '')) : null;
        const trMin  = trOrdemCol ? parseNumber(String(row[trOrdemCol] ?? '')) : null;
        const aCaminho = aCaminhoCol ? String(row[aCaminhoCol] ?? '').trim() : '';
        const trValid = trMin !== null && Number.isFinite(trMin) && trMin > 0;
        const tlValid = tlMin !== null && Number.isFinite(tlMin) && tlMin > 0;
        const tmeValid = tmeMin !== null && Number.isFinite(tmeMin) && tmeMin > 0;

        const flags: TmeImpOrderEvidence['flags'] = [];
        const exceedsTeamAvg = tmeValid && teamAvgTme > 0 && tmeMin! >= teamAvgThreshold;
        const exceedsMeta = tmeValid && tmeMin! > TME_IMP_META;
        if (exceedsTeamAvg || exceedsMeta) { flags.push('tme_muito_alto'); countTmeMuitoAlto++; }
        if (!aCaminho && tlValid)                { flags.push('sem_deslocamento'); countSemDeslocamento++; }
        if (!trValid && tmeValid)                { flags.push('sem_execucao'); countSemExecucao++; }

        const nrOrdem = nrOrdemCol ? String(row[nrOrdemCol] ?? '').trim() : '';
        // Always track for "Ver mais" expansion (regardless of flags)
        allOrders.push({
          date_ref:          dateCol       ? String(row[dateCol] ?? '').trim()       : '',
          nr_ordem:          nrOrdem,
          classe:            classeCol     ? String(row[classeCol] ?? '').trim()     : '',
          causa:             causaCol      ? String(row[causaCol] ?? '').trim()      : '',
          prev_liberada:     prevLiberadaMap.get(nrOrdem) ?? '',
          despachada:        despachadaCol ? String(row[despachadaCol] ?? '').trim() : '',
          a_caminho:         aCaminho,
          no_local:          noLocalCol    ? String(row[noLocalCol] ?? '').trim()    : '',
          liberada:          liberadaCol   ? String(row[liberadaCol] ?? '').trim()   : '',
          tr_ordem_min:      trValid ? round2(trMin!) : 0,
          tl_ordem_min:      tlValid ? round2(tlMin!) : 0,
          tme_imp_min:       tmeValid ? round2(tmeMin!) : 0,
          team_avg_tme_min:  round2(teamAvgTme),
          global_avg_tme_min: round2(globalAvgTme),
          flags: [],
        });

        if (flags.length === 0) continue;

        flaggedOrders.push({
          date_ref:          dateCol       ? String(row[dateCol] ?? '').trim()       : '',
          nr_ordem:          nrOrdem,
          classe:            classeCol     ? String(row[classeCol] ?? '').trim()     : '',
          causa:             causaCol      ? String(row[causaCol] ?? '').trim()      : '',
          prev_liberada:     prevLiberadaMap.get(nrOrdem) ?? '',
          despachada:        despachadaCol ? String(row[despachadaCol] ?? '').trim() : '',
          a_caminho:         aCaminho,
          no_local:          noLocalCol    ? String(row[noLocalCol] ?? '').trim()    : '',
          liberada:          liberadaCol   ? String(row[liberadaCol] ?? '').trim()   : '',
          tr_ordem_min:      trValid ? round2(trMin!) : 0,
          tl_ordem_min:      tlValid ? round2(tlMin!) : 0,
          tme_imp_min:       tmeValid ? round2(tmeMin!) : 0,
          team_avg_tme_min:  round2(teamAvgTme),
          global_avg_tme_min: round2(globalAvgTme),
          flags,
        });
      }

      // Sort: highest TME IMP first
      flaggedOrders.sort((a, b) => b.tme_imp_min - a.tme_imp_min);

      const topTmeImpFlagged = flaggedOrders.slice(0, 10);
      const enrichedFlaggedOrders = enrichTmeImpEvidence(topTmeImpFlagged);
      // Extras: all orders (flagged + non-flagged) not in top-displayed
      const topTmeKeys = new Set(topTmeImpFlagged.map(o => o.nr_ordem || `${o.despachada}|${o.a_caminho}`));
      const flaggedTmeById = new Map(flaggedOrders.map(o => [o.nr_ordem || `${o.despachada}|${o.a_caminho}`, o]));
      const allTmeExtra = allOrders
        .filter(o => !topTmeKeys.has(o.nr_ordem || `${o.despachada}|${o.a_caminho}`))
        .map(o => flaggedTmeById.get(o.nr_ordem || `${o.despachada}|${o.a_caminho}`) ?? o);
      const extraEnrichedFlaggedOrders = allTmeExtra.length ? enrichTmeImpEvidence(allTmeExtra) : [];

      result.push({
        team,
        tmeImpValue,
        metaTarget: TME_IMP_META,
        gap: round2(tmeImpValue - TME_IMP_META),
        avgTmeImpMin: round2(teamAvgTme),
        globalAvgTmeImpMin: round2(globalAvgTme),
        totalOrders: teamRows.length,
        flaggedOrders: enrichedFlaggedOrders,
        extraFlaggedOrders: extraEnrichedFlaggedOrders,
        summary: { countTmeMuitoAlto, countSemDeslocamento, countSemExecucao },
      });
    }

    return result.sort((a, b) => b.tmeImpValue - a.tmeImpValue);
  }

  // ─── 1º Login Analyzer ────────────────────────────────────────────────────
