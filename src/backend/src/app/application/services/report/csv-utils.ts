// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietario e confidencial. Uso nao autorizado e proibido.
import { parse as parseCsv } from 'csv-parse/sync';
import type { KpiThreshold } from './constants.js';

export type CsvRow = Record<string, string>;

export function createAccessor(sample: CsvRow): {
  resolve: (candidates: string[]) => string | undefined;
} {
  const keys = Object.keys(sample);
  const normalizedMap = new Map<string, string>();

  for (const key of keys) {
    normalizedMap.set(normalizeToken(key), key);
  }

  return {
    resolve: (candidates: string[]) => {
      for (const candidate of candidates) {
        const match = normalizedMap.get(normalizeToken(candidate));
        if (match) {
          return match;
        }
      }
      return undefined;
    },
  };
}

export function normalizeToken(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

export function parseNumber(valueRaw: string): number | null {
  if (!valueRaw) {
    return null;
  }

  const cleaned = valueRaw.trim();
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;
  if (hasComma && hasDot) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = normalized.replace(',', '.');
  }

  const value = normalized.replace(/[^0-9.-]/g, '');

  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDateTimeBr(valueRaw: string): Date | null {
  const value = valueRaw?.trim();
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, dd, mm, yyyy, hh = '0', min = '0', sec = '0'] = match;
  const year = yyyy.length === 2 ? Number(`20${yyyy}`) : Number(yyyy);
  const parsed = new Date(year, Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(sec));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function minutesBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 60_000;
}

export function applyIntervalDiscount(value: number, intervaloMinutes: number | null): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  if (intervaloMinutes === null || !Number.isFinite(intervaloMinutes) || intervaloMinutes < 0) {
    return value;
  }

  let adjusted = value - Math.min(intervaloMinutes, 60);
  const excedente = intervaloMinutes - 60;

  if (excedente > 0) {
    adjusted += excedente;
  }

  if (adjusted < 0) {
    return 0;
  }

  return adjusted;
}

export function safeSum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return round2(total);
}

export function percentile(values: number[], p: number): number {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) {
    return 0;
  }

  const index = Math.max(0, Math.min(finite.length - 1, Math.floor((finite.length - 1) * p)));
  return finite[index];
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function scoreKpi(value: number, threshold: KpiThreshold): number {
  const { direction, worst, meta, metaScore, best, maxScore } = threshold;

  if (direction === 'higher-is-better') {
    if (value <= worst) return 0;
    if (value >= best) return maxScore;
    if (value <= meta) return metaScore * (value - worst) / (meta - worst);
    return metaScore + (maxScore - metaScore) * (value - meta) / (best - meta);
  }

  // lower-is-better: best Ôëñ meta Ôëñ worst
  if (value >= worst) return 0;
  if (value <= best) return maxScore;
  if (value >= meta) return metaScore * (worst - value) / (worst - meta);
  return metaScore + (maxScore - metaScore) * (meta - value) / (meta - best);
}

export function buildDelimiterCandidates(raw: string): string[] {
  const candidates = [',', ';', '\t', '|'];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);

  if (lines.length < 2) {
    return candidates;
  }

  const scored = candidates.map((delimiter) => {
    try {
      const sample = parseCsv(lines.join('\n'), {
        delimiter,
        skip_empty_lines: true,
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
      }) as string[][];

      if (sample.length === 0) {
        return { delimiter, score: -1 };
      }

      const headerLen = sample[0]?.length ?? 0;
      if (headerLen <= 1) {
        return { delimiter, score: 0 };
      }

      const consistentRows = sample.slice(1).filter((row) => row.length === headerLen).length;
      const consistencyRatio = sample.length > 1 ? consistentRows / (sample.length - 1) : 1;
      const score = headerLen * 10 + consistencyRatio;

      return { delimiter, score };
    } catch {
      return { delimiter, score: -1 };
    }
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((entry) => entry.score >= 0)
    .map((entry) => entry.delimiter)
    .concat(candidates.filter((delimiter) => !scored.some((entry) => entry.delimiter === delimiter)));
}
