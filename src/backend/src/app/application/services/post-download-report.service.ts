import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

import { parse as parseCsv } from 'csv-parse/sync';

import type { Environment } from '../../infrastructure/config/env.js';

type TeamType = 'propria' | 'parceira';

type CsvRow = Record<string, string>;

export interface DownloadedFileRef {
  analysisTab: string;
  tableTitle: string;
  fileName: string;
  filePath: string;
}

export interface ReportFilterInput {
  bases?: string[];
  teamTypes?: TeamType[];
  includeExtraTags?: boolean;
}

interface TeamMetricSummary {
  team: string;
  records: number;
  tempPrepJornada: number;
  semOrdemJornada: number;
}

interface KpiRankItem {
  team: string;
  value: number;
}

interface KpiTeamScore {
  team: string;
  rawValue: number;
  score: number;
}

interface KpiInsight {
  kpi: string;
  direction: 'higher-is-better' | 'lower-is-better';
  topTeams: KpiRankItem[];
  opportunityTeams: KpiRankItem[];
  scores: KpiTeamScore[];
  average: number;
  metaTarget: number;
}

interface DeviationInsight {
  category: string;
  occurrences: number;
}

interface DeviationByTeam {
  team: string;
  deviations: string[];
}

interface CrossedInsight {
  title: string;
  description: string;
  evidence: Array<Record<string, string | number>>;
}

interface TeamActionPlan {
  team: string;
  issues: string[];
  recommendations: string[];
}

export interface GeneratedReport {
  generatedAt: string;
  filtersApplied: {
    bases: string[];
    teamTypes: TeamType[];
    includeExtraTags: boolean;
    extraTags: string[];
  };
  totals: {
    teams: number;
    deslocamentos: number;
    rankingRows: number;
    desviosRows: number;
  };
  kpis: KpiInsight[];
  deviations: {
    mostRecurring: DeviationInsight[];
    teamBreakdown: DeviationByTeam[];
  };
  specialAnalysis: {
    tempPrepAndSemOs: TeamMetricSummary[];
    crossedInsights: CrossedInsight[];
    actionPlan: TeamActionPlan[];
  };
  outputFiles: {
    jsonPath: string;
    markdownPath: string;
  };
}

interface TempSemOsRow {
  team: string;
  dateRef: string;
  tempPrep: number;
  semOsEntreOs: number;
  tempPrepJornada: number;
  semOrdemJornada: number;
}

const KPI_DIRECTIONS: Record<string, 'higher-is-better' | 'lower-is-better'> = {
  'OS Dia': 'higher-is-better',
  'Eficiência': 'higher-is-better',
  'Utilização': 'higher-is-better',
  'Reparo Por OS': 'lower-is-better',
  'TME': 'lower-is-better',
  'TME IMP': 'lower-is-better',
  '1º Login': 'lower-is-better',
  '1º Desloc.': 'lower-is-better',
  'Retorno Base': 'lower-is-better',
};

const KPI_ALIASES: Record<string, string[]> = {
  'OS Dia': ['Ativ/Equipe/Dia', 'OS Dia', 'OS/Dia', 'OS_Dia'],
  'Eficiência': ['Eficiencia', 'Eficiência'],
  'Utilização': ['Utilização', 'Utilizacao'],
  'Reparo Por OS': ['Qtd Serv IIº', 'Qtd Serv II', 'Reparo Por OS', 'Reparo/OS'],
  'TME': ['TMR Secundário', 'TMR Secundario', 'TMR Sec', 'TME'],
  'TME IMP': ['TMR Improd.', 'TMR Improd', 'TME IMP', 'TME_IMP'],
  '1º Login': ['1º Login', '1o Login', 'Primeiro Login'],
  '1º Desloc.': ['1º Desloc', '1º Desloc.', '1o Desloc'],
  'Retorno Base': ['Retorno a Base', 'Retorno Base', 'Retorno à Base'],
};

interface KpiThreshold {
  kpi: string;
  direction: 'higher-is-better' | 'lower-is-better';
  worst: number;
  meta: number;
  metaScore: number;
  best: number;
  maxScore: number;
}

