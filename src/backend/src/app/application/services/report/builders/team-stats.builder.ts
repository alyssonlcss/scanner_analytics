import type { CsvRow } from '../csv-utils.js';
import type { TeamMetricSummary, TempSemOsRow } from '../types.js';
import { createAccessor, parseNumber, parseDateTimeBr, minutesBetween, applyIntervalDiscount, round2, safeSum } from '../csv-utils.js';

export function calculateTempPrepSemOs(rows: CsvRow[], retornoBaseAvgMin: number): TempSemOsRow[] {
    if (rows.length === 0) {
      return [];
    }

    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe']);
    const dateCol = accessor.resolve(['Data Referência', 'Data Referencia']);
    const caminhoCol = accessor.resolve(['A_Caminho', 'A Caminho']);
    const despachadaCol = accessor.resolve(['Despachada']);
    const liberadaCol = accessor.resolve(['Liberada']);
    const firstDeslocCol = accessor.resolve(['1º Desloc', '1o Desloc']);
    const firstDespachoCol = accessor.resolve(['1º Despacho', '1o Despacho']);
    const intervaloCol = accessor.resolve(['Intervalo']);
    const inicioIntervaloCol = accessor.resolve(['Inicio Intervalo', 'Início Intervalo']);
    const fimIntervaloCol = accessor.resolve(['Fim Intervalo']);
    const inicioCalendarioAggCol = accessor.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
    const logOffCorrigidoCol = accessor.resolve(['Log Off Corrigido', 'LogOff Corrigido']);
    const retornoBaseCol = accessor.resolve(['Retorno a base', 'Retorno a Base', 'Retorno Base']);

    if (!teamCol || !dateCol || !caminhoCol || !despachadaCol || !liberadaCol || !firstDeslocCol || !firstDespachoCol) {
      return [];
    }

    const grouped = new Map<string, CsvRow[]>();

    for (const row of rows) {
      const key = `${row[teamCol] ?? ''}::${row[dateCol] ?? ''}`;
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }

    const output: TempSemOsRow[] = [];

    for (const groupRows of grouped.values()) {
      const ordered = [...groupRows].sort((a, b) => {
        const left = parseDateTimeBr(String(a[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const right = parseDateTimeBr(String(b[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return left - right;
      });

      if (ordered.length === 0) {
        continue;
      }

      const firstRow = ordered[0];
      const team = String(firstRow[teamCol] ?? '').trim();
      const dateRef = String(firstRow[dateCol] ?? '').trim();
      const firstIntervalMinutes = parseNumber(firstRow[intervaloCol ?? ''] as string);
      const semOsIntervalStart = inicioIntervaloCol ? parseDateTimeBr(String(firstRow[inicioIntervaloCol] ?? '')) : null;
      const semOsIntervalEnd = fimIntervaloCol ? parseDateTimeBr(String(firstRow[fimIntervaloCol] ?? '')) : null;

      const tempPrepValues: number[] = [];
      const semOsValues: number[] = [];
      let isInterACaminho = false;
      let isInterOrdem = false;

      tempPrepValues.push(parseNumber(String(firstRow[firstDeslocCol] ?? '')) ?? Number.NaN);
      {
        const firstDespachada    = parseDateTimeBr(String(firstRow[despachadaCol] ?? ''));
        const firstIniCalendario = inicioCalendarioAggCol ? parseDateTimeBr(String(firstRow[inicioCalendarioAggCol] ?? '')) : null;
        const semOsFirst = (firstDespachada && firstIniCalendario)
          ? (firstDespachada.getTime() - firstIniCalendario.getTime()) / 60000
          : Number.NaN;
        semOsValues.push(Number.isFinite(semOsFirst) ? semOsFirst : Number.NaN);
      }

      for (let i = 1; i < ordered.length; i++) {
        const current = ordered[i];
        const previous = ordered[i - 1];

        const aCaminho = parseDateTimeBr(String(current[caminhoCol] ?? ''));
        const despachada = parseDateTimeBr(String(current[despachadaCol] ?? ''));
        const liberada = parseDateTimeBr(String(previous[liberadaCol] ?? ''));
        const inicioIntervalo = inicioIntervaloCol ? parseDateTimeBr(String(current[inicioIntervaloCol] ?? '')) : null;
        const fimIntervalo = fimIntervaloCol ? parseDateTimeBr(String(current[fimIntervaloCol] ?? '')) : null;
        const intervaloMinutes = parseNumber(String(current[intervaloCol ?? ''] ?? ''));

        const tempPrep = calculateTempPrepValue({
          aCaminho,
          despachada,
          liberada,
          inicioIntervalo,
          fimIntervalo,
          intervaloMinutes,
          isIntervalAlreadyApplied: isInterACaminho,
        });

        if (tempPrep.intervalApplied) {
          isInterACaminho = true;
        }

        tempPrepValues.push(tempPrep.value);

        const semOs = calculateSemOsValue({
          despachada,
          liberada,
          inicioIntervalo: semOsIntervalStart,
          fimIntervalo: semOsIntervalEnd,
          intervaloMinutes: firstIntervalMinutes,
          isIntervalAlreadyApplied: isInterOrdem,
        });

        if (semOs.intervalApplied) {
          isInterOrdem = true;
        }

        semOsValues.push(semOs.value);
      }

      // SemOrdem: gap between last order's Liberada and Log Off Corrigido, minus 60min interval and retorno base avg
      if (logOffCorrigidoCol && liberadaCol) {
        const lastRow = ordered[ordered.length - 1];
        const lastLiberada = parseDateTimeBr(String(lastRow[liberadaCol] ?? ''));
        const logOff = parseDateTimeBr(String(lastRow[logOffCorrigidoCol] ?? ''));
        if (lastLiberada && logOff && logOff.getTime() > lastLiberada.getTime()) {
          let gapMin = minutesBetween(logOff, lastLiberada);
          // Discount 60min interval if it hasn't been applied yet
          const intStart = inicioIntervaloCol ? parseDateTimeBr(String(lastRow[inicioIntervaloCol] ?? '')) : null;
          const intEnd   = fimIntervaloCol    ? parseDateTimeBr(String(lastRow[fimIntervaloCol]    ?? '')) : null;
          let intervalDiscounted = false;
          if (!isInterOrdem && intStart && intEnd &&
              intStart.getTime() >= lastLiberada.getTime() &&
              intEnd.getTime() <= logOff.getTime()) {
            const intDuration = minutesBetween(intEnd, intStart);
            const discount = Math.min(intDuration, 60);
            gapMin -= discount;
            intervalDiscounted = true;
          }
          // Subtract Retorno a Base: use row value if present, otherwise fall back to average
          const retornoBaseRow = retornoBaseCol ? parseNumber(String(lastRow[retornoBaseCol] ?? '')) : null;
          const retornoBaseDiscount = (retornoBaseRow !== null && Number.isFinite(retornoBaseRow) && retornoBaseRow > 0)
            ? retornoBaseRow
            : retornoBaseAvgMin;
          if (retornoBaseDiscount > 0) {
            gapMin -= retornoBaseDiscount;
          }
          if (gapMin > 0) {
            semOsValues.push(gapMin);
          }
        }
      }

      const tempPrepJornada = safeSum(tempPrepValues);
      const semOrdemJornada = safeSum(semOsValues);

      for (let i = 0; i < ordered.length; i++) {
        output.push({
          team,
          dateRef,
          tempPrep: tempPrepValues[i] ?? Number.NaN,
          semOsEntreOs: semOsValues[i] ?? Number.NaN,
          tempPrepJornada,
          semOrdemJornada,
        });
      }
    }

    return output;
  }

export function calculateTempPrepValue(input: {
    aCaminho: Date | null;
    despachada: Date | null;
    liberada: Date | null;
    inicioIntervalo: Date | null;
    fimIntervalo: Date | null;
    intervaloMinutes: number | null;
    isIntervalAlreadyApplied: boolean;
  }): { value: number; intervalApplied: boolean } {
    const {
      aCaminho,
      despachada,
      liberada,
      inicioIntervalo,
      fimIntervalo,
      intervaloMinutes,
      isIntervalAlreadyApplied,
    } = input;

    if (!aCaminho || !liberada) {
      return { value: Number.NaN, intervalApplied: false };
    }

    let value = Number.NaN;
    let intervalApplied = false;
    let shouldApplyDiscount = false;

    if (despachada && despachada.getTime() > liberada.getTime()) {
      const interceptsDispatch = Boolean(
        inicioIntervalo &&
        fimIntervalo &&
        liberada.getTime() < inicioIntervalo.getTime() &&
        inicioIntervalo.getTime() < despachada.getTime() &&
        despachada.getTime() < fimIntervalo.getTime() &&
        fimIntervalo.getTime() <= aCaminho.getTime() &&
        !isIntervalAlreadyApplied,
      );

      if (interceptsDispatch && fimIntervalo && inicioIntervalo) {
        value = minutesBetween(aCaminho, fimIntervalo);
        const duration = minutesBetween(fimIntervalo, inicioIntervalo);
        if (duration > 60) {
          value += duration - 60;
        }
        intervalApplied = true;
      } else {
        value = minutesBetween(aCaminho, despachada);

        const insideTolerance = Boolean(
          inicioIntervalo &&
          fimIntervalo &&
          inicioIntervalo.getTime() >= despachada.getTime() - 10 * 60_000 &&
          fimIntervalo.getTime() <= aCaminho.getTime() + 10 * 60_000 &&
          !isIntervalAlreadyApplied,
        );

        if (insideTolerance) {
          intervalApplied = true;
          shouldApplyDiscount = true;
        }
      }
    } else {
      const intervalBetweenLiberadaAndCaminho = Boolean(
        inicioIntervalo &&
        fimIntervalo &&
        liberada.getTime() < inicioIntervalo.getTime() &&
        fimIntervalo.getTime() < aCaminho.getTime() &&
        !isIntervalAlreadyApplied,
      );

      if (intervalBetweenLiberadaAndCaminho && inicioIntervalo && fimIntervalo) {
        value = minutesBetween(aCaminho, fimIntervalo);
        const duration = minutesBetween(fimIntervalo, inicioIntervalo);
        if (duration > 60) {
          value += duration - 60;
        }
        intervalApplied = true;
      } else {
        value = minutesBetween(aCaminho, liberada);

        const insideTolerance = Boolean(
          inicioIntervalo &&
          fimIntervalo &&
          inicioIntervalo.getTime() >= liberada.getTime() - 10 * 60_000 &&
          fimIntervalo.getTime() <= aCaminho.getTime() + 10 * 60_000 &&
          !isIntervalAlreadyApplied,
        );

        if (insideTolerance) {
          intervalApplied = true;
          shouldApplyDiscount = true;
        }
      }
    }

    if (shouldApplyDiscount) {
      value = applyIntervalDiscount(value, intervaloMinutes);
    }

    return { value, intervalApplied };
  }

export function calculateSemOsValue(input: {
    despachada: Date | null;
    liberada: Date | null;
    inicioIntervalo: Date | null;
    fimIntervalo: Date | null;
    intervaloMinutes: number | null;
    isIntervalAlreadyApplied: boolean;
  }): { value: number; intervalApplied: boolean } {
    const {
      despachada,
      liberada,
      inicioIntervalo,
      fimIntervalo,
      intervaloMinutes,
      isIntervalAlreadyApplied,
    } = input;

    if (!despachada || !liberada) {
      return { value: Number.NaN, intervalApplied: false };
    }

    if (despachada.getTime() <= liberada.getTime()) {
      return { value: Number.NaN, intervalApplied: false };
    }

    const interceptsDispatch = Boolean(
      inicioIntervalo &&
      fimIntervalo &&
      liberada.getTime() < inicioIntervalo.getTime() &&
      inicioIntervalo.getTime() < despachada.getTime() &&
      despachada.getTime() < fimIntervalo.getTime() &&
      !isIntervalAlreadyApplied,
    );

    if (interceptsDispatch && inicioIntervalo) {
      return {
        value: minutesBetween(inicioIntervalo, liberada),
        intervalApplied: true,
      };
    }

    let value = minutesBetween(despachada, liberada);

    const insideTolerance = Boolean(
      inicioIntervalo &&
      fimIntervalo &&
      inicioIntervalo.getTime() >= liberada.getTime() - 10 * 60_000 &&
      fimIntervalo.getTime() <= despachada.getTime() + 10 * 60_000 &&
      !isIntervalAlreadyApplied,
    );

    if (insideTolerance) {
      value = applyIntervalDiscount(value, intervaloMinutes);
      return { value, intervalApplied: true };
    }

    return { value, intervalApplied: false };
  }

export function buildTeamMetrics(rows: TempSemOsRow[]): TeamMetricSummary[] {
    // Collect unique (team, dateRef) — jornada values are the same for every row within a group
    const dayTotals = new Map<string, { team: string; tempPrepJornada: number; semOrdemJornada: number }>();

    for (const row of rows) {
      const dayKey = `${row.team}\x00${row.dateRef}`;
      if (!dayTotals.has(dayKey)) {
        dayTotals.set(dayKey, {
          team: row.team,
          tempPrepJornada: Number.isFinite(row.tempPrepJornada) ? row.tempPrepJornada : 0,
          semOrdemJornada: Number.isFinite(row.semOrdemJornada) ? row.semOrdemJornada : 0,
        });
      }
    }

    // Aggregate across days and compute per-day average per team
    const grouped = new Map<string, TeamMetricSummary>();

    for (const day of dayTotals.values()) {
      const current = grouped.get(day.team) ?? {
        team: day.team,
        records: 0,
        tempPrepJornada: 0,
        semOrdemJornada: 0,
      };

      current.records += 1;
      current.tempPrepJornada += day.tempPrepJornada;
      current.semOrdemJornada += day.semOrdemJornada;
      grouped.set(day.team, current);
    }

    return Array.from(grouped.values())
      .map((item) => ({
        ...item,
        tempPrepJornada: round2(item.tempPrepJornada / Math.max(item.records, 1)),
        semOrdemJornada: round2(item.semOrdemJornada / Math.max(item.records, 1)),
      }))
      .sort((a, b) => b.semOrdemJornada - a.semOrdemJornada);
  }

