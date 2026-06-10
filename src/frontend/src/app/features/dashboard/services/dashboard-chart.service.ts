import { Injectable } from '@angular/core';
import type { GeneratedReport } from '../../../core/api/scanner-api.service';

@Injectable({ providedIn: 'root' })
export class DashboardChartService {

  readonly CHART_COLORS = [
    '#2563eb', '#c0122d', '#16a34a', '#d97706', '#7c3aed',
    '#0891b2', '#db2777', '#65a30d', '#ea580c', '#6366f1',
    '#0d9488', '#b45309', '#9333ea', '#0284c7', '#dc2626',
    '#059669', '#d97706', '#4f46e5',
  ];

  // ─── Flag metadata for analytic drill-down ────────────────────────────────
  readonly FLAG_COLORS: Record<string, string> = {
    tr_excede_hd:          '#dc2626',
    tl_excede_hd:          '#7c3aed',
    temp_prep_alto:        '#2563eb',
    sem_os_alto:           '#c0122d',
    deslocamento_curto:    '#0891b2',
    tempo_padrao_vazio:    '#6b7280',
    tr_muito_baixo:        '#db2777',
    tme_muito_alto:        '#dc2626',
    sem_deslocamento:      '#0284c7',
    sem_execucao:          '#374151',
    login_tardio:          '#d97706',
    login_muito_tardio:    '#c0122d',
    desloc_lento:          '#7c3aed',
    desloc_muito_lento:    '#5b21b6',
    sem_desloc_registrado: '#6b7280',
    despacho_tardio:       '#ea580c',
    retorno_alto:          '#0d9488',
    retorno_muito_alto:    '#0f766e',
  };

  readonly SEM_OS_SUB_COLORS: Record<string, string> = {
    inicio_jornada:         '#ef4444',
    entre_ordens:           '#b91c1c',
    fim_jornada:            '#7f1d1d',
    intervalo_deslocamento: '#f97316',
  };

  readonly SEM_OS_SUB_LABELS: Record<string, string> = {
    inicio_jornada:         'Início da Jornada',
    entre_ordens:           'Entre Ordens',
    fim_jornada:            'Fim da Jornada',
    intervalo_deslocamento: 'Desl. de Intervalo',
  };

  getDeviationsForDay(
    deviations: Array<{ dateRef: string; flags: string[]; detail: string }>,
    day: string | null,
  ): Array<{ dateRef: string; flags: string[]; detail: string }> {
    if (!day) return deviations;
    return deviations.filter((d) => {
      if (d.dateRef === day) return true;
      // dayLabel may be dd/mm (from dailyTrend) while dateRef is dd/mm/yyyy — match prefix
      if (d.dateRef.startsWith(day + '/')) return true;
      // inverse: dateRef is dd/mm and dayLabel is dd/mm/yyyy
      if (day.startsWith(d.dateRef + '/')) return true;
      return false;
    });
  }

