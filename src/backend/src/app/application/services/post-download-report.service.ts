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
  teams?: string[];
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
  evidenceAnalysis?: EficienciaTeamAnalysis[];
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
    osDiaAnalysis: OsDiaTeamAnalysis[];
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

interface OsDiaOrderEvidence {
  source: string;
  nr_ordem: string;
  classe: string;
  causa: string;
  despachada: string;
  a_caminho: string;
  no_local: string;
  liberada: string;
  inicio_intervalo: string;
  fim_intervalo: string;
  prev_liberada?: string;
  prev_nr_ordem?: string;
  prev_despachada?: string;
  inicio_calendario?: string;
  log_in?: string;
  tr_ordem_min: number;
  tl_ordem_min: number;
  hd_total_min: number;
  hd_pct_tr: number;
  hd_pct_tl: number;
  tempo_padrao_min?: number;
  temp_prep_os_min?: number;
  sem_os_details?: Array<{
    type: 'inicio_jornada' | 'entre_ordens' | 'fim_jornada' | 'intervalo_deslocamento';
    min: number;
    from?: string;
    to?: string;
    interval_discounted?: boolean;
    retorno_base_avg_discounted?: number;
  }>;
  sem_os_total_min?: number;
  flags: Array<'tr_excede_hd' | 'tl_excede_hd' | 'temp_prep_alto' | 'sem_os_alto'>;
}

interface OsDiaTeamAnalysis {
  team: string;
  osDiaValue: number;
  metaTarget: number;
  gap: number;
  hdTotalMin: number;
  tempPrepTotalMin: number;
  semOrdemTotalMin: number;
  totalOrders: number;
  flaggedOrders: OsDiaOrderEvidence[];
  summary: {
    countTrExceeds: number;
    countTlExceeds: number;
    countTempPrepAlto: number;
    countSemOsAlto: number;
  };
  idleAnalysis?: {
    idleMin: number;
    idlePct: number;
  };
}

interface EficienciaOrderEvidence {
  nr_ordem: string;
  classe: string;
  causa: string;
  despachada: string;
  a_caminho: string;
  no_local: string;
  liberada: string;
  tl_ordem_min: number;
  tr_ordem_min: number;
  hd_total_min: number;
  hd_pct_tr: number;
  tempo_padrao_min?: number;
  flags: Array<'deslocamento_curto' | 'tr_excede_hd' | 'tempo_padrao_vazio' | 'tr_muito_baixo'>;
}

interface EficienciaTeamAnalysis {
  team: string;
  eficienciaValue: number;
  averageEficiencia: number;
  avgDeslocamentoMin: number;
  avgExecucaoMin: number;
  avgTempoPadraoMin: number;
  globalAvgDeslocamentoMin: number;
  globalAvgExecucaoMin: number;
  analysisType: 'top_performer' | 'underperformer';
  flags: Array<'short_displacement'>;
  flaggedOrders: EficienciaOrderEvidence[];
  tempoPadraoVazioOrders: EficienciaOrderEvidence[];
  simulatedEficiencia?: number;
  summary: {
    totalOrders: number;
    countDeslocamentoCurto: number;
    countTrExcedeHd: number;
    countTempoPadraoVazio: number;
  };
}

const KPI_DIRECTIONS: Record<string, 'higher-is-better' | 'lower-is-better'> = {
  'OS Dia': 'higher-is-better',
  'Eficiência': 'higher-is-better',
  'Utilização': 'higher-is-better',
  'TME IMP': 'lower-is-better',
  '1º Login': 'lower-is-better',
  '1º Desloc.': 'lower-is-better',
  'Retorno Base': 'lower-is-better',
};

const KPI_ALIASES: Record<string, string[]> = {
  'OS Dia': ['Ativ/Equipe/Dia', 'OS Dia', 'OS/Dia', 'OS_Dia'],
  'Eficiência': ['Eficiencia', 'Eficiência'],
  'Utilização': ['Utilização', 'Utilizacao'],
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
  { kpi: 'TME IMP',       direction: 'lower-is-better',  worst: 28,    meta:  20,   metaScore: 10,  best:  17,   maxScore: 13.8 },
  { kpi: '1º Login',      direction: 'lower-is-better',  worst: 12,    meta:   8,   metaScore:  5,  best:   7,   maxScore:  6.3 },
  { kpi: '1º Desloc.',    direction: 'lower-is-better',  worst: 30,    meta:  25,   metaScore:  5,  best:  20,   maxScore: 10   },
  { kpi: 'Retorno Base',  direction: 'lower-is-better',  worst: 50,    meta:  40,   metaScore:  5,  best:  35,   maxScore:  7.5 },
];