const KPI_THRESHOLDS: KpiThreshold[] = [
  { kpi: 'OS Dia',        direction: 'higher-is-better', worst:  1.0,  meta:  4.4,  metaScore: 15,  best:  5.5,  maxScore: 16.5 },
  { kpi: 'Eficiência',    direction: 'higher-is-better', worst: 80,    meta: 100,   metaScore: 10,  best: 125,   maxScore: 11.7 },
  { kpi: 'Utilização',    direction: 'higher-is-better', worst: 60,    meta:  85,   metaScore: 10,  best:  88,   maxScore: 11.2 },
  { kpi: 'Reparo Por OS', direction: 'lower-is-better',  worst:  1.32, meta:   1.2, metaScore:  5,  best:   1.18, maxScore:  5.8 },
  { kpi: 'TME',           direction: 'lower-is-better',  worst: 72,    meta:  50,   metaScore: 15,  best:  45,   maxScore: 18.4 },
  { kpi: 'TME IMP',       direction: 'lower-is-better',  worst: 28,    meta:  20,   metaScore: 10,  best:  17,   maxScore: 13.8 },
  { kpi: '1º Login',      direction: 'lower-is-better',  worst: 12,    meta:   8,   metaScore:  5,  best:   7,   maxScore:  6.3 },
  { kpi: '1º Desloc.',    direction: 'lower-is-better',  worst: 30,    meta:  25,   metaScore:  5,  best:  20,   maxScore: 10   },
  { kpi: 'Retorno Base',  direction: 'lower-is-better',  worst: 50,    meta:  40,   metaScore:  5,  best:  35,   maxScore:  7.5 },
];

export class PostDownloadReportService {
  public constructor(private readonly environment: Environment) {}

