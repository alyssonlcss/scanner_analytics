// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

import { parse as parseCsv } from 'csv-parse/sync';

import type { Environment } from '../../infrastructure/config/env.js';
import type {
  DownloadedFileRef, ReportFilterInput, GeneratedReport,
  TeamMetricSummary, TempSemOsRow,
} from './report/types.js';
import { createAccessor, normalizeToken, buildDelimiterCandidates } from './report/csv-utils.js';
import {
  buildKpiInsights, buildKpiDailyTrend, buildPerTeamDailyValue,
  buildPerTeamDailyRatio, buildPerTeamDailyCount, buildPerTeamDailyTmeImp,
} from './report/builders/kpi-insights.builder.js';
import { calculateTempPrepSemOs, buildTeamMetrics } from './report/builders/team-stats.builder.js';
import {
  buildDeviationInsights, buildCrossedInsights, buildActionPlans,
  buildTeamScorecard, buildExecutiveSummary,
} from './report/builders/report-summary.builder.js';
import { buildMarkdownReport } from './report/builders/markdown.builder.js';
import { analyzeOsDia } from './report/analyzers/os-dia.analyzer.js';
import { analyzeEficiencia } from './report/analyzers/eficiencia.analyzer.js';
import { analyzeUtilizacao } from './report/analyzers/utilizacao.analyzer.js';
import { analyzeTmeImp } from './report/analyzers/tme-imp.analyzer.js';
import { analyzePrimeiroLogin } from './report/analyzers/primeiro-login.analyzer.js';
import { analyzePrimeiroDesloc } from './report/analyzers/primeiro-desloc.analyzer.js';
import { analyzeRetornoBase } from './report/analyzers/retorno-base.analyzer.js';

