// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import type { CsvRow } from '../csv-utils.js';
import type { DespachoRangeInsight, DespachoIncidence } from '../types.js';
import { createAccessor, parseDateTimeBr, minutesBetween, round2, parseNumber, applyIntervalDiscount } from '../csv-utils.js';

export function analyzeDespacho(
  deslocRows: CsvRow[],
  resolvedTeams: Map<string, { base: string; teamType: 'propria' | 'parceira' }>
): DespachoRangeInsight[] {
  if (!deslocRows || deslocRows.length === 0) {
    return [];
  }

  const accessor = createAccessor(deslocRows[0]);
  const teamCol = accessor.resolve(['Equipe', 'Team', 'Equipe Nome']);
  const dateCol = accessor.resolve(['Data Referência', 'Data Referencia']);
  const caminhoCol = accessor.resolve(['A_Caminho', 'A Caminho']);
  const despachadaCol = accessor.resolve(['Despachada']);
  const liberadaCol = accessor.resolve(['Liberada']);
  const tipoEquipeCol = accessor.resolve(['Parceira', 'TIPO_EQUIPE', 'Tipo Equipe', 'TIPO EQUIPE', 'Classificação']);
  const nrOrdemCol = accessor.resolve(['Nr_Ordem', 'Nr Ordem', 'Ordem', 'nr_ordem']);
  const inicioCalendarioAggCol = accessor.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
  const inicioIntervaloCol = accessor.resolve(['Inicio Intervalo', 'Início Intervalo']);
  const fimIntervaloCol = accessor.resolve(['Fim Intervalo']);
  const intervaloCol = accessor.resolve(['Intervalo']);
  const logInCorrigidoCol = accessor.resolve(['Log In Corrigido', 'LogIn Corrigido', 'Login Corrigido']);

  if (!teamCol || !dateCol || !caminhoCol || !despachadaCol || !liberadaCol) {
    return [];
  }

  // 1. Collect all "Sem Ordem" incidents (including 1st order of the day and Entre OS)
  const allIncidences: DespachoIncidence[] = [];

  const groupedByTeamDate = new Map<string, CsvRow[]>();
  for (const row of deslocRows) {
    const team = String(row[teamCol] ?? '').trim();
    const date = String(row[dateCol] ?? '').trim();
    if (!team || !date) continue;
    const key = `${team}::${date}`;
    const rows = groupedByTeamDate.get(key) ?? [];
    rows.push(row);
    groupedByTeamDate.set(key, rows);
  }

  for (const rows of groupedByTeamDate.values()) {
    const orderedRows = [...rows].sort((a, b) => {
      const l = parseDateTimeBr(String(a[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const r = parseDateTimeBr(String(b[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return l - r;
    });

    for (let idx = 0; idx < orderedRows.length; idx++) {
      const currRow = orderedRows[idx];
      const prevRow = idx > 0 ? orderedRows[idx - 1] : null;

      let startRaw = '';
      let startReason = '';
      const despRaw = String(currRow[despachadaCol] ?? '').trim();

      if (idx === 0) {
        const inicioCalRaw = inicioCalendarioAggCol ? String(currRow[inicioCalendarioAggCol] ?? '').trim() : '';
        const logInRaw = logInCorrigidoCol ? String(currRow[logInCorrigidoCol] ?? '').trim() : '';

        const inicioCalDt = parseDateTimeBr(inicioCalRaw);
        const logInDt = parseDateTimeBr(logInRaw);

        if (inicioCalDt && logInDt && logInDt.getTime() > inicioCalDt.getTime()) {
          startRaw = logInRaw;
          startReason = 'Log In';
        } else {
          startRaw = inicioCalRaw;
          startReason = 'Início Cal.';
        }
      } else {
        startRaw = prevRow ? String(prevRow[liberadaCol] ?? '').trim() : '';
        startReason = 'Lib. Anterior';
      }

      const startDt = parseDateTimeBr(startRaw);
      const despDt = parseDateTimeBr(despRaw);

      if (!startDt || !despDt) continue;

      let diffMin = minutesBetween(despDt, startDt);

      let intervaloStr: 'Sim' | 'Não' = 'Não';
      const inicioIntervaloDt = inicioIntervaloCol ? parseDateTimeBr(String(currRow[inicioIntervaloCol] ?? '').trim()) : null;
      const fimIntervaloDt = fimIntervaloCol ? parseDateTimeBr(String(currRow[fimIntervaloCol] ?? '').trim()) : null;

      if (inicioIntervaloDt && fimIntervaloDt) {
        const insideTolerance = inicioIntervaloDt.getTime() >= startDt.getTime() - 10 * 60_000 &&
                                fimIntervaloDt.getTime() <= despDt.getTime() + 10 * 60_000;
        if (insideTolerance) {
          const intervaloMinutes = parseNumber(String(currRow[intervaloCol ?? ''] ?? ''));
          diffMin = applyIntervalDiscount(diffMin, intervaloMinutes);
          intervaloStr = 'Sim';
        }
      }

      // Only consider values > 15 mins to avoid minor gaps, and < 8 hours (480 mins) to avoid overnight outliers
      if (Number.isFinite(diffMin) && diffMin > 15 && diffMin < 480) {
        const team = String(currRow[teamCol] ?? '').trim();
        const dateRef = String(currRow[dateCol] ?? '').trim();
        const nrOrdem = nrOrdemCol ? String(currRow[nrOrdemCol] ?? '').trim() : '';
        const teamUpper = team.toUpperCase();
        
        // Use resolvedTeams to find if the team is propria or parceira.
        let teamType: 'propria' | 'parceira' = 'parceira'; // Default fallback
        if (resolvedTeams.has(teamUpper)) {
          teamType = resolvedTeams.get(teamUpper)!.teamType;
        } else {
          const tipoVal = tipoEquipeCol ? String(currRow[tipoEquipeCol] ?? '').trim().toUpperCase() : '';
          teamType = (tipoVal === 'N' || tipoVal === 'NÃO' || tipoVal === 'PROPRIA' || tipoVal === 'PRÓPRIA') ? 'propria' : 'parceira';
        }
        
        allIncidences.push({
          team,
          teamType,
          dateRef,
          nrOrdem,
          start: startRaw,
          startReason,
          end: despRaw,
          durationMin: diffMin,
          lastLiberada: startRaw,
          intervalo: intervaloStr
        });
      }
    }
  }

  // 2. Group into 3-hour ranges based on start time (prevLib)
  const ranges = [
    { id: '00:00 - 03:00', startH: 0, endH: 3 },
    { id: '03:00 - 06:00', startH: 3, endH: 6 },
    { id: '06:00 - 09:00', startH: 6, endH: 9 },
    { id: '09:00 - 12:00', startH: 9, endH: 12 },
    { id: '12:00 - 15:00', startH: 12, endH: 15 },
    { id: '15:00 - 18:00', startH: 15, endH: 18 },
    { id: '18:00 - 21:00', startH: 18, endH: 21 },
    { id: '21:00 - 00:00', startH: 21, endH: 24 }
  ];

  const rangeBuckets = new Map<string, DespachoIncidence[]>();
  for (const r of ranges) {
    rangeBuckets.set(r.id, []);
  }

  for (const inc of allIncidences) {
    const startDt = parseDateTimeBr(inc.start);
    const endDt = parseDateTimeBr(inc.end);
    if (!startDt || !endDt) continue;
    
    // Normalize to the midnight of the start date
    const midnight = new Date(startDt.getFullYear(), startDt.getMonth(), startDt.getDate());
    
    let bestRange = null;
    let maxOverlap = -1;
    let is51Percent = false;
    
    for (const r of ranges) {
      const rangeStartMs = midnight.getTime() + (r.startH * 60) * 60000;
      const rangeEndMs = midnight.getTime() + (r.endH * 60) * 60000;
      
      const s = startDt.getTime();
      const e = endDt.getTime();
      
      const overlapStart = Math.max(s, rangeStartMs);
      const overlapEnd = Math.min(e, rangeEndMs);
      const overlapDuration = Math.max(0, overlapEnd - overlapStart);
      const totalDuration = Math.max(0, e - s);
      
      const isCompletelyInside = s >= rangeStartMs && e <= rangeEndMs;
      const ratio = totalDuration > 0 ? overlapDuration / totalDuration : (isCompletelyInside ? 1 : 0);
      
      if (isCompletelyInside || ratio >= 0.51) {
        bestRange = r;
        is51Percent = true;
        break;
      }
      
      if (overlapDuration > maxOverlap) {
        maxOverlap = overlapDuration;
        bestRange = r;
      }
    }
    
    if (bestRange && (is51Percent || maxOverlap > 0)) {
      rangeBuckets.get(bestRange.id)!.push(inc);
    }
  }

  // 3. Compute metrics for each range
  const insights: DespachoRangeInsight[] = [];
  for (const r of ranges) {
    const bucket = rangeBuckets.get(r.id)!;
    if (bucket.length === 0) continue;

    const totalMin = bucket.reduce((sum, inc) => sum + inc.durationMin, 0);
    const avgMin = round2(totalMin / bucket.length);

    // Get most affected teams (Proprias & Parceiras)
    const teamAvgMap = new Map<string, { type: string; sum: number; count: number }>();
    for (const inc of bucket) {
      const entry = teamAvgMap.get(inc.team) ?? { type: inc.teamType, sum: 0, count: 0 };
      entry.sum += inc.durationMin;
      entry.count++;
      teamAvgMap.set(inc.team, entry);
    }

    const teamAvgs = Array.from(teamAvgMap.entries()).map(([t, data]) => ({
      team: t,
      type: data.type,
      avg: data.sum / data.count,
      total: data.sum
    }));

    // Sort by average duration descending
    teamAvgs.sort((a, b) => b.avg - a.avg);

    const proprias = teamAvgs.filter(t => t.type === 'propria').slice(0, 3).map(t => t.team);
    const sortedProprias = teamAvgs.filter(t => t.type === 'propria');
    const sortedParceiras = teamAvgs.filter(t => t.type === 'parceira');

    const sortedBucket = [...bucket].sort((a, b) => b.durationMin - a.durationMin);
    const topIncidences = sortedBucket.slice(0, 5);

    insights.push({
      rangeId: r.id,
      rangeStart: r.startH.toString().padStart(2, '0') + ':00',
      rangeEnd: r.endH.toString().padStart(2, '0') + ':00',
      averageEntreOsMin: avgMin,
      totalIncidences: bucket.length,
      mostAffectedProprias: sortedProprias.slice(0, 3).map(t => t.team),
      mostAffectedParceiras: sortedParceiras.slice(0, 3).map(t => t.team),
      topIncidences
    });
  }

  // 4. Sort ranges by averageEntreOsMin descending and pick top 5
  insights.sort((a, b) => b.averageEntreOsMin - a.averageEntreOsMin);
  return insights.slice(0, 5);
}