  public async generate(params: {
    dataDirectory: string;
    downloadedFiles: DownloadedFileRef[];
    reportFilters?: ReportFilterInput;
  }): Promise<GeneratedReport> {
    const displacementFile = this.findFile(params.downloadedFiles, ['tab_completa', 'deslocamentos']);
    const rankingFile = this.findFile(params.downloadedFiles, ['ranking']);
    const deviationsFile = this.findFile(params.downloadedFiles, ['desvios']);

    const deslocamentos = displacementFile ? await this.readCsv(displacementFile.filePath) : [];
    const ranking = rankingFile ? await this.readCsv(rankingFile.filePath) : [];
    const desvios = deviationsFile ? await this.readCsv(deviationsFile.filePath) : [];

    const filtered = this.applyTeamFilters(
      { deslocamentos, ranking, desvios },
      params.reportFilters,
    );

    const tempSemOs = this.calculateTempPrepSemOs(filtered.deslocamentos);
    const teamMetrics = this.buildTeamMetrics(tempSemOs);
    const kpis = this.buildKpiInsights(filtered.ranking);
    const deviationInsights = this.buildDeviationInsights(filtered.desvios);
    const crossedInsights = this.buildCrossedInsights(teamMetrics, kpis, deviationInsights.teamBreakdown);
    const actionPlan = this.buildActionPlans(teamMetrics, kpis, deviationInsights.teamBreakdown);

    const generatedAt = new Date().toISOString();
    const report: GeneratedReport = {
      generatedAt,
      filtersApplied: {
        bases: params.reportFilters?.bases ?? [],
        teamTypes: params.reportFilters?.teamTypes ?? [],
        includeExtraTags: params.reportFilters?.includeExtraTags ?? true,
        extraTags: this.environment.report.extraTeamTags,
      },
      totals: {
        teams: new Set(teamMetrics.map((item) => item.team)).size,
        deslocamentos: filtered.deslocamentos.length,
        rankingRows: filtered.ranking.length,
        desviosRows: filtered.desvios.length,
      },
      kpis,
      deviations: deviationInsights,
      specialAnalysis: {
        tempPrepAndSemOs: teamMetrics,
        crossedInsights,
        actionPlan,
      },
      outputFiles: {
        jsonPath: join(params.dataDirectory, this.environment.report.outputFileName),
        markdownPath: join(params.dataDirectory, this.environment.report.outputFileName.replace(/\.json$/i, '.md')),
      },
    };

    await writeFile(report.outputFiles.jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    await writeFile(report.outputFiles.markdownPath, this.buildMarkdownReport(report), 'utf-8');

    return report;
  }

  private async readCsv(filePath: string): Promise<CsvRow[]> {
    const buffer: Buffer = await readFile(filePath);
    let raw: string;

    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
      // UTF-16 LE with BOM
      raw = buffer.slice(2).toString('utf16le');
    } else if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
      // UTF-16 BE with BOM — swap bytes and decode as LE
      const payload = buffer.slice(2);
      const swapped = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i + 1 < payload.length; i += 2) {
        swapped[i] = payload[i + 1];
        swapped[i + 1] = payload[i];
      }
      raw = swapped.toString('utf16le');
    } else if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      // UTF-8 BOM
      raw = buffer.slice(3).toString('utf-8');
    } else {
      raw = buffer.toString('utf-8');
    }

    const delimitersToTry = buildDelimiterCandidates(raw);
    let lastError: unknown;

    for (const delimiter of delimitersToTry) {
      try {
        const rows = parseCsv(raw, {
          columns: true,
          skip_empty_lines: true,
          delimiter,
          trim: true,
          relax_column_count: true,
          relax_quotes: true,
        }) as CsvRow[];

        if (rows.length > 0) {
          return rows;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw new Error(`failed to parse CSV file ${filePath}: ${lastError.message}`);
    }

    throw new Error(`failed to parse CSV file ${filePath}`);
  }

  private findFile(files: DownloadedFileRef[], expectedTokens: string[]): DownloadedFileRef | undefined {
    return files.find((file) => {
      const source = normalizeToken(`${file.tableTitle} ${file.fileName}`);
      return expectedTokens.every((token) => source.includes(normalizeToken(token)));
    }) ?? files.find((file) => {
      const source = normalizeToken(`${file.tableTitle} ${file.fileName}`);
      return expectedTokens.some((token) => source.includes(normalizeToken(token)));
    });
  }

  private applyTeamFilters(
    datasets: { deslocamentos: CsvRow[]; ranking: CsvRow[]; desvios: CsvRow[] },
    reportFilters?: ReportFilterInput,
  ): { deslocamentos: CsvRow[]; ranking: CsvRow[]; desvios: CsvRow[] } {
    const includeExtra = reportFilters?.includeExtraTags ?? true;
    const teamMatcher = this.buildTeamMatcher(reportFilters, includeExtra);

    const filterRows = (rows: CsvRow[]): CsvRow[] => {
      if (rows.length === 0) {
        return rows;
      }

      const accessor = createAccessor(rows[0]);
      const teamColumn = accessor.resolve(['Equipe', 'Team', 'Equipe Nome']);
      if (!teamColumn) {
        return rows;
      }

      return rows.filter((row) => teamMatcher(String(row[teamColumn] ?? '')));
    };

    return {
      deslocamentos: filterRows(datasets.deslocamentos),
      ranking: filterRows(datasets.ranking),
      desvios: filterRows(datasets.desvios),
    };
  }

  private buildTeamMatcher(reportFilters: ReportFilterInput | undefined, includeExtraTags: boolean): (team: string) => boolean {
    const selectedBases = new Set((reportFilters?.bases ?? []).map((base) => normalizeToken(base)));
    const selectedTypes = new Set(reportFilters?.teamTypes ?? []);
    const hasBaseFilter = selectedBases.size > 0;
    const hasTypeFilter = selectedTypes.size > 0;
    const allowedPrefixes = new Set<string>();

    for (const [baseName, prefixes] of Object.entries(this.environment.report.basePrefixMap)) {
      const baseMatch = !hasBaseFilter || selectedBases.has(normalizeToken(baseName));
      if (!baseMatch) {
        continue;
      }

      if (!hasTypeFilter || selectedTypes.has('propria')) {
        allowedPrefixes.add(prefixes.ownPrefix.toUpperCase());
      }
      if (!hasTypeFilter || selectedTypes.has('parceira')) {
        allowedPrefixes.add(prefixes.partnerPrefix.toUpperCase());
      }
    }

    const extraTags = includeExtraTags
      ? this.environment.report.extraTeamTags.map((tag) => tag.toUpperCase())
      : [];

    return (teamNameRaw: string): boolean => {
      const teamName = teamNameRaw.toUpperCase().trim();
      if (teamName.length === 0) {
        return false;
      }

      const prefixMatch = allowedPrefixes.size === 0
        ? true
        : Array.from(allowedPrefixes).some((prefix) => teamName.startsWith(prefix));

      if (!prefixMatch) {
        return extraTags.some((tag) => teamName.includes(tag));
      }

      return true;
    };
  }

  private calculateTempPrepSemOs(rows: CsvRow[]): TempSemOsRow[] {
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
      semOsValues.push(parseNumber(String(firstRow[firstDespachoCol] ?? '')) ?? Number.NaN);

      for (let i = 1; i < ordered.length; i++) {
        const current = ordered[i];
        const previous = ordered[i - 1];

        const aCaminho = parseDateTimeBr(String(current[caminhoCol] ?? ''));
        const despachada = parseDateTimeBr(String(current[despachadaCol] ?? ''));
        const liberada = parseDateTimeBr(String(previous[liberadaCol] ?? ''));
        const inicioIntervalo = inicioIntervaloCol ? parseDateTimeBr(String(current[inicioIntervaloCol] ?? '')) : null;
        const fimIntervalo = fimIntervaloCol ? parseDateTimeBr(String(current[fimIntervaloCol] ?? '')) : null;
        const intervaloMinutes = parseNumber(String(current[intervaloCol ?? ''] ?? ''));

        const tempPrep = this.calculateTempPrepValue({
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

        const semOs = this.calculateSemOsValue({
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

  private calculateTempPrepValue(input: {
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

  private calculateSemOsValue(input: {
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

  private buildTeamMetrics(rows: TempSemOsRow[]): TeamMetricSummary[] {
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

  private buildKpiInsights(rows: CsvRow[]): KpiInsight[] {
    if (rows.length === 0) {
      return [];
    }

    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe', 'Team', 'Equipe Nome']);
    if (!teamCol) {
      return [];
    }

    const insights: KpiInsight[] = [];

    for (const [kpi, aliases] of Object.entries(KPI_ALIASES)) {
      const kpiCol = accessor.resolve(aliases);
      if (!kpiCol) {
        continue;
      }

      const values: KpiRankItem[] = rows
        .map((row) => ({
          team: String(row[teamCol] ?? '').trim(),
          value: parseNumber(String(row[kpiCol] ?? '')) ?? Number.NaN,
        }))
        .filter((item) => item.team.length > 0 && Number.isFinite(item.value));

      if (values.length === 0) {
        continue;
      }

      const direction = KPI_DIRECTIONS[kpi] ?? 'higher-is-better';
      const threshold = KPI_THRESHOLDS.find((t) => normalizeToken(t.kpi) === normalizeToken(kpi));
      const sorted = [...values].sort((a, b) => direction === 'higher-is-better' ? b.value - a.value : a.value - b.value);

      const scores: KpiTeamScore[] = values.map((item) => ({
        team: item.team,
        rawValue: round2(item.value),
        score: threshold ? round2(scoreKpi(item.value, threshold)) : round2(item.value),
      })).sort((a, b) => b.score - a.score);

      const average = round2(values.reduce((sum, item) => sum + item.value, 0) / Math.max(values.length, 1));

      insights.push({
        kpi,
        direction,
        topTeams: sorted.slice(0, 3).map((item) => ({ ...item, value: round2(item.value) })),
        opportunityTeams: sorted.slice(-3).reverse().map((item) => ({ ...item, value: round2(item.value) })),
        scores,
        average,
        metaTarget: threshold?.meta ?? 0,
      });
    }

    return insights;
  }

  private buildDeviationInsights(rows: CsvRow[]): { mostRecurring: DeviationInsight[]; teamBreakdown: DeviationByTeam[] } {
    if (rows.length === 0) {
      return { mostRecurring: [], teamBreakdown: [] };
    }

    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe', 'Team']);
    const deviationCol = accessor.resolve(['Desvio', 'Tipo Desvio', 'Desvios', 'Ocorrência', 'Ocorrencia', 'Descrição']);

    if (!teamCol || !deviationCol) {
      return { mostRecurring: [], teamBreakdown: [] };
    }

    const countByDeviation = new Map<string, number>();
    const countByTeam = new Map<string, Map<string, number>>();

    for (const row of rows) {
      const team = String(row[teamCol] ?? '').trim();
      const category = String(row[deviationCol] ?? '').trim();
      if (!team || !category) {
        continue;
      }

      countByDeviation.set(category, (countByDeviation.get(category) ?? 0) + 1);

      const teamMap = countByTeam.get(team) ?? new Map<string, number>();
      teamMap.set(category, (teamMap.get(category) ?? 0) + 1);
      countByTeam.set(team, teamMap);
    }

    const mostRecurring = Array.from(countByDeviation.entries())
      .map(([category, occurrences]) => ({ category, occurrences }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10);

    const teamBreakdown = Array.from(countByTeam.entries())
      .map(([team, teamMap]) => ({
        team,
        deviations: Array.from(teamMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([category]) => category),
      }))
      .sort((a, b) => a.team.localeCompare(b.team));

    return { mostRecurring, teamBreakdown };
  }

  private buildCrossedInsights(
    teamMetrics: TeamMetricSummary[],
    kpis: KpiInsight[],
    teamDeviations: DeviationByTeam[],
  ): CrossedInsight[] {
    const deviationMap = new Map(teamDeviations.map((item) => [item.team, item.deviations]));
    const utilKpi = kpis.find((item) => normalizeToken(item.kpi) === normalizeToken('Utilização'));
    const retornoBase = kpis.find((item) => normalizeToken(item.kpi) === normalizeToken('Retorno Base'));

    const matrixEvidence = teamMetrics
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => {
          const token = normalizeToken(entry);
          return token.includes(normalizeToken('Util < 40%')) || token.includes(normalizeToken('Intervalo < 30 ou > 70 min'));
        });
      })
      .slice(0, 8)
      .map((item) => ({
        team: item.team,
        semOrdemJornada: item.semOrdemJornada,
        tempPrepJornada: item.tempPrepJornada,
      }));

    const falsePositiveEvidence = (retornoBase?.topTeams ?? [])
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => normalizeToken(entry).includes(normalizeToken('Retorno a base < 8 min')));
      })
      .map((item) => ({
        team: item.team,
        retornoBase: item.value,
      }));

    const highIdleThreshold = percentile(teamMetrics.map((item) => item.semOrdemJornada), 0.75);
    const idleCulpabilityEvidence = teamMetrics
      .filter((item) => item.semOrdemJornada >= highIdleThreshold)
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => {
          const token = normalizeToken(entry);
          return token.includes(normalizeToken('Sem Fim Turno')) || token.includes(normalizeToken('Calendário Errado'));
        });
      })
      .map((item) => ({
        team: item.team,
        semOrdemJornada: item.semOrdemJornada,
      }));

    return [
      {
        title: 'Matriz Desvios vs Utilização',
        description: utilKpi
          ? 'Cruza equipes com desvios críticos de utilização/intervalo com os tempos calculados de TempPrep e SemOSentreOS.'
          : 'Cruza equipes com desvios críticos de utilização/intervalo com tempos de ociosidade calculados.',
        evidence: matrixEvidence,
      },
      {
        title: 'Análise de Falsos Positivos de Retorno',
        description: 'Identifica equipes com boa nota de Retorno Base e desvio de retorno suspeito (<8 min).',
        evidence: falsePositiveEvidence,
      },
      {
        title: 'Culpabilidade do Ócio',
        description: 'Relaciona alto SemOSentreOS com desvios de indisciplina de apontamento.',
        evidence: idleCulpabilityEvidence,
      },
    ];
  }

  private buildActionPlans(
    teamMetrics: TeamMetricSummary[],
    kpis: KpiInsight[],
    teamDeviations: DeviationByTeam[],
  ): TeamActionPlan[] {
    const deviationMap = new Map(teamDeviations.map((item) => [item.team, item.deviations]));

    const opportunityTeams = new Set<string>();
    for (const insight of kpis) {
      for (const t of insight.opportunityTeams) {
        opportunityTeams.add(t.team);
      }
    }

    const plans: TeamActionPlan[] = [];

    for (const tm of teamMetrics) {
      if (!opportunityTeams.has(tm.team)) {
        continue;
      }

      const issues: string[] = [];
      const recommendations: string[] = [];
      const deviations = deviationMap.get(tm.team) ?? [];

      for (const insight of kpis) {
        if (!insight.opportunityTeams.some((t) => t.team === tm.team)) {
          continue;
        }

        const teamScore = insight.scores.find((s) => s.team === tm.team);
        const highlight = teamScore ? ` (${teamScore.rawValue}, meta: ${insight.metaTarget})` : '';

        issues.push(`${insight.kpi} abaixo do esperado${highlight}`);

        if (insight.kpi === 'Utilização' || normalizeToken(insight.kpi) === normalizeToken('OS Dia')) {
          if (tm.semOrdemJornada > 30) {
            recommendations.push(
              `Revisar gestão de fila — ${tm.team} tem alto tempo sem OS entre ordens (${tm.semOrdemJornada} min/dia em média).`,
            );
          }
        }

        if (insight.kpi === 'TME' || insight.kpi === 'TME IMP') {
          if (tm.tempPrepJornada > 20) {
            recommendations.push(
              `Cobrar redução do TempPrep — equipe leva em média ${tm.tempPrepJornada} min/dia para confirmar deslocamento após despacho.`,
            );
          }
        }
      }

      // Deviation-based recommendations
      const deviationIssues: Array<{ token: string; message: string; rec: string }> = [
        {
          token: 'util < 40%',
          message: 'Desvio: Utilização abaixo de 40%',
          rec: 'Aumentar número de OS executadas no período ou revisar apontamentos de ociosidade.',
        },
        {
          token: 'sem intervalo',
          message: 'Desvio: Sem registro de intervalo',
          rec: 'Orientar registro obrigatório do intervalo de almoço no sistema.',
        },
        {
          token: 'logoff antecipado',
          message: 'Desvio: LogOff antecipado',
          rec: 'Orientar equipe a registrar o fim de turno apenas após completar a jornada.',
        },
        {
          token: 'sem fim turno',
          message: 'Desvio: Sem registro de fim de turno',
          rec: 'Cobrar registro obrigatório do Log Off ao término da jornada.',
        },
        {
          token: 'calendario errado',
          message: 'Desvio: Calendário com apontamento incorreto',
          rec: 'Verificar horários de Log In em relação ao Início Calendário estipulado.',
        },
        {
          token: 'retorno a base < 8 min',
          message: 'Desvio: Retorno a base suspeito (<8 min)',
          rec: 'Verificar se a equipe está liberando ordens dentro ou nas imediações da base antes de retornar.',
        },
        {
          token: '1o deslocamento 2 horas',
          message: 'Desvio: 1º deslocamento com atraso ≥2h',
          rec: 'Cobrar apontamento do primeiro deslocamento no início do turno.',
        },
        {
          token: 'inicio turno > 2 horas',
          message: 'Desvio: Início de turno com atraso >2h',
          rec: 'Verificar e regularizar o horário de início do turno junto ao supervisor.',
        },
        {
          token: 'intervalo < 30 ou > 70 min',
          message: 'Desvio: Intervalo com duração irregular',
          rec: 'Garantir que o intervalo seja apontado dentro do intervalo regulamentar (30–70 min).',
        },
        {
          token: 'intervalo por ultimo',
          message: 'Desvio: Intervalo registrado por último (fim do turno)',
          rec: 'Orientar que o intervalo deve ser realizado e apontado durante o turno, não ao final.',
        },
      ];

      for (const { token, message, rec } of deviationIssues) {
        const matched = deviations.some((d) => normalizeToken(d).includes(normalizeToken(token)));
        if (matched) {
          issues.push(message);
          recommendations.push(rec);
        }
      }

      if (issues.length > 0) {
        plans.push({ team: tm.team, issues, recommendations });
      }
    }

    return plans.slice(0, 25);
  }

  private buildMarkdownReport(report: GeneratedReport): string {
    const lines: string[] = [];
    const hr = '---';

    const fmt = (v: number) => Number.isFinite(v) ? String(v) : '—';

    lines.push('# Relatório Analítico Scanner');
    lines.push('');
    lines.push(`**Gerado em:** ${new Date(report.generatedAt).toLocaleString('pt-BR')}`);
    if (report.filtersApplied.bases.length > 0) {
      lines.push(`**Bases filtradas:** ${report.filtersApplied.bases.join(', ')}`);
    }
    if (report.filtersApplied.teamTypes.length > 0) {
      const typeLabels: Record<string, string> = { propria: 'Própria', parceira: 'Parceira' };
      lines.push(`**Tipo de equipe:** ${report.filtersApplied.teamTypes.map((t) => typeLabels[t] ?? t).join(', ')}`);
    }
    lines.push('');
    lines.push(hr);
    lines.push('');

    // ── Sumário ──────────────────────────────────────────────────────
    lines.push('## 📊 Resumo Geral');
    lines.push('');
    lines.push(`| Dado | Valor |`);
    lines.push(`| :--- | ---: |`);
    lines.push(`| Equipes avaliadas | ${report.totals.teams} |`);
    lines.push(`| Registros de deslocamento | ${report.totals.deslocamentos} |`);
    lines.push(`| Linhas de ranking | ${report.totals.rankingRows} |`);
    lines.push(`| Linhas de desvios | ${report.totals.desviosRows} |`);
    lines.push('');
    lines.push(hr);
    lines.push('');

    // ── KPIs ─────────────────────────────────────────────────────────
    lines.push('## 🏆 Desempenho por KPI');
    lines.push('');
    for (const insight of report.kpis) {
      const dir = insight.direction === 'higher-is-better' ? '↑ Quanto maior, melhor' : '↓ Quanto menor, melhor';
      lines.push(`### ${insight.kpi}`);
      lines.push('');
      lines.push(`**Direção:** ${dir} | **Meta:** ${insight.metaTarget} | **Média geral:** ${fmt(insight.average)}`);
      lines.push('');

      // Top 3
      lines.push('**🥇 Top 3 — Melhores Equipes**');
      lines.push('');
      if (insight.topTeams.length === 0) {
        lines.push('_Sem dados suficientes._');
      } else {
        lines.push('| # | Equipe | Valor | Pontuação |');
        lines.push('| :- | :--- | ---: | ---: |');
        for (let i = 0; i < Math.min(3, insight.topTeams.length); i++) {
          const t = insight.topTeams[i];
          const sc = insight.scores.find((s) => s.team === t.team);
          lines.push(`| ${i + 1} | ${t.team} | ${fmt(t.value)} | ${sc ? fmt(sc.score) : '—'} |`);
        }
      }
      lines.push('');

      // Bottom 3
      lines.push('**🔻 Top 3 — Oportunidade de Melhoria**');
      lines.push('');
      if (insight.opportunityTeams.length === 0) {
        lines.push('_Sem dados suficientes._');
      } else {
        lines.push('| # | Equipe | Valor | Pontuação |');
        lines.push('| :- | :--- | ---: | ---: |');
        for (let i = 0; i < insight.opportunityTeams.length; i++) {
          const t = insight.opportunityTeams[i];
          const sc = insight.scores.find((s) => s.team === t.team);
          lines.push(`| ${i + 1} | ${t.team} | ${fmt(t.value)} | ${sc ? fmt(sc.score) : '—'} |`);
        }
      }
      lines.push('');
    }
    lines.push(hr);
    lines.push('');

    // ── Desvios ───────────────────────────────────────────────────────
    lines.push('## ⚠️ Desvios de Padrão Operacional');
    lines.push('');
    lines.push('### Desvios Mais Recorrentes na Base');
    lines.push('');
    if (report.deviations.mostRecurring.length === 0) {
      lines.push('_Nenhum desvio encontrado nos dados._');
    } else {
      lines.push('| Desvio | Ocorrências |');
      lines.push('| :--- | ---: |');
      for (const item of report.deviations.mostRecurring) {
        lines.push(`| ${item.category} | ${item.occurrences} |`);
      }
    }
    lines.push('');

    lines.push('### Desvios por Equipe');
    lines.push('');
    if (report.deviations.teamBreakdown.length === 0) {
      lines.push('_Sem dados._');
    } else {
      for (const td of report.deviations.teamBreakdown.slice(0, 20)) {
        if (td.deviations.length === 0) continue;
        lines.push(`**${td.team}:** ${td.deviations.join(' | ')}`);
      }
    }
    lines.push('');
    lines.push(hr);
    lines.push('');

    // ── TempPrep / SemOs ──────────────────────────────────────────────
    lines.push('## ⏱ Análise de Utilização — TempPrep e SemOSentreOS');
    lines.push('');
    lines.push('> Valores representam **médias diárias** (min/dia) calculadas pelo backend.');
    lines.push('> **TempPrep**: tempo médio para confirmar "A Caminho" após despacho.');
    lines.push('> **SemOSentreOS**: tempo médio ocioso entre ordens (após liberação da OS anterior).');
    lines.push('> Desconto de intervalo de almoço regulamentar (60 min) já aplicado.');
    lines.push('');
    if (report.specialAnalysis.tempPrepAndSemOs.length === 0) {
      lines.push('_Sem dados de deslocamento disponíveis._');
    } else {
      lines.push('| Equipe | Dias | TempPrep (min/dia) | SemOSentreOS (min/dia) |');
      lines.push('| :--- | ---: | ---: | ---: |');
      for (const tm of report.specialAnalysis.tempPrepAndSemOs.slice(0, 30)) {
        lines.push(`| ${tm.team} | ${tm.records} | ${fmt(tm.tempPrepJornada)} | ${fmt(tm.semOrdemJornada)} |`);
      }
    }
    lines.push('');
    lines.push(hr);
    lines.push('');

    // ── Cruzamentos ───────────────────────────────────────────────────
    lines.push('## 🔀 Análise Cruzada');
    lines.push('');
    for (const insight of report.specialAnalysis.crossedInsights) {
      lines.push(`### ${insight.title}`);
      lines.push('');
      lines.push(`_${insight.description}_`);
      lines.push('');
      if (insight.evidence.length === 0) {
        lines.push('_Sem evidências para os filtros selecionados._');
      } else {
        const keys = Object.keys(insight.evidence[0]);
        lines.push(`| ${keys.join(' | ')} |`);
        lines.push(`| ${keys.map(() => '---:').join(' | ')} |`);
        for (const row of insight.evidence) {
          lines.push(`| ${keys.map((k) => String(row[k] ?? '—')).join(' | ')} |`);
        }
      }
      lines.push('');
    }
    lines.push(hr);
    lines.push('');

    // ── Plano de Ação ─────────────────────────────────────────────────
    lines.push('## 📋 Plano de Ação por Equipe');
    lines.push('');
    if (report.specialAnalysis.actionPlan.length === 0) {
      lines.push('_Nenhuma equipe com oportunidade de melhoria identificada para os filtros selecionados._');
    } else {
      for (const plan of report.specialAnalysis.actionPlan) {
        lines.push(`### ${plan.team}`);
        lines.push('');
        lines.push('**Problemas identificados:**');
        for (const issue of plan.issues) {
          lines.push(`- ${issue}`);
        }
        if (plan.recommendations.length > 0) {
          lines.push('');
          lines.push('**Recomendações:**');
          for (const rec of plan.recommendations) {
            lines.push(`- ${rec}`);
          }
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }
}

function createAccessor(sample: CsvRow): {
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

function normalizeToken(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

function parseNumber(valueRaw: string): number | null {
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

function parseDateTimeBr(valueRaw: string): Date | null {
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

function minutesBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 60_000;
}

function applyIntervalDiscount(value: number, intervaloMinutes: number | null): number {
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

function safeSum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return round2(total);
}

function percentile(values: number[], p: number): number {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) {
    return 0;
  }

  const index = Math.max(0, Math.min(finite.length - 1, Math.floor((finite.length - 1) * p)));
  return finite[index];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function scoreKpi(value: number, threshold: KpiThreshold): number {
  const { direction, worst, meta, metaScore, best, maxScore } = threshold;

  if (direction === 'higher-is-better') {
    if (value <= worst) return 0;
    if (value >= best) return maxScore;
    if (value <= meta) return metaScore * (value - worst) / (meta - worst);
    return metaScore + (maxScore - metaScore) * (value - meta) / (best - meta);
  }

  // lower-is-better: best ≤ meta ≤ worst
  if (value >= worst) return 0;
  if (value <= best) return maxScore;
  if (value >= meta) return metaScore * (worst - value) / (worst - meta);
  return metaScore + (maxScore - metaScore) * (meta - value) / (meta - best);
}

function buildDelimiterCandidates(raw: string): string[] {
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