export class PostDownloadReportService {
  public constructor(private readonly environment: Environment) {}

  public async listTeams(params: {
    dataDirectory: string;
    downloadedFiles: DownloadedFileRef[];
  }): Promise<string[]> {
    const displacementFile = this.findFile(params.downloadedFiles, ['tab_completa', 'deslocamentos']);
    if (!displacementFile) return [];
    const rows = await this.readCsv(displacementFile.filePath);
    if (rows.length === 0) return [];
    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe', 'Team', 'Equipe Nome']);
    if (!teamCol) return [];
    const teams = new Set<string>();
    for (const row of rows) {
      const v = (row[teamCol] ?? '').trim();
      if (v) teams.add(v);
    }
    return Array.from(teams).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

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

    const kpis = this.buildKpiInsights(filtered.ranking);
    const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
    const tempSemOs = this.calculateTempPrepSemOs(filtered.deslocamentos, retornoBaseAvg);
    const teamMetrics = this.buildTeamMetrics(tempSemOs);
    const deviationInsights = this.buildDeviationInsights(filtered.desvios);
    const crossedInsights = this.buildCrossedInsights(teamMetrics, kpis, deviationInsights.teamBreakdown);
    const actionPlan = this.buildActionPlans(teamMetrics, kpis, deviationInsights.teamBreakdown);
    const osDiaAnalysis = this.analyzeOsDia(filtered.deslocamentos, filtered.ranking, kpis);

    // Analyze Eficiencia KPI for evidence of masked efficiency or issues
    const eficienciaAnalysis = this.analyzeEficiencia(filtered.deslocamentos, filtered.ranking, kpis);
    console.log('[Generate Report] Eficiencia analysis results:', eficienciaAnalysis.length);
    // Attach evidence to the Eficiencia KPI insight
    const eficienciaKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Eficiência'));
    if (eficienciaKpi && eficienciaAnalysis.length > 0) {
      console.log('[Generate Report] Attaching evidence to Eficiencia KPI');
      eficienciaKpi.evidenceAnalysis = eficienciaAnalysis;
    } else {
      console.log('[Generate Report] Not attaching evidence:', {
        foundKpi: !!eficienciaKpi,
        analysisLength: eficienciaAnalysis.length,
      });
    }

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
        osDiaAnalysis,
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
    const selectedTeams = new Set((reportFilters?.teams ?? []).map((t) => t.toUpperCase().trim()));
    if (selectedTeams.size > 0) {
      return (teamNameRaw: string): boolean => {
        const teamName = teamNameRaw.toUpperCase().trim();
        return teamName.length > 0 && selectedTeams.has(teamName);
      };
    }

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

    const useExtraTagsFallback = !hasBaseFilter && !hasTypeFilter;

    return (teamNameRaw: string): boolean => {
      const teamName = teamNameRaw.toUpperCase().trim();
      if (teamName.length === 0) {
        return false;
      }

      const prefixMatch = allowedPrefixes.size === 0
        ? true
        : Array.from(allowedPrefixes).some((prefix) => teamName.startsWith(prefix));

      if (!prefixMatch) {
        return useExtraTagsFallback && extraTags.some((tag) => teamName.includes(tag));
      }

      return true;
    };
  }