type CsvRow = Record<string, string>;
type TeamType = 
'propria' | 'parceira';

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
    skipSave?: boolean;
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

    const kpis = buildKpiInsights(filtered.ranking);

    // Attach per-day trend (computed from desloc rows) to each KPI insight
    for (const kpi of kpis) {
      const trend = buildKpiDailyTrend(filtered.deslocamentos, kpi.kpi);
      if (trend.length > 0) kpi.dailyTrend = trend;
    }

    // For OS Dia: compute per-team-per-day Nr_Ordem counts so the analytic chart
    // can draw non-flat team lines showing each team's actual daily service order count.
    const osDiaKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('OS Dia'));
    if (osDiaKpi) {
      const perTeamData = buildPerTeamDailyCount(
        filtered.deslocamentos,
        ['Nr_Ordem', 'Nr Ordem', 'NR_ORDEM'],
      );
      if (perTeamData.length > 0) osDiaKpi.perTeamDailyData = perTeamData;
    }

    // For Eficiência: compute per-team-per-day TEMPO_PADRAO_TOTAL_CAL/TR_TOTAL_CAL so the analytic chart
    // draws each team's actual efficiency varying per reference date.
    // Uses pre-aggregated _CAL columns (computed by Spotfire) so that orders without tempo_padrao
    // correctly contribute 0 to the standard-time total but still count in the actual-time denominator.
    const eficienciaKpiChart = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Eficiência'));
    if (eficienciaKpiChart) {
      const perTeamEficiencia = buildPerTeamDailyRatio(
        filtered.deslocamentos,
        ['TEMPO_PADRAO_TOTAL_CAL'],
        ['TR_TOTAL_CAL'],
        100,
      );
      if (perTeamEficiencia.length > 0) eficienciaKpiChart.perTeamDailyData = perTeamEficiencia;
    }

    // For Utilização: HT total / HD Total are fixed per (date, team) — populate perTeamDailyData
    // so the analytic chart draws each team's actual utilização varying per reference date.
    const utilizacaoKpiChart = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Utilização'));
    if (utilizacaoKpiChart) {
      const perTeamUtilizacao = buildPerTeamDailyRatio(
        filtered.deslocamentos,
        ['HT total', 'HT Total'],
        ['HD Total'],
        100,
      );
      if (perTeamUtilizacao.length > 0) utilizacaoKpiChart.perTeamDailyData = perTeamUtilizacao;
    }

    const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
    const tempSemOs = calculateTempPrepSemOs(filtered.deslocamentos, retornoBaseAvg);
    const teamMetrics = buildTeamMetrics(tempSemOs);
    const deviationInsights = buildDeviationInsights(filtered.desvios);
    const crossedInsights = buildCrossedInsights(teamMetrics, kpis, deviationInsights.teamBreakdown);
    const osDiaAnalysis = analyzeOsDia(filtered.deslocamentos, filtered.ranking, kpis);

    // Analyze Eficiencia KPI for evidence of masked efficiency or issues
    const eficienciaAnalysis = analyzeEficiencia(filtered.deslocamentos, filtered.ranking, kpis);
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

    // Analyze Utilização KPI — jornada-level evidence for top/bottom teams
    const utilizacaoAnalysis = analyzeUtilizacao(filtered.deslocamentos, kpis);
    console.log('[Generate Report] Utilização analysis results:', utilizacaoAnalysis.length);

    // Analyze remaining KPIs — must be computed before buildActionPlans to enable per-flag recommendations
    const tmeImpAnalysis      = analyzeTmeImp(filtered.deslocamentos, filtered.ranking, kpis);
    const primeiroLoginAnalysis = analyzePrimeiroLogin(filtered.deslocamentos, kpis);
    const primeiroDeslocAnalysis = analyzePrimeiroDesloc(filtered.deslocamentos, kpis);
    const retornoBaseAnalysis  = analyzeRetornoBase(filtered.deslocamentos, kpis);

    const actionPlan = buildActionPlans(
      teamMetrics, kpis, deviationInsights.teamBreakdown,
      osDiaAnalysis, utilizacaoAnalysis, eficienciaAnalysis,
      tmeImpAnalysis, primeiroLoginAnalysis, primeiroDeslocAnalysis, retornoBaseAnalysis,
    );

    // Attach to KPI insights
    const tmeKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('TME IMP'));
    if (tmeKpi && tmeImpAnalysis.length > 0) tmeKpi.tmeImpAnalysis = tmeImpAnalysis;
    // Override TME IMP per-team daily data and global trend with per-OS Improdutivo computation
    if (tmeKpi) {
      const tmeImpDaily = buildPerTeamDailyTmeImp(filtered.deslocamentos);
      if (tmeImpDaily.globalTrend.length > 0) {
        tmeKpi.dailyTrend = tmeImpDaily.globalTrend;
        // Only include teams that had at least one Improdutiva (TR > 0).
        // Teams without any Improdutiva must not appear in the chart.
        tmeKpi.perTeamDailyData = tmeImpDaily.perTeam;
      } else if (tmeImpDaily.perTeam.length > 0) {
        tmeKpi.perTeamDailyData = tmeImpDaily.perTeam;
      }
    }
    const loginKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('1º Login'));
    if (loginKpi && primeiroLoginAnalysis.length > 0) loginKpi.primeiroLoginAnalysis = primeiroLoginAnalysis;
    // Populate per-team daily chart data for 1º Login (jornada-level: one value per team × date)
    if (loginKpi) {
      const perTeamLogin = buildPerTeamDailyValue(
        filtered.deslocamentos,
        ['1º Login Corrigido', '1o Login Corrigido', '1º Login', '1o Login'],
      );
      if (perTeamLogin.length > 0) loginKpi.perTeamDailyData = perTeamLogin;
    }
    const deslocKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('1º Desloc.'));
    if (deslocKpi && primeiroDeslocAnalysis.length > 0) deslocKpi.primeiroDeslocAnalysis = primeiroDeslocAnalysis;
    // Populate per-team daily chart data for 1º Desloc (jornada-level: one value per team × date)
    if (deslocKpi) {
      const perTeamDesloc = buildPerTeamDailyValue(
        filtered.deslocamentos,
        ['1º Desloc', '1o Desloc'],
      );
      if (perTeamDesloc.length > 0) deslocKpi.perTeamDailyData = perTeamDesloc;
    }
    const retornoKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'));
    if (retornoKpi && retornoBaseAnalysis.length > 0) retornoKpi.retornoBaseAnalysis = retornoBaseAnalysis;
    // Populate per-team daily chart data for Retorno Base (jornada-level: one value per team × date)
    if (retornoKpi) {
      const perTeamRetorno = buildPerTeamDailyValue(
        filtered.deslocamentos,
        ['Retorno a base', 'Retorno a Base', 'Retorno Base'],
      );
      if (perTeamRetorno.length > 0) retornoKpi.perTeamDailyData = perTeamRetorno;
    }

    const teamScorecard = buildTeamScorecard(filtered.ranking, kpis);
    const executiveSummary = buildExecutiveSummary(
      kpis, teamScorecard, osDiaAnalysis, utilizacaoAnalysis, actionPlan, filtered.ranking,
      tmeImpAnalysis, retornoBaseAnalysis,
    );

    // Compute actual date range from Data Referência column in the deslocamentos file
    const dataDateRange = this.computeDataDateRange(filtered.deslocamentos);

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
      executiveSummary,
      teamScorecard,
      specialAnalysis: {
        tempPrepAndSemOs: teamMetrics,
        crossedInsights,
        actionPlan,
        osDiaAnalysis,
        utilizacaoAnalysis,
        tmeImpAnalysis,
        primeiroLoginAnalysis,
        primeiroDeslocAnalysis,
        retornoBaseAnalysis,
      },
      outputFiles: {
        jsonPath: join(params.dataDirectory, this.environment.report.outputFileName),
        markdownPath: join(params.dataDirectory, this.environment.report.outputFileName.replace(/\.json$/i, '.md')),
      },
      flagMeta: {
        labels: {
          tr_excede_hd:          'Temp. Reparo > HD',
          tl_excede_hd:          'Temp. Deslocamento Alto',
          temp_prep_alto:        'Temp. Partida ≥ 10min',
          triagem_alto:           'Desp. Prioritário ≥10min',
          primeiro_desloc_alto:   '1º Desloc. ≥25min',
          sem_os_alto:           'Sem Ordem ≥ 10min',
          deslocamento_curto:    'Deslocamento Curto',
          tempo_padrao_vazio:    'Tempo Padrão Vazio',
          tr_muito_baixo:        'Tempo de Reparo Baixo',
          tme_muito_alto:        'TME IMP Elevado',
          sem_deslocamento:      'Sem Deslocamento',
          sem_execucao:          'Sem Execução',
          login_tardio:          'Login Tardio',
          login_muito_tardio:    'Login Muito Tardio',
          desloc_lento:          'Deslocamento Lento',
          desloc_muito_lento:    'Deslocamento Muito Lento',
          sem_desloc_registrado: 'Sem Desloc. Registrado',
          despacho_tardio:       'Despacho Tardio',
          retorno_alto:          'Retorno Base Alto',
          retorno_muito_alto:    'Retorno Muito Alto',
        },
      },
      dataDateRange,
    };

    if (!params.skipSave) {
      await writeFile(report.outputFiles.jsonPath, JSON.stringify(report, null, 2), 'utf-8');
      await writeFile(report.outputFiles.markdownPath, buildMarkdownReport(report), 'utf-8');
    }

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

  /** Returns the min and max dates found in the Data Referência column (DD/MM/YYYY), or null if unavailable. */
  private computeDataDateRange(rows: CsvRow[]): { min: string; max: string } | null {
    if (rows.length === 0) return null;
    const accessor = createAccessor(rows[0]);
    const dateCol = accessor.resolve(['Data Referência', 'Data Referencia']);
    if (!dateCol) return null;

    // Convert DD/MM/YYYY → numeric YYYYMMDD for comparison
    const toNum = (s: string): number => {
      const parts = s.split('/');
      if (parts.length !== 3) return NaN;
      return parseInt(parts[2], 10) * 10000 + parseInt(parts[1], 10) * 100 + parseInt(parts[0], 10);
    };

    let minStr = '';
    let maxStr = '';
    let minNum = Infinity;
    let maxNum = -Infinity;

    for (const row of rows) {
      const raw = (row[dateCol] ?? '').trim();
      if (!raw) continue;
      const n = toNum(raw);
      if (Number.isNaN(n)) continue;
      if (n < minNum) { minNum = n; minStr = raw; }
      if (n > maxNum) { maxNum = n; maxStr = raw; }
    }

    if (!minStr || !maxStr) return null;
    return { min: minStr, max: maxStr };
  }

}