  getTeamFlagSummary(
    kpi: GeneratedReport['kpis'][number],
    team: string,
    report: GeneratedReport,
  ): Array<{
    flag: string;
    label: string;
    color: string;
    count: number;
    totalMin: number;
    subFlags: Array<{ type: string; label: string; color: string; count: number; totalMin: number }>;
  }> {
    if (!team) return [];
    const flagData = new Map<string, { count: number; totalMin: number }>();
    const semOsSubData = new Map<string, { count: number; totalMin: number }>();

    const bump = (map: Map<string, { count: number; totalMin: number }>, key: string, min: number) => {
      const prev = map.get(key) ?? { count: 0, totalMin: 0 };
      map.set(key, { count: prev.count + 1, totalMin: prev.totalMin + min });
    };

    switch (kpi.kpi) {
      case 'OS Dia': {
        const entry = report.specialAnalysis.osDiaAnalysis.find((a) => a.team === team);
        if (entry) {
          for (const order of entry.flaggedOrders) {
            for (const f of order.flags) {
              let min = 0;
              if (f === 'tr_excede_hd') min = order.tr_ordem_min;
              else if (f === 'tl_excede_hd') min = order.tl_ordem_min;
              else if (f === 'temp_prep_alto') min = order.temp_prep_os_min ?? 0;
              else if (f === 'sem_os_alto') min = order.sem_os_total_min ?? 0;
              bump(flagData, f, min);
              if (f === 'sem_os_alto' && order.sem_os_details) {
                for (const d of order.sem_os_details) {
                  bump(semOsSubData, d.type, d.min ?? 0);
                }
              }
            }
          }
        }
        break;
      }
      case 'Eficiência': {
        const entry = kpi.evidenceAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const order of entry.flaggedOrders) {
            for (const f of order.flags) {
              let min = 0;
              if (f === 'tr_excede_hd' || f === 'tr_muito_baixo') min = order.tr_ordem_min;
              else if (f === 'deslocamento_curto') min = order.tl_ordem_min;
              bump(flagData, f, min);
            }
          }
        }
        break;
      }
      case 'Utilização': {
        const entry = report.specialAnalysis.utilizacaoAnalysis.find((a) => a.team === team);
        if (entry) {
          for (const order of entry.flaggedOrders) {
            for (const f of order.flags) {
              let min = 0;
              if (f === 'temp_prep_alto') min = order.temp_prep_os_min ?? 0;
              else if (f === 'sem_os_alto') min = order.sem_os_total_min ?? 0;
              bump(flagData, f, min);
              if (f === 'sem_os_alto' && order.sem_os_details) {
                for (const d of order.sem_os_details) {
                  bump(semOsSubData, d.type, d.min ?? 0);
                }
              }
            }
          }
        }
        break;
      }
      case 'TME IMP': {
        const entry = kpi.tmeImpAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const order of entry.flaggedOrders) {
            for (const f of order.flags) {
              let min = 0;
              if (f === 'tme_muito_alto') min = order.tme_imp_min;
              else if (f === 'sem_deslocamento') min = order.tl_ordem_min;
              else if (f === 'sem_execucao') min = order.tr_ordem_min;
              bump(flagData, f, min);
            }
          }
        }
        break;
      }
      case '1º Login': {
        const entry = kpi.primeiroLoginAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const day of entry.flaggedDays) {
            for (const f of day.flags) {
              bump(flagData, f, day.primeiro_login_min ?? 0);
            }
          }
        }
        break;
      }
      case '1º Desloc.': {
        const entry = kpi.primeiroDeslocAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const day of entry.flaggedDays) {
            for (const f of day.flags) {
              let min = 0;
              if (f === 'desloc_lento' || f === 'desloc_muito_lento') min = day.primeiro_desloc_min ?? 0;
              else if (f === 'despacho_tardio') min = day.despacho_apos_inicio_min ?? 0;
              bump(flagData, f, min);
            }
          }
        }
        break;
      }
      case 'Retorno Base': {
        const entry = kpi.retornoBaseAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const day of entry.flaggedDays) {
            for (const f of day.flags) {
              bump(flagData, f, day.retorno_base_min ?? 0);
            }
          }
        }
        break;
      }
    }

    const colors = this.FLAG_COLORS;
    const flagLabels = report.flagMeta?.labels ?? {};
    const subColors = this.SEM_OS_SUB_COLORS;
    const subLabels = this.SEM_OS_SUB_LABELS;

    return [...flagData.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([flag, { count, totalMin }]) => ({
        flag,
        label: flagLabels[flag] ?? flag,
        color: colors[flag] ?? '#888',
        count,
        totalMin,
        subFlags: flag === 'sem_os_alto'
          ? [...semOsSubData.entries()]
              .sort((a, b) => b[1].count - a[1].count)
              .map(([type, { count: cnt, totalMin: subMin }]) => ({
                type,
                label: subLabels[type] ?? type,
                color: subColors[type] ?? '#c0122d',
                count: cnt,
                totalMin: subMin,
              }))
          : [],
      }));
  }

  getDayFlagSummary(
    kpi: GeneratedReport['kpis'][number],
    team: string,
    day: string | null,
    report: GeneratedReport,
  ): Array<{
    flag: string;
    label: string;
    color: string;
    count: number;
    totalMin: number;
    subFlags: Array<{ type: string; label: string; color: string; count: number; totalMin: number }>;
  }> {
    if (!team || !day) return [];

    const matchesDay = (dateRef: string | undefined): boolean => {
      // Records without a date reference are date-agnostic — include for any clicked day
      if (!dateRef) return true;
      if (dateRef === day) return true;
      if (dateRef.startsWith(day + '/')) return true;
      if (day.startsWith(dateRef + '/')) return true;
      return false;
    };

    const flagData = new Map<string, { count: number; totalMin: number }>();
    const semOsSubData = new Map<string, { count: number; totalMin: number }>();

    const bump = (map: Map<string, { count: number; totalMin: number }>, key: string, min: number) => {
      const prev = map.get(key) ?? { count: 0, totalMin: 0 };
      map.set(key, { count: prev.count + 1, totalMin: prev.totalMin + min });
    };

    switch (kpi.kpi) {
      case 'OS Dia': {
        const entry = report.specialAnalysis.osDiaAnalysis.find((a) => a.team === team);
        if (entry) {
          for (const order of entry.flaggedOrders) {
            if (!matchesDay(order.date_ref)) continue;
            for (const f of order.flags) {
              let min = 0;
              if (f === 'tr_excede_hd') min = order.tr_ordem_min;
              else if (f === 'tl_excede_hd') min = order.tl_ordem_min;
              else if (f === 'temp_prep_alto') min = order.temp_prep_os_min ?? 0;
              else if (f === 'sem_os_alto') min = order.sem_os_total_min ?? 0;
              bump(flagData, f, min);
              if (f === 'sem_os_alto' && order.sem_os_details) {
                for (const d of order.sem_os_details) {
                  bump(semOsSubData, d.type, d.min ?? 0);
                }
              }
            }
          }
        }
        break;
      }
      case 'Eficiência': {
        const entry = kpi.evidenceAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const order of entry.flaggedOrders) {
            if (!matchesDay(order.date_ref)) continue;
            for (const f of order.flags) {
              let min = 0;
              if (f === 'tr_excede_hd' || f === 'tr_muito_baixo') min = order.tr_ordem_min;
              else if (f === 'deslocamento_curto') min = order.tl_ordem_min;
              bump(flagData, f, min);
            }
          }
        }
        break;
      }
      case 'Utilização': {
        const entry = report.specialAnalysis.utilizacaoAnalysis.find((a) => a.team === team);
        if (entry) {
          for (const order of entry.flaggedOrders) {
            if (!matchesDay(order.date_ref)) continue;
            for (const f of order.flags) {
              let min = 0;
              if (f === 'temp_prep_alto') min = order.temp_prep_os_min ?? 0;
              else if (f === 'sem_os_alto') min = order.sem_os_total_min ?? 0;
              bump(flagData, f, min);
              if (f === 'sem_os_alto' && order.sem_os_details) {
                for (const d of order.sem_os_details) {
                  bump(semOsSubData, d.type, d.min ?? 0);
                }
              }
            }
          }
        }
        break;
      }
      case 'TME IMP': {
        const entry = kpi.tmeImpAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const order of entry.flaggedOrders) {
            if (!matchesDay(order.date_ref)) continue;
            for (const f of order.flags) {
              let min = 0;
              if (f === 'tme_muito_alto') min = order.tme_imp_min;
              else if (f === 'sem_deslocamento') min = order.tl_ordem_min;
              else if (f === 'sem_execucao') min = order.tr_ordem_min;
              bump(flagData, f, min);
            }
          }
        }
        break;
      }
      case '1º Login': {
        const entry = kpi.primeiroLoginAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const d of entry.flaggedDays) {
            if (!matchesDay(d.date_ref)) continue;
            for (const f of d.flags) {
              bump(flagData, f, d.primeiro_login_min ?? 0);
            }
          }
        }
        break;
      }
      case '1º Desloc.': {
        const entry = kpi.primeiroDeslocAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const d of entry.flaggedDays) {
            if (!matchesDay(d.date_ref)) continue;
            for (const f of d.flags) {
              let min = 0;
              if (f === 'desloc_lento' || f === 'desloc_muito_lento') min = d.primeiro_desloc_min ?? 0;
              else if (f === 'despacho_tardio') min = d.despacho_apos_inicio_min ?? 0;
              bump(flagData, f, min);
            }
          }
        }
        break;
      }
      case 'Retorno Base': {
        const entry = kpi.retornoBaseAnalysis?.find((a) => a.team === team);
        if (entry) {
          for (const d of entry.flaggedDays) {
            if (!matchesDay(d.date_ref)) continue;
            for (const f of d.flags) {
              bump(flagData, f, d.retorno_base_min ?? 0);
            }
          }
        }
        break;
      }
    }

    const colors = this.FLAG_COLORS;
    const flagLabels = report.flagMeta?.labels ?? {};
    const subColors = this.SEM_OS_SUB_COLORS;
    const subLabels = this.SEM_OS_SUB_LABELS;

    return [...flagData.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([flag, { count, totalMin }]) => ({
        flag,
        label: flagLabels[flag] ?? flag,
        color: colors[flag] ?? '#888',
        count,
        totalMin,
        subFlags: flag === 'sem_os_alto'
          ? [...semOsSubData.entries()]
              .sort((a, b) => b[1].count - a[1].count)
              .map(([type, { count: cnt, totalMin: subMin }]) => ({
                type,
                label: subLabels[type] ?? type,
                color: subColors[type] ?? '#c0122d',
                count: cnt,
                totalMin: subMin,
              }))
          : [],
      }));
  }

  getDayKpiValue(
    lines: Array<{ team: string; points: Array<{ dayLabel: string; displayVal: string }> }>,
    team: string,
    day: string | null,
  ): string | null {
    if (!day) return null;
    const teamLine = lines.find((l) => l.team === team);
    if (!teamLine) return null;
    const pt = teamLine.points.find((p) => p.dayLabel === day);
    return pt?.displayVal ?? null;
  }

  getDayDeviationTotal(dayFlags: Array<{ totalMin: number }>): number {
    return dayFlags.reduce((sum, f) => sum + f.totalMin, 0);
  }

  analyticChartData(kpi: GeneratedReport['kpis'][number], report: GeneratedReport | null): {
    lines: Array<{
      team: string;
      color: string;
      above: boolean;
      displayValue: string;
      polyline: string;
      points: Array<{ x: number; y: number; dayIndex: number; dayLabel: string; flagged: boolean; displayVal: string }>;
      deviations: Array<{ dateRef: string; flags: string[]; detail: string }>;
    }>;
    days: Array<{ x: number; label: string }>;
    metaY: number;
    avgY: number;
    yTicks: Array<{ y: number; label: string }>;
    padLeft: number;
    chartRight: number;
    labelBaseY: number;
    viewBox: string;
    trendLine: { polyline: string; points: Array<{ x: number; y: number; label: string; value: number }> } | null;
  } {
    const padLeft = 46, padRight = 52, padTop = 22, padBottom = 44;
    const svgW = 680, svgH = 230;
    const chartW = svgW - padLeft - padRight;
    const chartH = svgH - padTop - padBottom;
    const chartRight = padLeft + chartW;
    const labelBaseY = svgH - padBottom + 14;
    const innerPadX = 24; // horizontal inset so lines don't touch the left/right axes

    const colors = this.CHART_COLORS;
    const fmt = (v: number) => (v % 1 === 0 ? String(Math.round(v)) : v.toFixed(1));
    const aboveFn = (v: number) =>
      kpi.direction === 'higher-is-better' ? v >= kpi.metaTarget : v <= kpi.metaTarget;

    // ── Build flag-to-label map ───────────────────────────────────────────────
    const flagLabel = (f: string): string => ({
      tr_excede_hd:        'T.Reparo>HD',
      tl_excede_hd:        'T.Desloc.',
      temp_prep_alto:      'T.Partida≥10min',
      sem_os_alto:         'SemOS≥10min',
      deslocamento_curto:  'Desloc.Curto',
      tr_excede_hd_ef:     'T.Reparo>HD',
      tempo_padrao_vazio:  'TP Vazio',
      tr_muito_baixo:      'T.Reparo Baixo',
      tme_muito_alto:      'TME Alto',
      sem_deslocamento:    'Sem Desloc.',
      sem_execucao:        'Sem Exec.',
      login_tardio:        'Login Tardio',
      login_muito_tardio:  'Login Muito Tardio',
      desloc_lento:        'Desloc.Lento',
      desloc_muito_lento:  'Desloc.Muito Lento',
      sem_desloc_registrado: 'Sem Desloc.',
      despacho_tardio:     'Desp.Tardio',
      retorno_alto:        'Retorno Alto',
      retorno_muito_alto:  'Retorno Muito Alto',
    }[f] ?? f);

    // ── Extract per-team deviation events keyed by dateRef ───────────────────
    type DevEvent = { dateRef: string; flags: string[]; detail: string };

    const buildDevMap = (team: string): Map<string, DevEvent> => {
      const map = new Map<string, DevEvent>();
      const add = (dateRef: string, flags: string[], detail?: string) => {
        const key = dateRef;
        const existing = map.get(key);
        if (existing) {
          for (const f of flags) if (!existing.flags.includes(f)) existing.flags.push(f);
          if (detail && !existing.detail.includes(detail)) existing.detail += ' · ' + detail;
        } else {
          map.set(key, { dateRef, flags: [...flags], detail: detail ?? '' });
        }
      };

      const specialAnalysisMap: Record<string, Array<{ team: string; flaggedOrders?: Array<{ date_ref?: string; flags: string[]; nr_ordem?: string; classe?: string; causa?: string }>; flaggedDays?: Array<{ date_ref?: string; flags: string[] }> }>> = {};

      // Map kpi.kpi → specialAnalysis field
      if (kpi.evidenceAnalysis)       specialAnalysisMap['Eficiência']   = kpi.evidenceAnalysis as ReturnType<typeof Object.values>[0];
      if (kpi.tmeImpAnalysis)         specialAnalysisMap['TME IMP']      = kpi.tmeImpAnalysis as ReturnType<typeof Object.values>[0];
      if (kpi.primeiroLoginAnalysis)  specialAnalysisMap['1º Login']     = kpi.primeiroLoginAnalysis as ReturnType<typeof Object.values>[0];
      if (kpi.primeiroDeslocAnalysis) specialAnalysisMap['1º Desloc.']   = kpi.primeiroDeslocAnalysis as ReturnType<typeof Object.values>[0];
      if (kpi.retornoBaseAnalysis)    specialAnalysisMap['Retorno Base'] = kpi.retornoBaseAnalysis as ReturnType<typeof Object.values>[0];

      // OS Dia and Utilização live in specialAnalysis (not attached to the kpi object)
      if (report) {
        if (kpi.kpi === 'OS Dia')       specialAnalysisMap['OS Dia']      = report.specialAnalysis.osDiaAnalysis as ReturnType<typeof Object.values>[0];
        if (kpi.kpi === 'Utilização')   specialAnalysisMap['Utilização']  = report.specialAnalysis.utilizacaoAnalysis as ReturnType<typeof Object.values>[0];
      }

      const teamAnalysisList = specialAnalysisMap[kpi.kpi] ?? [];
      const teamEntry = teamAnalysisList.find((a) => a.team === team);

      if (teamEntry) {
        (teamEntry.flaggedOrders ?? []).forEach((o) => {
          if (o.date_ref) {
            const detail = [o.nr_ordem, o.classe, o.causa].filter(Boolean).join(' — ');
            add(o.date_ref, o.flags.map(flagLabel), detail);
          }
        });
        (teamEntry.flaggedDays ?? []).forEach((d) => {
          if (d.date_ref) add(d.date_ref, d.flags.map(flagLabel));
        });
      }
      return map;
    };

    // ── Determine X-axis days: prefer dailyTrend dates, fall back to deviation dates ──
    const parseDay = (s: string): number => {
      const parts = s.split('/');
      const d = parseInt(parts[0] ?? '0', 10);
      const m2 = parseInt(parts[1] ?? '1', 10);
      const y = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m2 * 100 + d;
    };

    const hasDailyTrend = Array.isArray(kpi.dailyTrend) && kpi.dailyTrend.length > 0;

    let sortedDays: string[];
    if (hasDailyTrend) {
      // Start with dailyTrend dates (already sorted chronologically by backend)
      const trendDateSet = new Set(kpi.dailyTrend!.map((pt) => pt.date));
      // Also collect any flagged dates from deviation maps that may fall outside the trend window.
      // Deviation map keys are "dd/mm/yyyy" — convert to "dd/mm" to keep the same format as dailyTrend.
      const allDaySet = new Set<string>(trendDateSet);
      for (const score of kpi.scores) {
        const m = buildDevMap(score.team);
        for (const k of m.keys()) {
          const parts = k.split('/');
          const ddMm = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : k;
          if (!trendDateSet.has(ddMm)) allDaySet.add(ddMm);
        }
      }
      sortedDays = [...allDaySet].sort((a, b) => parseDay(a) - parseDay(b));
    } else {
      // Fallback: collect dates from per-team deviation events
      const allDaySet = new Set<string>();
      for (const score of kpi.scores) {
        const m = buildDevMap(score.team);
        for (const k of m.keys()) allDaySet.add(k);
      }
      sortedDays = [...allDaySet].sort((a, b) => parseDay(a) - parseDay(b));
    }

    // If still no date data, fall back to rank positions as fake "days"
    const noDayData = sortedDays.length === 0;
    if (noDayData) {
      sortedDays = kpi.scores
        .sort((a, b) => kpi.direction === 'higher-is-better' ? b.rawValue - a.rawValue : a.rawValue - b.rawValue)
        .map((_, i) => String(i + 1));
    }

    const D = sortedDays.length;
    const toX = (i: number) => padLeft + innerPadX + (D > 1 ? (i / (D - 1)) * (chartW - 2 * innerPadX) : (chartW - 2 * innerPadX) / 2);

    // ── Build per-team daily lookup (for non-flat team lines) ─────────────────
    const perTeamDailyMap = new Map<string, Map<string, number>>();
    if (kpi.perTeamDailyData) {
      for (const teamData of kpi.perTeamDailyData) {
        const dateMap = new Map<string, number>();
        for (const dp of teamData.dailyPoints) {
          dateMap.set(dp.date, dp.value);
        }
        perTeamDailyMap.set(teamData.team, dateMap);
      }
    }

    // ── Y scale: include team values, meta, average, trend values, and per-day values ──
    const trendValues = hasDailyTrend ? kpi.dailyTrend!.map((pt) => pt.avgValue) : [];
    const perTeamValues = kpi.perTeamDailyData
      ? kpi.perTeamDailyData.flatMap((t) => t.dailyPoints.map((p) => p.value))
      : [];
    const allVals = [
      ...kpi.scores.map((s) => s.rawValue),
      kpi.metaTarget,
      kpi.average,
      ...trendValues,
      ...perTeamValues,
    ];
    let minVal = Math.min(...allVals);
    let maxVal = Math.max(...allVals);
    const buf = Math.max((maxVal - minVal) * 0.18, 0.1);
    minVal = Math.max(0, minVal - buf);
    maxVal = maxVal + buf;
    const toY = (v: number) => padTop + chartH * (1 - (v - minVal) / (maxVal - minVal));

    // ── Build per-team lines (varying Y per day if perTeamDailyData available) ──
    const lines = kpi.scores.map((score, si) => {
      const color = colors[si % colors.length];
      const devMap = buildDevMap(score.team);
      const teamY = Math.round(toY(score.rawValue) * 10) / 10;
      const dailyMap = perTeamDailyMap.get(score.team) ?? null;

      const points = sortedDays.map((day, di) => {
        // If the KPI has perTeamDailyData, it is the authoritative source for daily values:
        //   - team in map → use its value (0 for days explicitly set to 0, e.g. no Improdutivo OS)
        //   - team NOT in map → use 0 (no qualifying data on any day for this team)
        // If the KPI has no perTeamDailyData, fall back to the flat ranking value (teamY).
        const dailyVal = kpi.perTeamDailyData
          ? (dailyMap !== null ? (dailyMap.get(day) ?? 0) : 0)
          : (dailyMap !== null ? (dailyMap.get(day) ?? null) : null);
        const pointY = dailyVal !== null ? Math.round(toY(dailyVal) * 10) / 10 : teamY;
        const flagged = dailyVal !== null
          ? (kpi.direction === 'higher-is-better' ? dailyVal < kpi.metaTarget : dailyVal > kpi.metaTarget)
          : devMap.has(day);
        return {
          x: Math.round(toX(di) * 10) / 10,
          y: pointY,
          dayIndex: di,
          dayLabel: day,
          flagged,
          displayVal: dailyVal !== null ? fmt(dailyVal) : fmt(score.rawValue),
        };
      });

      const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
      const deviations: DevEvent[] = [...devMap.values()].sort((a, b) => parseDay(a.dateRef) - parseDay(b.dateRef));

      return {
        team: score.team,
        color,
        above: aboveFn(score.rawValue),
        displayValue: fmt(score.rawValue),
        polyline,
        points,
        deviations,
      };
    });

    // ── Build daily trend line (global average per day) ───────────────────────
    let trendLine: { polyline: string; points: Array<{ x: number; y: number; label: string; value: number }> } | null = null;
    if (hasDailyTrend) {
      const trendPoints = kpi.dailyTrend!.map((pt, i) => ({
        x: Math.round(toX(i) * 10) / 10,
        y: Math.round(toY(pt.avgValue) * 10) / 10,
        label: pt.date,
        value: pt.avgValue,
      }));
      trendLine = {
        polyline: trendPoints.map((p) => `${p.x},${p.y}`).join(' '),
        points: trendPoints,
      };
    }

    // ── Day axis labels (cap at 20 visible to avoid clutter) ─────────────────
    const maxLabels = 20;
    const step = D <= maxLabels ? 1 : Math.ceil(D / maxLabels);
    const days = sortedDays
      .map((d, i) => ({ x: Math.round(toX(i) * 10) / 10, label: noDayData ? `Eq.${d}` : d, index: i }))
      .filter((_, i) => i % step === 0);

    const metaY  = Math.round(toY(kpi.metaTarget) * 10) / 10;
    const avgY   = Math.round(toY(kpi.average) * 10) / 10;
    const yTicks = [0, 1, 2, 3, 4].map((i) => {
      const v = minVal + ((maxVal - minVal) / 4) * i;
      return { y: Math.round(toY(v) * 10) / 10, label: fmt(Math.round(v * 10) / 10) };
    });

    return { lines, days, metaY, avgY, yTicks, padLeft, chartRight, labelBaseY, viewBox: `0 0 ${svgW} ${svgH}`, trendLine };
  }
}