  private calculateTempPrepSemOs(rows: CsvRow[], retornoBaseAvgMin: number): TempSemOsRow[] {
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
          // Subtract average retorno base
          if (retornoBaseAvgMin > 0) {
            gapMin -= retornoBaseAvgMin;
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

        if (insight.kpi === 'TME IMP') {
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

  private analyzeOsDia(deslocRows: CsvRow[], rankingRows: CsvRow[], kpis: KpiInsight[]): OsDiaTeamAnalysis[] {
    if (deslocRows.length === 0 || rankingRows.length === 0) {
      return [];
    }

    const OS_DIA_META = 4.4;
    const OS_DIA_PCT_THRESHOLD = 0.20;
    const TEMP_PREP_THRESHOLD_MIN      = 15; // demais OS: Lib.Anterior → A Caminho
    const TEMP_PREP_THRESHOLD_FIRST_MIN = 25; // 1ª OS da jornada: Início Calendário → A Caminho
    const SEM_OS_THRESHOLD_MIN = 10;

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

    if (!teamCol || !dateCol || !caminhoCol || !despachadaCol || !liberadaCol) {
      return [];
    }

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

    for (const { team, rows: groupRows } of grouped.values()) {
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
      let isInterACaminho = false;
      let isInterOrdem    = false;

      // First order: TempPrep from 1º Desloc, SemOS from 1º Despacho (raw spreadsheet value)
      tempPrepValues.push(firstDeslocCol   ? (parseNumber(String(firstRow[firstDeslocCol]   ?? '')) ?? Number.NaN) : Number.NaN);
      semOsValues.push(   firstDespachoCol ? (parseNumber(String(firstRow[firstDespachoCol] ?? '')) ?? Number.NaN) : Number.NaN);

      for (let i = 1; i < ordered.length; i++) {
        const current  = ordered[i];
        const previous = ordered[i - 1];

        const aCaminho        = parseDateTimeBr(String(current[caminhoCol]    ?? ''));
        const despachada      = parseDateTimeBr(String(current[despachadaCol] ?? ''));
        const liberada        = parseDateTimeBr(String(previous[liberadaCol]  ?? ''));
        const inicioIntervalo = inicioIntervaloCol ? parseDateTimeBr(String(current[inicioIntervaloCol] ?? '')) : null;
        const fimIntervalo    = fimIntervaloCol    ? parseDateTimeBr(String(current[fimIntervaloCol]    ?? '')) : null;
        const intervaloMinutes = parseNumber(String(current[intervaloCol ?? ''] ?? ''));

        const tempPrep = this.calculateTempPrepValue({
          aCaminho, despachada, liberada,
          inicioIntervalo, fimIntervalo, intervaloMinutes,
          isIntervalAlreadyApplied: isInterACaminho,
        });
        if (tempPrep.intervalApplied) {
          isInterACaminho = true;
        }
        tempPrepValues.push(tempPrep.value);

        const semOs = this.calculateSemOsValue({
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
      }

      // SemOrdem: gap between last order's Liberada and Log Off Corrigido, minus 60min interval and retorno base avg
      const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
      let semOsFimJornadaMin = Number.NaN;
      let semOsFimIntervalDiscounted = false;
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
            const discount = Math.min(intDuration, 60);
            gapMin -= discount;
            semOsFimIntervalDiscounted = true;
          }
          // Subtract average retorno base
          if (retornoBaseAvg > 0) {
            gapMin -= retornoBaseAvg;
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

      // Accumulate total order count for this team
      teamTotalOrders.set(team, (teamTotalOrders.get(team) ?? 0) + ordered.length);

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
        if (hdTotalMin > 0 && tlOrdemMin > hdTotalMin * OS_DIA_PCT_THRESHOLD) {
          flags.push('tl_excede_hd');
        }
        const tempPrepThreshold = (i === 0) ? TEMP_PREP_THRESHOLD_FIRST_MIN : TEMP_PREP_THRESHOLD_MIN;
        if (Number.isFinite(tempPrepOs) && tempPrepOs >= tempPrepThreshold) {
          flags.push('temp_prep_alto');
        }
        if (Number.isFinite(semOsMin) && semOsMin >= SEM_OS_THRESHOLD_MIN) {
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
        if (hasIntervaloDeslocamento) {
          flags.push('sem_os_alto');
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
            semOsDetails.push({
              type: 'entre_ordens',
              min:  round2(semOsMin),
              from: prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined,
              to:   despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined,
            });
          }
        }
        if (hasIntervaloDeslocamento && inicioIntervaloDate && prevLiberadaDate) {
          const intMin = round2(minutesBetween(inicioIntervaloDate, prevLiberadaDate));
          semOsDetails.push({
            type: 'intervalo_deslocamento',
            min:  intMin,
            from: prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined,
            to:   inicioIntervaloRaw || undefined,
          });
        }

        const semOsTotalMin = semOsDetails.length > 0 ? round2(semOsDetails.reduce((s, d) => s + d.min, 0)) : undefined;

        evidences.push({
          source:           'Scanner 4.4 - CE M300',
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
          tempo_padrao_min:  tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) ? round2(tempoPadraoRaw) : undefined,
          temp_prep_os_min:  Number.isFinite(tempPrepOs) ? round2(tempPrepOs) : undefined,
          sem_os_details:    semOsDetails.length > 0 ? semOsDetails : undefined,
          sem_os_total_min:  semOsTotalMin,
          flags:             uniqueFlags,
        });
      }
      // Add fim de jornada to the last order's evidence
      if (Number.isFinite(semOsFimJornadaMin) && semOsFimJornadaMin >= SEM_OS_THRESHOLD_MIN) {
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
          retorno_base_avg_discounted: retornoBaseAvg > 0 ? round2(retornoBaseAvg) : undefined,
        };

        const existingEvidence = evidences.find((e) => e.nr_ordem === lastNrOrdem);
        if (existingEvidence) {
          const details = existingEvidence.sem_os_details ?? [];
          details.push(fimDetail);
          existingEvidence.sem_os_details = details;
          existingEvidence.sem_os_total_min = round2(details.reduce((s, d) => s + d.min, 0));
          if (!existingEvidence.flags.includes('sem_os_alto')) {
            existingEvidence.flags.push('sem_os_alto');
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
            nr_ordem:          lastNrOrdem,
            classe:            classeCol  ? String(row[classeCol]  ?? '').trim() : '',
            causa:             causaCol   ? String(row[causaCol]   ?? '').trim() : '',
            despachada:        despachadaCol ? String(row[despachadaCol] ?? '').trim() : '',
            a_caminho:         String(row[caminhoCol] ?? '').trim(),
            no_local:          noLocalCol ? String(row[noLocalCol] ?? '').trim() : '',
            liberada:          liberadaCol  ? String(row[liberadaCol]  ?? '').trim() : '',
            inicio_intervalo:  '',
            fim_intervalo:     '',
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
    const result: OsDiaTeamAnalysis[] = [];
    for (const [team, osDiaValue] of underPerforming.entries()) {
      // Skip if no deslocamento rows found for this team
      if (!Array.from(grouped.values()).some((g) => g.team === team)) {
        continue;
      }

      const flaggedOrders = teamEvidences.get(team) ?? [];
      const hdEntry       = teamHdTotals.get(team);
      const avgHdTotal    = hdEntry ? round2(hdEntry.sum / hdEntry.count) : 0;
      const totalOrders   = teamTotalOrders.get(team) ?? 0;
      const tempPrepTotal = round2(teamTempPrepSum.get(team) ?? 0);
      const semOrdemTotal = round2(teamSemOrdemSum.get(team) ?? 0);

      const idleMin = round2(tempPrepTotal + semOrdemTotal);
      const idlePct = avgHdTotal > 0 ? round2((idleMin / avgHdTotal) * 100) : 0;
      const idleAnalysis: OsDiaTeamAnalysis['idleAnalysis'] =
        avgHdTotal > 0 && idlePct >= 10
          ? { idleMin, idlePct }
          : undefined;

      result.push({
        team,
        osDiaValue:  round2(osDiaValue),
        metaTarget:  OS_DIA_META,
        gap:         round2(OS_DIA_META - osDiaValue),
        hdTotalMin:  avgHdTotal,
        tempPrepTotalMin: tempPrepTotal,
        semOrdemTotalMin: semOrdemTotal,
        totalOrders,
        flaggedOrders,
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

  private analyzeEficiencia(deslocRows: CsvRow[], rankingRows: CsvRow[], kpis: KpiInsight[]): EficienciaTeamAnalysis[] {
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
          const trIsValid = trMin !== null && Number.isFinite(trMin) && trMin > 0;
          const trMuitoBaixo = trIsValid && (
            (tpMin !== null && Number.isFinite(tpMin) && tpMin > 0 && trMin! < tpMin * 0.20) &&
            (lowTrThreshold > 0 && trMin! < lowTrThreshold)
          );
          if (trMuitoBaixo) {
            orderFlags.push('tr_muito_baixo');
          }

          // deslocamento_curto: somente quando TR muito baixo E TL curto
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

      // Team-level flags — computed after order loop
      const flags: EficienciaTeamAnalysis['flags'] = [];
      const countDeslocamentoCurtoCalc = flaggedOrders.filter((o) => o.flags.includes('deslocamento_curto')).length;
      if (countDeslocamentoCurtoCalc > 0) {
        flags.push('short_displacement');
      }

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
        flaggedOrders: flaggedOrders.slice(0, 10),
        tempoPadraoVazioOrders: tempoPadraoVazioOrders.slice(0, 15),
        simulatedEficiencia,
        summary: {
          totalOrders: teamRows.length,
          countDeslocamentoCurto: flaggedOrders.filter((o) => o.flags.includes('deslocamento_curto')).length,
          countTrExcedeHd: flaggedOrders.filter((o) => o.flags.includes('tr_excede_hd')).length,
          countTempoPadraoVazio: tempoPadraoVazioOrders.length,
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

      // Eficiencia drill-down (evidências de eficiência mascarada e problemas)
      if (insight.kpi === 'Eficiência' && insight.evidenceAnalysis && insight.evidenceAnalysis.length > 0) {
        lines.push('#### 🔍 Análise Detalhada — Evidências de Incidências');
        lines.push('');
        lines.push('_Fonte: Scanner 4.4 - CE M300_');
        lines.push('');

        for (const analysis of insight.evidenceAnalysis) {
          const typeLabel = analysis.analysisType === 'top_performer' ? '🏆 Top Performer' : '⚠ Oportunidade';
          lines.push(`##### ${typeLabel} — ${analysis.team}`);
          lines.push('');
          lines.push(`**Eficiência:** ${fmt(analysis.eficienciaValue)}% | **Média Geral:** ${fmt(analysis.averageEficiencia)}%`);
          lines.push('');
          lines.push(`**Tempo Médio de Deslocamento:** ${fmt(analysis.avgDeslocamentoMin)} min (média geral: ${fmt(analysis.globalAvgDeslocamentoMin)} min)`);
          lines.push('');
          lines.push(`**Tempo Médio de Execução:** ${fmt(analysis.avgExecucaoMin)} min (média geral: ${fmt(analysis.globalAvgExecucaoMin)} min)`);
          lines.push('');
          
          // Flags/alerts
          if (analysis.flags.includes('short_displacement')) {
            const threshold = round2(analysis.globalAvgDeslocamentoMin * 0.25);
            lines.push(`⚠️ **Deslocamento muito curto:** ${fmt(analysis.avgDeslocamentoMin)} min (≤ ${fmt(threshold)} min, 25% da média geral)`);
            lines.push('');
          }
          // Summary stats
          lines.push(`**Resumo:** ${analysis.summary.totalOrders} ordens | ${analysis.summary.countDeslocamentoCurto} com deslocamento curto | ${analysis.summary.countTrExcedeHd} com TR>20% HD | ${analysis.summary.countTempoPadraoVazio} sem tempo padrão`);
          lines.push('');

          // Tempo Padrão Vazio section
          if (analysis.tempoPadraoVazioOrders.length > 0) {
            lines.push('**⚠️ Ordens sem Tempo Padrão — Equipe penalizada por ausência de referência:**');
            lines.push('');
            if (analysis.simulatedEficiencia !== undefined) {
              lines.push(`> **Simulação:** caso o tempo padrão dessas ordens fosse o TR médio global (${fmt(analysis.globalAvgExecucaoMin)} min), a eficiência estimada seria **${fmt(analysis.simulatedEficiencia)}%** (vs. atual ${fmt(analysis.eficienciaValue)}%).`);
              lines.push('');
            }
            lines.push('| Nr Ordem | Classe | Causa | Despachada | No Local | Liberada | TR (min) |');
            lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | ---: |');
            for (const ev of analysis.tempoPadraoVazioOrders.slice(0, 15)) {
              lines.push(`| ${ev.nr_ordem} | ${ev.classe} | ${ev.causa} | ${ev.despachada} | ${ev.no_local} | ${ev.liberada} | ${fmt(ev.tr_ordem_min)} |`);
            }
            lines.push('');
          }

          // Evidence table
          if (analysis.flaggedOrders.length > 0) {
            lines.push('**Ordens com Desvios:**');
            lines.push('');
            lines.push('| Nr Ordem | Classe | Causa | Despachada | No Local | Liberada | TR (min) | HD (min) | % HD | Tempo Padrão | Alertas |');
            lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |');
            
            for (const ev of analysis.flaggedOrders.slice(0, 10)) {
              const flagLabels = ev.flags.map((f) => {
                if (f === 'deslocamento_curto') return 'Desloc. Curto';
                if (f === 'tr_excede_hd') return 'TR>20% HD';
                if (f === 'tr_muito_baixo') return 'TR Muito Baixo';
                if (f === 'tempo_padrao_vazio') return 'T.Padrão Vazio';
                return f;
              }).join(', ');
              
              const tempPadraoCell = ev.tempo_padrao_min !== undefined ? fmt(ev.tempo_padrao_min) : '—';
              lines.push(
                `| ${ev.nr_ordem} | ${ev.classe} | ${ev.causa} | ${ev.despachada} | ${ev.no_local} | ${ev.liberada} | ${fmt(ev.tr_ordem_min)} | ${fmt(ev.hd_total_min)} | ${fmt(ev.hd_pct_tr)}% | ${tempPadraoCell} | **${flagLabels}** |`,
              );
            }
            lines.push('');
          } else {
            lines.push('_Nenhuma ordem específica flagada._');
            lines.push('');
          }
        }
      }
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

    // ── OS/Dia Drill-down ─────────────────────────────────────────────
    if (report.specialAnalysis.osDiaAnalysis.length > 0) {
      const flagLabel: Record<string, string> = {
        tr_excede_hd:    'TR>20% HD',
        tl_excede_hd:    'TL>20% HD',
        temp_prep_alto:  'TempPrep≥20min',
        sem_os_alto:     'SemOS≥20min',
      };

      lines.push('## 🔍 Análise Detalhada — OS/Dia');
      lines.push('');
      lines.push('> Evidências por ordem das equipes abaixo da meta de OS/Dia (4.4). Fonte: **Scanner 4.4 - CE M300**');
      lines.push('');

      for (const analysis of report.specialAnalysis.osDiaAnalysis) {
        lines.push(`### ${analysis.team}`);
        lines.push('');
        lines.push(
          `**OS/Dia:** ${fmt(analysis.osDiaValue)} | **Meta:** ${analysis.metaTarget} | **Gap:** ${fmt(analysis.gap)} OS/dia`,
        );
        lines.push('');
        lines.push(
          `**Ocorrências flagadas:** TR excede HD: ${analysis.summary.countTrExceeds} | TL excede HD: ${analysis.summary.countTlExceeds} | TempPrep alto: ${analysis.summary.countTempPrepAlto} | SemOS alto: ${analysis.summary.countSemOsAlto}`,
        );
        lines.push('');

        if (analysis.flaggedOrders.length === 0) {
          lines.push('_Nenhuma ordem com evidência nos dados filtrados._');
        } else {
          lines.push('| Nr_Ordem | Prev OS | CLASSE | CAUSA | Despachada | Liberada | TR (min) | % HD | TL (min) | % HD | TempPrep/OS | SemOS/OS | Alertas |');
          lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |');
          for (const ev of analysis.flaggedOrders) {
            const flagStr = ev.flags.map((f) => flagLabel[f] ?? f).join(', ');
            const prevOsCell = ev.prev_nr_ordem ?? '—';
            const tempPrepCell = ev.temp_prep_os_min !== undefined ? fmt(ev.temp_prep_os_min) : '—';
            const semOsCell   = ev.sem_os_total_min !== undefined ? fmt(ev.sem_os_total_min) : '—';
            lines.push(
              `| ${ev.nr_ordem} | ${prevOsCell} | ${ev.classe} | ${ev.causa} | ${ev.despachada} | ${ev.liberada} | ${fmt(ev.tr_ordem_min)} | ${fmt(ev.hd_pct_tr)}% | ${fmt(ev.tl_ordem_min)} | ${fmt(ev.hd_pct_tl)}% | ${tempPrepCell} | ${semOsCell} | **${flagStr}** |`,
            );
          }
        }
        lines.push('');
      }
      lines.push(hr);
      lines.push('');
    }

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
