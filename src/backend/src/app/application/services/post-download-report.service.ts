// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
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

interface DailyTrendPoint {
  /** Date formatted as dd/mm */
  date: string;
  avgValue: number;
}

interface PerTeamDailyPoint {
  /** Date formatted as dd/mm */
  date: string;
  value: number;
}

interface KpiInsight {
  kpi: string;
  direction: 'higher-is-better' | 'lower-is-better';
  topTeams: KpiRankItem[];
  opportunityTeams: KpiRankItem[];
  scores: KpiTeamScore[];
  average: number;
  metaTarget: number;
  dailyTrend?: DailyTrendPoint[];
  /** Per-team per-day values (e.g. Nr_Ordem count for OS Dia). Enables non-flat team lines in the analytic chart. */
  perTeamDailyData?: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }>;
  evidenceAnalysis?: EficienciaTeamAnalysis[];
  tmeImpAnalysis?: TmeImpTeamAnalysis[];
  primeiroLoginAnalysis?: PrimeiroLoginTeamAnalysis[];
  primeiroDeslocAnalysis?: PrimeiroDeslocTeamAnalysis[];
  retornoBaseAnalysis?: RetornoBaseTeamAnalysis[];
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
  executiveSummary: ExecutiveSummary;
  teamScorecard: TeamKpiScorecard[];
  specialAnalysis: {
    tempPrepAndSemOs: TeamMetricSummary[];
    crossedInsights: CrossedInsight[];
    actionPlan: TeamActionPlan[];
    osDiaAnalysis: OsDiaTeamAnalysis[];
    utilizacaoAnalysis: UtilizacaoTeamAnalysis[];
    tmeImpAnalysis: TmeImpTeamAnalysis[];
    primeiroLoginAnalysis: PrimeiroLoginTeamAnalysis[];
    primeiroDeslocAnalysis: PrimeiroDeslocTeamAnalysis[];
    retornoBaseAnalysis: RetornoBaseTeamAnalysis[];
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
  date_ref?: string;
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
  global_avg_tl_min: number;   // global average TL across all teams (threshold reference)
  tempo_padrao_min?: number;
  temp_prep_os_min?: number;
  sem_os_details?: Array<{
    type: 'inicio_jornada' | 'entre_ordens' | 'fim_jornada' | 'intervalo_deslocamento';
    min: number;
    from?: string;
    to?: string;
    global_avg_min?: number;
    above_avg_pct?: number;
    interval_discounted?: boolean;
    retorno_base_discounted?: number;
    retorno_base_used_row?: boolean;
    desp_anterior?: string;
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
  globalAvgTlMin: number;
  tempPrepTotalMin: number;
  semOrdemTotalMin: number;
  totalOrders: number;
  totalJornadas: number;
  idleDays: number;
  idleAvgMin: number;
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
    horasExtras: number;
  };
}

interface EficienciaOrderEvidence {
  nr_ordem: string;
  date_ref?: string;
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

interface UtilizacaoOrderEvidence {
  nr_ordem: string;
  date_ref?: string;
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
    global_avg_min?: number;
    above_avg_pct?: number;
    interval_discounted?: boolean;
    retorno_base_discounted?: number;
    retorno_base_used_row?: boolean;
    desp_anterior?: string;
  }>;
  sem_os_total_min?: number;
  flags: Array<'temp_prep_alto' | 'sem_os_alto'>;
}

interface UtilizacaoTeamAnalysis {
  team: string;
  utilizacaoValue: number;
  metaTarget: number;
  gap: number;
  hdTotalMin: number;
  tempPrepTotalMin: number;
  semOrdemTotalMin: number;
  totalOrders: number;
  totalJornadas: number;
  idleDays: number;
  idleAvgMin: number;
  jornadasAbaixoMeta: number;
  flaggedOrders: UtilizacaoOrderEvidence[];
  summary: {
    countTempPrepAlto: number;
    countSemOsAlto: number;
  };
  idleAnalysis?: {
    idleMin: number;
    idlePct: number;
    horasExtras: number;
  };
}

// ─── TME IMP ───────────────────────────────────────────────────────────────
interface TmeImpOrderEvidence {
  date_ref: string;
  nr_ordem: string;
  classe: string;
  causa: string;
  prev_liberada: string;
  despachada: string;
  a_caminho: string;
  no_local: string;
  liberada: string;
  tr_ordem_min: number;
  tl_ordem_min: number;
  tme_imp_min: number;   // TR Ordem Imp SS (tempo improdutivo da ordem)
  team_avg_tme_min: number;
  global_avg_tme_min: number;
  flags: Array<'tme_muito_alto' | 'sem_deslocamento' | 'sem_execucao'>;
}

interface TmeImpTeamAnalysis {
  team: string;
  tmeImpValue: number;    // KPI médio da equipe (do ranking)
  metaTarget: number;
  gap: number;
  avgTmeImpMin: number;   // média calculada pelas ordens
  globalAvgTmeImpMin: number;
  totalOrders: number;
  flaggedOrders: TmeImpOrderEvidence[];
  summary: {
    countTmeMuitoAlto: number;
    countSemDeslocamento: number;
    countSemExecucao: number;
  };
}

// ─── 1º Login ──────────────────────────────────────────────────────────────
interface PrimeiroLoginDayEvidence {
  date_ref: string;
  inicio_calendario: string;
  log_in_corrigido: string;
  primeiro_login_min: number;   // 1º Login Corrigido (min)
  team_avg_login_min: number;
  global_avg_login_min: number;
  flags: Array<'login_tardio' | 'login_muito_tardio'>;
}

interface PrimeiroLoginTeamAnalysis {
  team: string;
  primeiroLoginValue: number;   // KPI médio (do ranking)
  metaTarget: number;
  gap: number;
  avgLoginMin: number;
  globalAvgLoginMin: number;
  totalDays: number;
  diasAcimaMetaCount: number;
  flaggedDays: PrimeiroLoginDayEvidence[];
  summary: {
    countLoginTardio: number;
    countLoginMuitoTardio: number;
  };
}

// ─── 1º Desloc. ────────────────────────────────────────────────────────────
interface PrimeiroDeslocDayEvidence {
  date_ref: string;
  nr_ordem: string;
  hora_primeiro_despacho: string;
  hora_primeiro_deslocamento: string;
  inicio_calendario: string;
  log_in_corrigido: string;
  primeiro_desloc_min: number;
  despacho_apos_inicio_min: number; // minutes from inicio_calendario to first dispatch
  login_atraso_min: number;         // minutes from inicio_calendario to login (0 if no delay)
  team_avg_desloc_min: number;
  global_avg_desloc_min: number;
  is_primeira_os_jornada: boolean;
  flags: Array<'desloc_lento' | 'desloc_muito_lento' | 'sem_desloc_registrado' | 'despacho_tardio'>;
}

interface PrimeiroDeslocTeamAnalysis {
  team: string;
  primeiroDeslocValue: number;   // KPI médio (do ranking)
  metaTarget: number;
  gap: number;
  avgDeslocMin: number;
  globalAvgDeslocMin: number;
  totalDays: number;
  diasAcimaMetaCount: number;
  flaggedDays: PrimeiroDeslocDayEvidence[];
  summary: {
    countDeslocLento: number;
    countDeslocMuitoLento: number;
    countSemDeslocRegistrado: number;
    countDespachioTardio: number;
  };
}

// ─── Retorno Base ──────────────────────────────────────────────────────────
interface RetornoBaseDayEvidence {
  date_ref: string;
  retorno_base_min: number;
  team_avg_retorno_min: number;
  global_avg_retorno_min: number;
  hora_ultima_ordem: string;
  log_off_corrigido: string;
  flags: Array<'retorno_alto' | 'retorno_muito_alto'>;
}

interface RetornoBaseTeamAnalysis {
  team: string;
  retornoBaseValue: number;   // KPI médio (do ranking)
  metaTarget: number;
  gap: number;
  avgRetornoMin: number;
  globalAvgRetornoMin: number;
  totalDays: number;
  diasAcimaMetaCount: number;
  flaggedDays: RetornoBaseDayEvidence[];
  summary: {
    countRetornoAlto: number;
    countRetornoMuitoAlto: number;
  };
}

// ─── Team Scorecard ────────────────────────────────────────────────────────
interface TeamKpiScorecard {
  team: string;
  classificacao?: number;
  diasTrabalhados?: number;
  kpis: {
    osDia?: number;
    eficiencia?: number;
    utilizacao?: number;
    tmeImp?: number;
    primeiroLogin?: number;
    primeiroDesloc?: number;
    retornoBase?: number;
  };
  kpiStatus: {
    osDia?: 'above' | 'below';
    eficiencia?: 'above' | 'below';
    utilizacao?: 'above' | 'below';
    tmeImp?: 'above' | 'below';
    primeiroLogin?: 'above' | 'below';
    primeiroDesloc?: 'above' | 'below';
    retornoBase?: 'above' | 'below';
  };
  score: number;
  kpisBelowMeta: number;
}

// ─── Executive Summary ──────────────────────────────────────────────────────
interface ExecutiveSummary {
  periodDays: number;
  totalTeams: number;
  teamsBelowMetaCount: number;
  kpiAlerts: Array<{
    kpi: string;
    teamsBelowMeta: number;
    worst: { team: string; value: number };
    meta: number;
  }>;
  topActionIssues: string[];
  idleHighlight: string | null;
  retornoBaseAlertCount: number;
  tmeImpAlertCount: number;
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

/** Column config for computing per-day KPI averages from the desloc (Tab_Completa) CSV. */
const KPI_DESLOC_DAILY_CONFIG: Record<string, {
  aliases: string[];
  aliases2?: string[];  // denominator column for ratio KPIs
  scale?: number;       // multiplier applied after ratio (e.g. 100 → percentage)
  /** When set, count distinct values of this column per team per date instead of reading a value column. */
  countBy?: string[];
  /** When true + aliases2 set, values are fixed per (date, team) — deduplicate to first row before ratio. */
  dedup?: boolean;
}> = {
  'OS Dia':       { aliases: [], countBy: ['Nr_Ordem', 'Nr Ordem', 'NR_ORDEM', 'Numero OS', 'Número OS'] },
  '1º Login':     { aliases: ['1º Login Corrigido', '1o Login Corrigido', '1º Login', '1o Login'] },
  '1º Desloc.':   { aliases: ['1º Desloc', '1o Desloc'] },
  'Retorno Base': { aliases: ['Retorno a base', 'Retorno a Base', 'Retorno Base'] },
  'TME IMP':      { aliases: ['TR Ordem Imp SS equipe', 'TR Ordem Imp SS'] },
  'Eficiência':   { aliases: ['TEMPO_PADRAO_TOTAL_CAL'], aliases2: ['TR_TOTAL_CAL'], scale: 100 },
  'Utilização':   { aliases: ['HT total', 'HT Total'], aliases2: ['HD Total'], scale: 100, dedup: true },
};

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

    const kpis = this.buildKpiInsights(filtered.ranking);

    // Attach per-day trend (computed from desloc rows) to each KPI insight
    for (const kpi of kpis) {
      const trend = this.buildKpiDailyTrend(filtered.deslocamentos, kpi.kpi);
      if (trend.length > 0) kpi.dailyTrend = trend;
    }

    // For OS Dia: compute per-team-per-day Nr_Ordem counts so the analytic chart
    // can draw non-flat team lines showing each team's actual daily service order count.
    const osDiaKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('OS Dia'));
    if (osDiaKpi) {
      const perTeamData = this.buildPerTeamDailyCount(
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
      const perTeamEficiencia = this.buildPerTeamDailyRatio(
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
      const perTeamUtilizacao = this.buildPerTeamDailyRatio(
        filtered.deslocamentos,
        ['HT total', 'HT Total'],
        ['HD Total'],
        100,
      );
      if (perTeamUtilizacao.length > 0) utilizacaoKpiChart.perTeamDailyData = perTeamUtilizacao;
    }

    const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
    const tempSemOs = this.calculateTempPrepSemOs(filtered.deslocamentos, retornoBaseAvg);
    const teamMetrics = this.buildTeamMetrics(tempSemOs);
    const deviationInsights = this.buildDeviationInsights(filtered.desvios);
    const crossedInsights = this.buildCrossedInsights(teamMetrics, kpis, deviationInsights.teamBreakdown);
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

    // Analyze Utilização KPI — jornada-level evidence for top/bottom teams
    const utilizacaoAnalysis = this.analyzeUtilizacao(filtered.deslocamentos, kpis);
    console.log('[Generate Report] Utilização analysis results:', utilizacaoAnalysis.length);

    // Analyze remaining KPIs — must be computed before buildActionPlans to enable per-flag recommendations
    const tmeImpAnalysis      = this.analyzeTmeImp(filtered.deslocamentos, filtered.ranking, kpis);
    const primeiroLoginAnalysis = this.analyzePrimeiroLogin(filtered.deslocamentos, kpis);
    const primeiroDeslocAnalysis = this.analyzePrimeiroDesloc(filtered.deslocamentos, kpis);
    const retornoBaseAnalysis  = this.analyzeRetornoBase(filtered.deslocamentos, kpis);

    const actionPlan = this.buildActionPlans(
      teamMetrics, kpis, deviationInsights.teamBreakdown,
      osDiaAnalysis, utilizacaoAnalysis, eficienciaAnalysis,
      tmeImpAnalysis, primeiroLoginAnalysis, primeiroDeslocAnalysis, retornoBaseAnalysis,
    );

    // Attach to KPI insights
    const tmeKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('TME IMP'));
    if (tmeKpi && tmeImpAnalysis.length > 0) tmeKpi.tmeImpAnalysis = tmeImpAnalysis;
    // Override TME IMP per-team daily data and global trend with per-OS Improdutivo computation
    if (tmeKpi) {
      const tmeImpDaily = this.buildPerTeamDailyTmeImp(filtered.deslocamentos);
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
    const deslocKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('1º Desloc.'));
    if (deslocKpi && primeiroDeslocAnalysis.length > 0) deslocKpi.primeiroDeslocAnalysis = primeiroDeslocAnalysis;
    const retornoKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'));
    if (retornoKpi && retornoBaseAnalysis.length > 0) retornoKpi.retornoBaseAnalysis = retornoBaseAnalysis;

    const teamScorecard = this.buildTeamScorecard(filtered.ranking, kpis);
    const executiveSummary = this.buildExecutiveSummary(
      kpis, teamScorecard, osDiaAnalysis, utilizacaoAnalysis, actionPlan, filtered.ranking,
      tmeImpAnalysis, retornoBaseAnalysis,
    );

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
    };

    if (!params.skipSave) {
      await writeFile(report.outputFiles.jsonPath, JSON.stringify(report, null, 2), 'utf-8');
      await writeFile(report.outputFiles.markdownPath, this.buildMarkdownReport(report), 'utf-8');
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

      const teamTotals = new Map<string, { sum: number; count: number }>();

      for (const row of rows) {
        const team = String(row[teamCol] ?? '').trim();
        const value = parseNumber(String(row[kpiCol] ?? ''));

        if (!team || value === null || !Number.isFinite(value)) {
          continue;
        }

        const current = teamTotals.get(team) ?? { sum: 0, count: 0 };
        current.sum += value;
        current.count += 1;
        teamTotals.set(team, current);
      }

      const values: KpiRankItem[] = Array.from(teamTotals.entries())
        .map(([team, totals]) => ({
          team,
          value: totals.sum / Math.max(totals.count, 1),
        }))
        .filter((item) => Number.isFinite(item.value));

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

      const failingTeams = threshold
        ? sorted.filter((item) =>
            direction === 'higher-is-better' ? item.value < threshold.meta : item.value > threshold.meta,
          )
        : [];

      insights.push({
        kpi,
        direction,
        topTeams: sorted.slice(0, 3).map((item) => ({ ...item, value: round2(item.value) })),
        opportunityTeams: failingTeams.slice(-3).reverse().map((item) => ({ ...item, value: round2(item.value) })),
        scores,
        average,
        metaTarget: threshold?.meta ?? 0,
      });
    }

    return insights;
  }

  /**
   * Computes a per-day global average for a KPI by reading the Tab_Completa-Deslocamentos CSV.
   * Groups rows by date then by team (first row per team-day wins for team-level aggregate columns),
   * computes the KPI value per team-day, then averages across teams.
   */
  private buildKpiDailyTrend(
    deslocRows: CsvRow[],
    kpiName: string,
  ): DailyTrendPoint[] {
    if (deslocRows.length === 0) return [];

    const config = KPI_DESLOC_DAILY_CONFIG[kpiName];
    if (!config) return [];

    const acc = createAccessor(deslocRows[0]);
    const teamCol  = acc.resolve(['Equipe']);
    const dateCol  = acc.resolve(['Data Referência', 'Data Referencia']);

    if (!teamCol || !dateCol) return [];

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d  = parseInt(parts[0] ?? '0',  10);
      const m  = parseInt(parts[1] ?? '1',  10);
      const y  = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // ── countBy mode: count distinct values of a column per team per date ────
    if (config.countBy && config.countBy.length > 0) {
      const countByCol = acc.resolve(config.countBy);
      if (!countByCol) return [];

      // date → team → Set of distinct countBy values
      const dateTeamSets = new Map<string, Map<string, Set<string>>>();
      for (const row of deslocRows) {
        const date  = String(row[dateCol] ?? '').trim();
        const team  = String(row[teamCol] ?? '').trim();
        const value = String(row[countByCol] ?? '').trim();
        if (!date || !team || !value) continue;
        const teamMap = dateTeamSets.get(date) ?? new Map<string, Set<string>>();
        const teamSet = teamMap.get(team) ?? new Set<string>();
        teamSet.add(value);
        teamMap.set(team, teamSet);
        dateTeamSets.set(date, teamMap);
      }

      const sortedDates = [...dateTeamSets.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const result: DailyTrendPoint[] = [];

      for (const fullDate of sortedDates) {
        const teamMap = dateTeamSets.get(fullDate)!;
        const counts: number[] = [];
        for (const teamSet of teamMap.values()) {
          counts.push(teamSet.size);
        }
        if (counts.length > 0) {
          const avg = counts.reduce((s, v) => s + v, 0) / counts.length;
          const ddMm = `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`;
          result.push({ date: ddMm, avgValue: round2(avg) });
        }
      }

      return result;
    }

    // ── value mode: read a numeric column per team per date ──────────────────
    const valueCol  = acc.resolve(config.aliases);
    const value2Col = config.aliases2 ? acc.resolve(config.aliases2) : null;

    if (!valueCol) return [];
    if (config.aliases2 && !value2Col) return [];

    if (config.aliases2 && value2Col) {
      if (config.dedup) {
        // Dedup-ratio mode: HT/HD are fixed per (date, team) — take the first row per team-day
        // then compute ratio from that single pair of values.
        const dateTeamMap = new Map<string, Map<string, CsvRow>>();
        for (const row of deslocRows) {
          const date = String(row[dateCol] ?? '').trim();
          const team = String(row[teamCol] ?? '').trim();
          if (!date || !team) continue;
          const teamMap = dateTeamMap.get(date) ?? new Map<string, CsvRow>();
          if (!teamMap.has(team)) teamMap.set(team, row);
          dateTeamMap.set(date, teamMap);
        }

        const sortedDates = [...dateTeamMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
        const result: DailyTrendPoint[] = [];

        for (const fullDate of sortedDates) {
          const teamMap = dateTeamMap.get(fullDate)!;
          const values: number[] = [];
          for (const row of teamMap.values()) {
            const num = parseNumber(String(row[valueCol] ?? ''));
            const den = parseNumber(String(row[value2Col] ?? ''));
            if (num !== null && den !== null && den > 0 && Number.isFinite(num) && Number.isFinite(den)) {
              values.push((num / den) * (config.scale ?? 1));
            }
          }
          if (values.length > 0) {
            const avg = values.reduce((s, v) => s + v, 0) / values.length;
            const ddMm = `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`;
            result.push({ date: ddMm, avgValue: round2(avg) });
          }
        }

        return result;
      }

      // Ratio mode: sum(numerator) / sum(denominator) per (date, team), then average across teams per date.
      // This ensures correctness for row-level columns (e.g. tempo_padrao / TR Ordem) where values
      // must be accumulated across all orders before dividing.
      const dateTeamSums = new Map<string, Map<string, { sumNum: number; sumDen: number }>>();
      for (const row of deslocRows) {
        const date = String(row[dateCol] ?? '').trim();
        const team = String(row[teamCol] ?? '').trim();
        if (!date || !team) continue;
        const num = parseNumber(String(row[valueCol] ?? ''));
        const den = parseNumber(String(row[value2Col] ?? ''));
        if (num === null || den === null || !Number.isFinite(num) || !Number.isFinite(den)) continue;
        const teamMap = dateTeamSums.get(date) ?? new Map<string, { sumNum: number; sumDen: number }>();
        const current = teamMap.get(team) ?? { sumNum: 0, sumDen: 0 };
        current.sumNum += num;
        current.sumDen += den;
        teamMap.set(team, current);
        dateTeamSums.set(date, teamMap);
      }

      const sortedDates = [...dateTeamSums.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const result: DailyTrendPoint[] = [];

      for (const fullDate of sortedDates) {
        const teamMap = dateTeamSums.get(fullDate)!;
        const values: number[] = [];
        for (const { sumNum, sumDen } of teamMap.values()) {
          if (sumDen > 0 && Number.isFinite(sumNum) && Number.isFinite(sumDen)) {
            values.push((sumNum / sumDen) * (config.scale ?? 1));
          }
        }
        if (values.length > 0) {
          const avg = values.reduce((s, v) => s + v, 0) / values.length;
          const ddMm = `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`;
          result.push({ date: ddMm, avgValue: round2(avg) });
        }
      }

      return result;
    }

    // Single-column mode: first row per team-day (deduplication — column is a jornada-level value)
    const dateTeamMap = new Map<string, Map<string, CsvRow>>();
    for (const row of deslocRows) {
      const date = String(row[dateCol] ?? '').trim();
      const team = String(row[teamCol] ?? '').trim();
      if (!date || !team) continue;
      const teamMap = dateTeamMap.get(date) ?? new Map<string, CsvRow>();
      if (!teamMap.has(team)) teamMap.set(team, row);
      dateTeamMap.set(date, teamMap);
    }

    const sortedDates = [...dateTeamMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
    const result: DailyTrendPoint[] = [];

    for (const fullDate of sortedDates) {
      const teamMap = dateTeamMap.get(fullDate)!;
      const values: number[] = [];

      for (const row of teamMap.values()) {
        const v = parseNumber(String(row[valueCol] ?? ''));
        if (v !== null && Number.isFinite(v) && v >= 0) {
          values.push(config.scale ? v * config.scale : v);
        }
      }

      if (values.length > 0) {
        const avg = values.reduce((s, v) => s + v, 0) / values.length;
        // Display date as dd/mm (strip year from dd/mm/yyyy)
        const ddMm = `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`;
        result.push({ date: ddMm, avgValue: round2(avg) });
      }
    }

    return result;
  }

  /**
   * Computes sum(numerator) / sum(denominator) per team per reference date.
   * Returns one entry per team with a chronologically sorted array of { date (dd/mm), value }.
   * Used to populate `perTeamDailyData` for ratio KPIs (e.g. Eficiência = sum(tempo_padrao)/sum(TR Ordem)*100)
   * so the analytic chart draws each team's actual value varying per date.
   */
  private buildPerTeamDailyRatio(
    deslocRows: CsvRow[],
    numCandidates: string[],
    denCandidates: string[],
    scale = 1,
  ): Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> {
    if (deslocRows.length === 0) return [];

    const acc = createAccessor(deslocRows[0]);
    const teamCol = acc.resolve(['Equipe']);
    const dateCol = acc.resolve(['Data Referência', 'Data Referencia']);
    const numCol  = acc.resolve(numCandidates);
    const denCol  = acc.resolve(denCandidates);

    if (!teamCol || !dateCol || !numCol || !denCol) return [];

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d = parseInt(parts[0] ?? '0', 10);
      const m = parseInt(parts[1] ?? '1', 10);
      const y = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // team → date (dd/mm/yyyy) → { sumNum, sumDen }
    const teamDateSums = new Map<string, Map<string, { sumNum: number; sumDen: number }>>();
    for (const row of deslocRows) {
      const date = String(row[dateCol] ?? '').trim();
      const team = String(row[teamCol] ?? '').trim();
      if (!date || !team) continue;
      const num = parseNumber(String(row[numCol] ?? ''));
      const den = parseNumber(String(row[denCol] ?? ''));
      if (num === null || den === null || !Number.isFinite(num) || !Number.isFinite(den)) continue;
      const dateMap = teamDateSums.get(team) ?? new Map<string, { sumNum: number; sumDen: number }>();
      const current = dateMap.get(date) ?? { sumNum: 0, sumDen: 0 };
      current.sumNum += num;
      current.sumDen += den;
      dateMap.set(date, current);
      teamDateSums.set(team, dateMap);
    }

    const result: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> = [];

    for (const [team, dateMap] of teamDateSums) {
      const sortedDates = [...dateMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const dailyPoints: PerTeamDailyPoint[] = [];
      for (const fullDate of sortedDates) {
        const { sumNum, sumDen } = dateMap.get(fullDate)!;
        if (sumDen > 0) {
          dailyPoints.push({
            date: `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`,
            value: round2((sumNum / sumDen) * scale),
          });
        }
      }
      if (dailyPoints.length > 0) result.push({ team, dailyPoints });
    }

    result.sort((a, b) => a.team.localeCompare(b.team, 'pt-BR'));
    return result;
  }

  /**
   * Counts distinct values of `countByCandidates` column per team per date.
   * Returns one entry per team with a chronologically sorted array of { date (dd/mm), value (count) }.
   * Used to populate `perTeamDailyData` for OS Dia so the analytic chart can draw non-flat team lines.
   */
  private buildPerTeamDailyCount(
    deslocRows: CsvRow[],
    countByCandidates: string[],
  ): Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> {
    if (deslocRows.length === 0) return [];

    const acc = createAccessor(deslocRows[0]);
    const teamCol   = acc.resolve(['Equipe']);
    const dateCol   = acc.resolve(['Data Referência', 'Data Referencia']);
    const countByCol = acc.resolve(countByCandidates);

    if (!teamCol || !dateCol || !countByCol) return [];

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d = parseInt(parts[0] ?? '0', 10);
      const m = parseInt(parts[1] ?? '1', 10);
      const y = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // team → date (dd/mm/yyyy) → Set<countByValue>
    const teamDateSets = new Map<string, Map<string, Set<string>>>();
    for (const row of deslocRows) {
      const date  = String(row[dateCol] ?? '').trim();
      const team  = String(row[teamCol] ?? '').trim();
      const value = String(row[countByCol] ?? '').trim();
      if (!date || !team || !value) continue;
      const dateMap = teamDateSets.get(team) ?? new Map<string, Set<string>>();
      const dateSet = dateMap.get(date) ?? new Set<string>();
      dateSet.add(value);
      dateMap.set(date, dateSet);
      teamDateSets.set(team, dateMap);
    }

    const result: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> = [];

    for (const [team, dateMap] of teamDateSets) {
      const sortedDates = [...dateMap.keys()].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const dailyPoints: PerTeamDailyPoint[] = sortedDates.map((fullDate) => ({
        date: `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`,
        value: dateMap.get(fullDate)!.size,
      }));
      result.push({ team, dailyPoints });
    }

    // Sort teams alphabetically for deterministic output
    result.sort((a, b) => a.team.localeCompare(b.team, 'pt-BR'));
    return result;
  }

  /**
   * Computes per-team daily TME IMP values:
   *   value(team, date) = avg(TR Ordem) for rows where status == "Improdutivo" AND TR Ordem > 20.
   * Only teams that have at least one qualifying row on any day are included.
   * Days where the team has no qualifying rows receive value = 0.
   * Also returns a global daily trend (avg across qualifying teams per date, ignoring 0s).
   */
  private buildPerTeamDailyTmeImp(
    deslocRows: CsvRow[],
  ): {
    perTeam: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }>;
    globalTrend: DailyTrendPoint[];
  } {
    if (deslocRows.length === 0) return { perTeam: [], globalTrend: [] };

    const acc = createAccessor(deslocRows[0]);
    const teamCol   = acc.resolve(['Equipe']);
    const dateCol   = acc.resolve(['Data Referência', 'Data Referencia']);
    const statusCol = acc.resolve(['status', 'Status']);
    const trCol     = acc.resolve(['TR Ordem', 'TR_Ordem']);

    if (!teamCol || !dateCol || !statusCol || !trCol) return { perTeam: [], globalTrend: [] };

    const parseFullDate = (s: string): number => {
      const parts = s.split('/');
      const d = parseInt(parts[0] ?? '0', 10);
      const m = parseInt(parts[1] ?? '1', 10);
      const y = parseInt(parts[2] ?? '2000', 10);
      return y * 10000 + m * 100 + d;
    };

    // Collect all dates each team appears on (to fill in 0s for days without Improdutivo)
    const teamAllDates = new Map<string, Set<string>>();
    // Qualifying rows: team → date → [TR Ordem values]
    const teamDateTrs  = new Map<string, Map<string, number[]>>();

    for (const row of deslocRows) {
      const date   = String(row[dateCol]   ?? '').trim();
      const team   = String(row[teamCol]   ?? '').trim();
      const status = String(row[statusCol] ?? '').trim();
      const trRaw  = parseNumber(String(row[trCol] ?? ''));

      if (!date || !team) continue;

      const allDates = teamAllDates.get(team) ?? new Set<string>();
      allDates.add(date);
      teamAllDates.set(team, allDates);

      if (status === 'Improdutivo' && trRaw !== null && trRaw > 0) {
        const dateMap = teamDateTrs.get(team) ?? new Map<string, number[]>();
        const vals    = dateMap.get(date) ?? [];
        vals.push(trRaw);
        dateMap.set(date, vals);
        teamDateTrs.set(team, dateMap);
      }
    }

    // Build per-team result — only teams with at least one qualifying row
    const perTeam: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }> = [];
    for (const [team, impDateMap] of teamDateTrs) {
      const allDates   = teamAllDates.get(team) ?? new Set<string>();
      const sortedDates = [...allDates].sort((a, b) => parseFullDate(a) - parseFullDate(b));
      const dailyPoints: PerTeamDailyPoint[] = sortedDates.map((fullDate) => {
        const vals  = impDateMap.get(fullDate);
        const value = vals && vals.length > 0
          ? round2(vals.reduce((s, v) => s + v, 0) / vals.length)
          : 0;
        return { date: `${fullDate.slice(0, 2)}/${fullDate.slice(3, 5)}`, value };
      });
      perTeam.push({ team, dailyPoints });
    }
    perTeam.sort((a, b) => a.team.localeCompare(b.team, 'pt-BR'));

    // Build global daily trend: per date, average of qualifying (non-zero) team values
    const dateTeamValues = new Map<string, number[]>();
    for (const { dailyPoints } of perTeam) {
      for (const pt of dailyPoints) {
        if (pt.value > 0) {
          const vals = dateTeamValues.get(pt.date) ?? [];
          vals.push(pt.value);
          dateTeamValues.set(pt.date, vals);
        }
      }
    }
    // Sort dates dd/mm chronologically using full-date sort from perTeam (already ordered)
    const allDdMm = [...dateTeamValues.keys()].sort((a, b) => {
      const [da, ma] = a.split('/').map(Number);
      const [db, mb] = b.split('/').map(Number);
      return (ma! * 100 + da!) - (mb! * 100 + db!);
    });
    const globalTrend: DailyTrendPoint[] = allDdMm.map((ddMm) => {
      const vals = dateTeamValues.get(ddMm)!;
      return { date: ddMm, avgValue: round2(vals.reduce((s, v) => s + v, 0) / vals.length) };
    });

    // Ensure every team has an entry for every globalTrend date.
    // Teams that have no CSV rows for a given date won't have that date in their dailyPoints;
    // without this fill, the chart falls back to the team's flat ranking value instead of 0.
    const trendDateSet = new Set(allDdMm);
    for (const entry of perTeam) {
      const existing = new Set(entry.dailyPoints.map((p) => p.date));
      for (const ddMm of trendDateSet) {
        if (!existing.has(ddMm)) {
          entry.dailyPoints.push({ date: ddMm, value: 0 });
        }
      }
      // Re-sort chronologically after filling gaps
      entry.dailyPoints.sort((a, b) => {
        const [da, ma] = a.date.split('/').map(Number);
        const [db, mb] = b.date.split('/').map(Number);
        return (ma! * 100 + da!) - (mb! * 100 + db!);
      });
    }

    return { perTeam, globalTrend };
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
    osDiaAnalysis: OsDiaTeamAnalysis[] = [],
    utilizacaoAnalysis: UtilizacaoTeamAnalysis[] = [],
    eficienciaAnalysis: EficienciaTeamAnalysis[] = [],
    tmeImpAnalysis: TmeImpTeamAnalysis[] = [],
    primeiroLoginAnalysis: PrimeiroLoginTeamAnalysis[] = [],
    primeiroDeslocAnalysis: PrimeiroDeslocTeamAnalysis[] = [],
    retornoBaseAnalysis: RetornoBaseTeamAnalysis[] = [],
  ): TeamActionPlan[] {
    const deviationMap = new Map(teamDeviations.map((item) => [item.team, item.deviations]));
    const osDiaMap = new Map(osDiaAnalysis.map((a) => [a.team, a]));
    const utilizacaoMap = new Map(utilizacaoAnalysis.map((a) => [a.team, a]));
    const eficienciaMap = new Map(
      eficienciaAnalysis
        .filter((a) => a.analysisType === 'underperformer')
        .map((a) => [a.team, a]),
    );
    const tmeImpMap       = new Map(tmeImpAnalysis.map((a) => [a.team, a]));
    const loginMap        = new Map(primeiroLoginAnalysis.map((a) => [a.team, a]));
    const deslocMap       = new Map(primeiroDeslocAnalysis.map((a) => [a.team, a]));
    const retornoMap      = new Map(retornoBaseAnalysis.map((a) => [a.team, a]));

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
      const osDia = osDiaMap.get(tm.team);
      const util = utilizacaoMap.get(tm.team);
      const efic = eficienciaMap.get(tm.team);

      // Determine which KPI categories this team is failing
      const teamInOsDia   = kpis.find((k) => k.kpi === 'OS Dia')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInUtil    = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Utilização'))?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInEfic    = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Eficiência'))?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInTme     = kpis.find((k) => k.kpi === 'TME IMP')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInLogin   = kpis.find((k) => k.kpi === '1º Login')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInDesloc  = kpis.find((k) => k.kpi === '1º Desloc.')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInRetorno = kpis.find((k) => k.kpi === 'Retorno Base')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;

      // Helper: KPI impact label to append as context at the end of each issue
      const kpiCtx = (kpiName: string): string => ` → impacta ${kpiName} abaixo da meta.`;

      // ── OS Dia / Utilização — flag-first analysis ──────────────────────────
      if (teamInOsDia || teamInUtil) {
        const idleAnalysis = osDia ?? util;
        if (idleAnalysis) {
          type SharedEv = {
            flags: string[];
            nr_ordem?: string;
            prev_liberada?: string;
            temp_prep_os_min?: number;
            sem_os_details?: Array<{ type: string; min: number }>;
            sem_os_total_min?: number;
            tl_ordem_min: number;
            hd_pct_tr?: number;
            hd_total_min?: number;
            tr_ordem_min?: number;
            tempo_padrao_min?: number;
          };
          const orders = idleAnalysis.flaggedOrders as unknown as SharedEv[];
          const kpiLabel = teamInOsDia && teamInUtil ? 'OS Dia e Utilização' : teamInOsDia ? 'OS Dia' : 'Utilização';

          // TR and TL only affect OS Dia and Eficiência — Utilização is driven by idle time (TempPrep, SemOrdem)
          const trTlParts: string[] = [];
          if (teamInOsDia) trTlParts.push('OS Dia');
          if (teamInEfic) trTlParts.push('Eficiência');
          const kpiLabelTrTl = trTlParts.length > 0 ? trTlParts.join(' e ') : 'OS Dia';

          // Flag: TR>20%HD — OS com tempo de reparo acima de 20% da jornada
          const trExcede = orders.filter((o) => o.flags.includes('tr_excede_hd'));
          if (trExcede.length > 0) {
            const worst = trExcede.slice().sort((a, b) => (b.tr_ordem_min ?? 0) - (a.tr_ordem_min ?? 0))[0];
            issues.push(
              `Temp. Reparo>20%HD: ${trExcede.length} OS com tempo de reparo acima de 20% da jornada — pior caso OS ${worst.nr_ordem ?? '—'}` +
              ` (${worst.tr_ordem_min ?? '?'} min, ${worst.hd_pct_tr ?? '?'}% da HD de ${worst.hd_total_min ?? '?'} min).` +
              kpiCtx(kpiLabelTrTl),
            );
            recommendations.push(
              `Temp. Reparo>20%HD — Comparar as OS mais longas com o Tempo Padrão M300` +
              (worst.tempo_padrao_min !== undefined ? ` (${worst.tempo_padrao_min} min cadastrado para essa classe/causa)` : ' (sem tempo padrão cadastrado para esse tipo — solicitar ao time de engenharia)') +
              `. Se o TR real superar o padrão de forma sistemática, levantar a causa raiz (complexidade, falta de material, erro de diagnóstico) e escalar para o supervisor.`,
            );
          }

          // Flag: TL>25%médG — OS com deslocamento acima de 25% da média global
          const tlExcede = orders.filter((o) => o.flags.includes('tl_excede_hd'));
          if (tlExcede.length > 0) {
            issues.push(
              `TL>25%médG: ${tlExcede.length} OS com tempo de deslocamento acima de 25% da média global — cada OS com TL longo retira tempo produtivo da jornada.` +
              kpiCtx(kpiLabelTrTl),
            );
            recommendations.push(
              `TL>25%médG — Avaliar com o planejamento a distribuição geográfica das ordens desta equipe; se o padrão for recorrente, identificar OS sistematicamente distantes e propor ajuste no roteiro de despacho.`,
            );
          }

          // Flag: TempPrep≥10min — demora entre despacho e saída
          const tempPrepOrders = orders.filter((o) => o.flags.includes('temp_prep_alto'));
          if (tempPrepOrders.length > 0) {
            const avgTp = round2(tempPrepOrders.reduce((s, o) => s + (o.temp_prep_os_min ?? 0), 0) / tempPrepOrders.length);
            const firstOs = tempPrepOrders.filter((o) => !o.prev_liberada);
            const betweenOs = tempPrepOrders.filter((o) => Boolean(o.prev_liberada));
            const ctx = firstOs.length > 0 && betweenOs.length > 0
              ? `${betweenOs.length} entre ordens e ${firstOs.length} na 1ª OS do dia`
              : firstOs.length > 0 ? `${firstOs.length} na 1ª OS do dia — demora desde o início de calendário até o primeiro deslocamento`
              : `${betweenOs.length} entre ordens — demora após receber um novo despacho`;
            issues.push(
              `Temp. Partida elevado: ${tempPrepOrders.length} OS com tempo de preparação elevado (média ${avgTp} min — ${ctx}).` +
              kpiCtx('Utilização'),
            );
            recommendations.push(
              `Temp. Partida elevado — Ao receber o despacho, acionar imediatamente o status "A Caminho" sem aguardar na base.` +
              (firstOs.length > 0 ? ` Para a 1ª OS do dia, o limite é de 25 min (Início Calendário → A Caminho); para as demais ordens o limite é de 10 min (Lib. Anterior → A Caminho).` : '') +
              ` Reforçar no próximo alinhamento que Temp. Partida alto é descontado diretamente na Utilização.`,
            );
          }

          // Flag: SemOrdem≥10min — intervalos sem atendimento
          if (idleAnalysis.summary.countSemOsAlto > 0) {
            const semOsOrders = orders.filter((o) => o.flags.includes('sem_os_alto'));
            const avgMin = semOsOrders.length > 0
              ? round2(semOsOrders.reduce((s, o) => s + (o.sem_os_total_min ?? 0), 0) / semOsOrders.length)
              : round2(idleAnalysis.semOrdemTotalMin);
            const hasEntreOrdens = semOsOrders.some((o) => o.sem_os_details?.some((d) => d.type === 'entre_ordens'));
            const hasInicio = semOsOrders.some((o) => o.sem_os_details?.some((d) => d.type === 'inicio_jornada'));
            const semOsCtx = hasEntreOrdens && hasInicio ? 'entre ordens e no início de jornada'
              : hasEntreOrdens ? 'entre ordens' : 'no início de jornada';
            issues.push(
              `SemOrdem≥10min: ${idleAnalysis.summary.countSemOsAlto} OS/dias com tempo ocioso acima de 10 min (média ${avgMin} min — ${semOsCtx}).` +
              kpiCtx('Utilização'),
            );
            recommendations.push(
              `SemOrdem≥10min — Ao liberar uma OS, acionar imediatamente a central para receber o próximo despacho; cobrar que o técnico não aguarde passivamente. Se o gargalo for da central (fila vazia), mapear o horário de pico e ajustar a priorização de despacho.`,
            );

            // Intervalo de almoço suspeito
            const intervaloDesl = semOsOrders.filter((o) => o.sem_os_details?.some((d) => d.type === 'intervalo_deslocamento'));
            if (intervaloDesl.length > 0) {
              const avgItvMin = round2(intervaloDesl.reduce((s, o) => {
                const d = o.sem_os_details?.find((x) => x.type === 'intervalo_deslocamento');
                return s + (d?.min ?? 0);
              }, 0) / intervaloDesl.length);
              issues.push(
                `Desl. para intervalo suspeito: ${intervaloDesl.length} OS com deslocamento de ${avgItvMin} min antes do intervalo de almoço — possível saída de ponto para realizar o intervalo.`,
              );
              recommendations.push(
                `Desl. para intervalo — Orientar que o intervalo de almoço deve ser iniciado a partir do ponto atual de atendimento, não de um novo endereço; deslocamentos longos pré-intervalo são contabilizados no SemOrdem.`,
              );
            }
          }

          // Horas extras + ociosidade elevada
          const ia = idleAnalysis.idleAnalysis;
          if (ia && ia.horasExtras > 0 && ia.idlePct >= 15) {
            issues.push(
              `Horas extras com ociosidade elevada: ${round2(ia.horasExtras)} min/dia de horas extras registradas com ${ia.idlePct.toFixed(1)}% de ociosidade simultânea — possível janela improdutiva não declarada.`,
            );
            recommendations.push(
              `Horas extras + ociosidade — Revisar os apontamentos do período: identificar se as horas extras coincidem com SemOrdem ou TempPrep elevado; se sim, solicitar justificativa do técnico e corrigir os registros.`,
            );
          }
        }
      }

      // ── Eficiência — flag-first analysis ──────────────────────────────────
      const eficAny = eficienciaAnalysis.find((a) => a.team === tm.team);

      // Flag: TR muito baixo (qualquer analysisType — indica erro de apontamento)
      const trBaixoOrders = eficAny?.flaggedOrders.filter((o) => o.flags.includes('tr_muito_baixo')) ?? [];
      if (trBaixoOrders.length > 0) {
        const globalAvgExec = eficAny!.globalAvgExecucaoMin;
        const globalAvgTl   = eficAny!.globalAvgDeslocamentoMin;
        const avgTl = round2(trBaixoOrders.reduce((s, o) => s + o.tl_ordem_min, 0) / trBaixoOrders.length);
        const tlAlto = globalAvgTl > 0 && avgTl > globalAvgTl;
        const worst = trBaixoOrders.slice().sort((a, b) => a.tr_ordem_min - b.tr_ordem_min)[0];
        issues.push(
          `Temp. Reparo muito baixo: ${trBaixoOrders.length} OS com tempo de execução muito abaixo da média global (${round2(globalAvgExec)} min) — pior caso OS ${worst.nr_ordem} com ${worst.tr_ordem_min} min.` +
          (tlAlto ? ` TL médio dessas OS (${avgTl} min) acima da média global (${round2(globalAvgTl)} min) — reforça hipótese de erro de apontamento.` : '') +
          kpiCtx('Eficiência'),
        );
        recommendations.push(
          `Temp. Reparo muito baixo — Cobrar que cada etapa do atendimento seja registrada no momento exato: "A Caminho" ao sair, "No Local" ao chegar e liberação da OS ao concluir.` +
          (tlAlto ? ` O TL elevado dessas OS indica que "A Caminho" foi acionado tarde ou "No Local" foi acionado cedo, comprimindo artificialmente o TR registrado.` : ` Apontamentos fora de ordem ou com atraso distorcem o TR real e prejudicam o resultado de Eficiência de toda a equipe.`),
        );
      }

      if (teamInEfic && efic) {
        // Flag: TL muito curto — possível técnico já no local ou erro de A Caminho
        const deslocCurto = efic.flaggedOrders.filter((o) => o.flags.includes('deslocamento_curto'));
        if (deslocCurto.length > 0) {
          issues.push(
            `TL muito curto: ${deslocCurto.length} OS com deslocamento inferior a 25% da média global — possível atendimento sem deslocamento real ou erro de apontamento de "A Caminho".` +
            kpiCtx('Eficiência'),
          );
          recommendations.push(
            `TL muito curto — Verificar se o status "A Caminho" está sendo acionado no local correto e no momento certo; se o técnico já estava no local ao receber o despacho, orientar que isso deve ser comunicado à central para ajuste de roteiro.`,
          );
        }

        // Flag: Tempo Padrão ausente — OS executadas sem referência no M300
        const countTp = Math.max(
          efic.flaggedOrders.filter((o) => o.flags.includes('tempo_padrao_vazio')).length,
          efic.summary.countTempoPadraoVazio,
        );
        if (countTp > 0) {
          issues.push(
            `Tempo Padrão ausente: ${countTp} OS executadas sem Tempo Padrão cadastrado no M300 — eficiência contada como zero nessas OS independentemente do tempo real de execução.` +
            kpiCtx('Eficiência'),
          );
          recommendations.push(
            `Tempo Padrão ausente — Levantar as classes/causas dessas ${countTp} OS e solicitar formalmente ao time de engenharia o cadastro do Tempo Padrão correspondente. Enquanto não cadastrado, a equipe é penalizada mesmo executando o atendimento corretamente.`,
          );
        }

        // Flag: TR>20%HD (Eficiência — deslocamento muito curto somado ao TR longo)
        const trExcedeEfic = efic.flaggedOrders.filter((o) => o.flags.includes('tr_excede_hd'));
        if (trExcedeEfic.length > 0) {
          const hasDeslocCurto = trExcedeEfic.some((o) => o.tl_ordem_min < 5);
          issues.push(
            `Temp. Reparo>20%HD (Eficiência): ${trExcedeEfic.length} OS com tempo de reparo acima de 20% da jornada` +
            (hasDeslocCurto ? ` — ${trExcedeEfic.filter((o) => o.tl_ordem_min < 5).length} delas com TL <5 min, sugerindo técnico já no local ou erro de "A Caminho".` : '.') +
            kpiCtx('Eficiência'),
          );
          recommendations.push(
            `Temp. Reparo>20%HD (Eficiência) — ${hasDeslocCurto ? 'Verificar se o botão "A Caminho" está sendo acionado no endereço correto e no momento certo; ' : ''}` +
            `investigar as OS mais longas: comparar com o Tempo Padrão M300 e identificar se a causa raiz é complexidade real ou apontamento incorreto.`,
          );
        }
      }

      // ── TME IMP — flag-first analysis ──────────────────────────────────────
      if (teamInTme) {
        const tme = tmeImpMap.get(tm.team);
        if (tme) {
          if (tme.summary.countTmeMuitoAlto > 0) {
            const worst = tme.flaggedOrders
              .filter((o) => o.flags.includes('tme_muito_alto'))
              .sort((a, b) => b.tme_imp_min - a.tme_imp_min)[0];
            issues.push(
              `TME IMP elevado: ${tme.summary.countTmeMuitoAlto} OS com tempo improdutivo (No Local → Liberada) acima de 1,5× a média — pior caso OS ${worst.nr_ordem}` +
              ` com ${round2(worst.tme_imp_min)} min (vs. média da equipe ${round2(worst.team_avg_tme_min)} min).` +
              kpiCtx('TME IMP'),
            );
            recommendations.push(
              `TME IMP elevado — Verificar se havia impedimento de acesso, aguardo de material/apoio técnico ou se a OS ficou aberta após o atendimento. Cobrar que "Liberada" seja acionada imediatamente ao concluir o serviço no local.`,
            );
          }
          if (tme.summary.countSemDeslocamento > 0) {
            issues.push(
              `Sem "A Caminho" registrado: ${tme.summary.countSemDeslocamento} OS sem status de deslocamento — sem esse dado o TME IMP é inflado artificialmente, pois o tempo começa a contar desde o último status anterior.` +
              kpiCtx('TME IMP'),
            );
            recommendations.push(
              `Sem "A Caminho" — Reforçar uso correto do aplicativo: acionar "A Caminho" no momento exato da saída para cada atendimento. A ausência desse registro impede o cálculo correto do TME IMP e prejudica o KPI de toda a equipe.`,
            );
          }
          if (tme.summary.countSemExecucao > 0) {
            issues.push(
              `Sem TR registrado: ${tme.summary.countSemExecucao} OS com tempo improdutivo mas sem execução — OS encerrada sem atendimento real ou lançamento incorreto no sistema.` +
              kpiCtx('TME IMP'),
            );
            recommendations.push(
              `Sem TR registrado — Verificar junto ao técnico o que ocorreu nessas OS; se foram encerradas incorretamente, solicitar correção no sistema para que a execução seja contabilizada corretamente.`,
            );
          }
          if (!tme.summary.countTmeMuitoAlto && !tme.summary.countSemDeslocamento && !tme.summary.countSemExecucao) {
            issues.push(
              `TME IMP médio de ${round2(tme.tmeImpValue)} min — acima da meta de ${tme.metaTarget} min; tempo improdutivo entre chegada ao local e liberação da OS está elevado.` +
              kpiCtx('TME IMP'),
            );
            recommendations.push(
              `TME IMP — Cobrar que ao chegar ao local o técnico inicie imediatamente os procedimentos de atendimento e acione "Liberada" assim que concluir, sem deixar a OS aberta.`,
            );
          }
        }
      }

      // ── 1º Login — flag-first analysis ────────────────────────────────────
      if (teamInLogin) {
        const login = loginMap.get(tm.team);
        if (login) {
          if (login.summary.countLoginMuitoTardio > 0) {
            const worst = login.flaggedDays
              .filter((d) => d.flags.includes('login_muito_tardio'))
              .sort((a, b) => b.primeiro_login_min - a.primeiro_login_min)[0];
            issues.push(
              `Login muito tardio: ${login.summary.countLoginMuitoTardio} dia(s) com acesso ao sistema com mais do dobro da meta de ${login.metaTarget} min — pior caso ${worst.date_ref} com ${round2(worst.primeiro_login_min)} min. Atrasa o primeiro despacho e reduz os atendimentos possíveis no dia.` +
              kpiCtx('1º Login'),
            );
            recommendations.push(
              `Login muito tardio — Investigar a causa específica (problema técnico, hábito operacional ou evento pontual) no(s) dia(s) identificado(s). Reforçar que o login deve ser a primeira ação ao iniciar a jornada; cada minuto de atraso retarda o primeiro despacho diretamente.`,
            );
          } else if (login.summary.countLoginTardio > 0) {
            const lateOnes = login.flaggedDays.filter((d) => d.flags.includes('login_tardio'));
            const avgLate = lateOnes.length > 0 ? round2(lateOnes.reduce((s, d) => s + d.primeiro_login_min, 0) / lateOnes.length) : 0;
            issues.push(
              `Login tardio: ${login.summary.countLoginTardio} dia(s) com login acima da meta de ${login.metaTarget} min (média ${avgLate} min nesse(s) dia(s)).` +
              kpiCtx('1º Login'),
            );
            recommendations.push(
              `Login tardio — Orientar login imediato ao iniciar a jornada. Se o atraso for recorrente nos mesmos dias da semana, investigar causa estrutural (trânsito, escala, problema técnico) e tratar com o supervisor.`,
            );
          }
          if (login.diasAcimaMetaCount > 1) {
            recommendations.push(
              `Login tardio recorrente em ${login.diasAcimaMetaCount}/${login.totalDays} dias — verificar se há problema técnico de acesso ao sistema ou hábito operacional; abordar no próximo alinhamento de equipe com foco em rotina de início de turno.`,
            );
          }
        }
      }

      // ── 1º Desloc. — flag-first analysis ──────────────────────────────────
      if (teamInDesloc) {
        const desloc = deslocMap.get(tm.team);
        if (desloc) {
          if (desloc.summary.countDeslocMuitoLento > 0) {
            const worst = desloc.flaggedDays
              .filter((d) => d.flags.includes('desloc_muito_lento'))
              .sort((a, b) => b.primeiro_desloc_min - a.primeiro_desloc_min)[0];
            issues.push(
              `1º Desloc. muito lento: ${desloc.summary.countDeslocMuitoLento} dia(s) com mais de 1,5× a meta de ${desloc.metaTarget} min entre o primeiro despacho e "A Caminho" — pior caso ${worst.date_ref} com ${round2(worst.primeiro_desloc_min)} min parado antes de sair.` +
              kpiCtx('1º Desloc.'),
            );
            recommendations.push(
              `1º Desloc. muito lento — Investigar o que reteve o técnico antes de sair no(s) dia(s) identificado(s) (preparação de material, reunião, etc.). Reforçar que ao receber o primeiro despacho o status "A Caminho" deve ser acionado imediatamente.`,
            );
          } else if (desloc.summary.countDeslocLento > 0) {
            issues.push(
              `1º Desloc. lento: ${desloc.summary.countDeslocLento} dia(s) com tempo entre despacho e "A Caminho" acima de ${desloc.metaTarget} min — saída tardia para o primeiro atendimento reduz o aproveitamento da jornada.` +
              kpiCtx('1º Desloc.'),
            );
            recommendations.push(
              `1º Desloc. lento — Cobrar que "A Caminho" seja acionado imediatamente ao receber o despacho; se houver preparação prévia necessária, antecipar essa etapa antes da janela de despacho.`,
            );
          }
          if (desloc.summary.countSemDeslocRegistrado > 0) {
            issues.push(
              `Sem "A Caminho" no 1º despacho: ${desloc.summary.countSemDeslocRegistrado} dia(s) sem registro de saída após o primeiro despacho — impossível calcular o 1º Desloc. real.` +
              kpiCtx('1º Desloc.'),
            );
            recommendations.push(
              `Sem "A Caminho" no 1º despacho — Reforçar uso correto do aplicativo: acionar "A Caminho" ao sair, mesmo que já esteja em deslocamento. A ausência prejudica o cálculo do KPI e impede identificar atrasos reais.`,
            );
          }
          if (desloc.summary.countDespachioTardio > 0) {
            const tardioOnes = desloc.flaggedDays.filter((d) => d.flags.includes('despacho_tardio'));
            const avgTardio  = tardioOnes.length > 0 ? round2(tardioOnes.reduce((s, d) => s + d.despacho_apos_inicio_min, 0) / tardioOnes.length) : 0;
            const loginDelay = tardioOnes.length > 0 ? round2(tardioOnes.reduce((s, d) => s + d.login_atraso_min, 0) / tardioOnes.length) : 0;
            issues.push(
              `Despacho tardio: ${desloc.summary.countDespachioTardio} dia(s) com o primeiro despacho recebido com mais de 10 min após o início de jornada — média de ${avgTardio} min` +
              (loginDelay > 0 ? ` (inclui ${loginDelay} min de atraso de login)` : '') + `.` +
              kpiCtx('1º Desloc.'),
            );
            recommendations.push(
              `Despacho tardio — ${loginDelay > 0 ? 'Parte do atraso origina-se do login tardio: garantir que o técnico esteja logado antes do início da janela de despacho. ' : ''}` +
              `Alinhar com a central o horário de início dos despachos para esta equipe e garantir prontidão desde o início do turno.`,
            );
          }
        }
      }

      // ── Retorno Base — flag-first analysis ────────────────────────────────
      if (teamInRetorno) {
        const retorno = retornoMap.get(tm.team);
        if (retorno) {
          if (retorno.summary.countRetornoMuitoAlto > 0) {
            const worst = retorno.flaggedDays
              .filter((d) => d.flags.includes('retorno_muito_alto'))
              .sort((a, b) => b.retorno_base_min - a.retorno_base_min)[0];
            issues.push(
              `Retorno Base muito alto: ${retorno.summary.countRetornoMuitoAlto} dia(s) com retorno acima de 1,5× a meta de ${retorno.metaTarget} min — pior caso ${worst.date_ref} com ${round2(worst.retorno_base_min)} min. Esse tempo é descontado diretamente na Utilização.` +
              kpiCtx('Retorno Base'),
            );
            recommendations.push(
              `Retorno muito alto — Avaliar com o planejamento se a última OS do dia pode ser encerrada geograficamente mais próxima da base; se o trajeto de retorno for sistematicamente longo, propor ajuste no roteiro de encerramento de turno.`,
            );
          } else if (retorno.summary.countRetornoAlto > 0) {
            issues.push(
              `Retorno Base acima da meta: ${retorno.summary.countRetornoAlto} dia(s) com retorno entre a última OS e a base acima de ${retorno.metaTarget} min — esse tempo é descontado na Utilização.` +
              kpiCtx('Retorno Base'),
            );
            recommendations.push(
              `Retorno acima da meta — Avaliar a possibilidade de encerrar a jornada com OS mais próximas da base; discutir redistribuição geográfica das últimas ordens do dia com o planejamento.`,
            );
          }
          if (retorno.diasAcimaMetaCount > 1) {
            recommendations.push(
              `Retorno recorrente acima da meta em ${retorno.diasAcimaMetaCount}/${retorno.totalDays} dias — padrão sistêmico; discutir ajuste de rota de encerramento de turno ou redistribuição das últimas OS do dia.`,
            );
          }
        }
      }

      // Phase 4: Deviation-based recommendations (existing logic)
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

  // ─── Team Scorecard ────────────────────────────────────────────────────────
  private buildTeamScorecard(rankingRows: CsvRow[], kpis: KpiInsight[]): TeamKpiScorecard[] {
    if (rankingRows.length === 0) return [];

    const rankAcc = createAccessor(rankingRows[0]);
    const teamCol  = rankAcc.resolve(['Equipe', 'Team', 'Equipe Nome']);
    const classCol = rankAcc.resolve(['Classificação', 'Classificacao']);
    const diasCol  = rankAcc.resolve(['Dias Trabalhados', 'DiasTrabalhados']);
    if (!teamCol) return [];

    // First occurrence per team: grab classificacao and diasTrabalhados
    const teamMeta = new Map<string, { classificacao?: number; diasTrabalhados?: number }>();
    for (const row of rankingRows) {
      const team = String(row[teamCol] ?? '').trim();
      if (!team || teamMeta.has(team)) continue;
      const cl = classCol ? parseNumber(String(row[classCol] ?? '')) : null;
      const dt = diasCol  ? parseNumber(String(row[diasCol]  ?? '')) : null;
      teamMeta.set(team, {
        classificacao:   (cl !== null && Number.isFinite(cl)) ? cl : undefined,
        diasTrabalhados: (dt !== null && Number.isFinite(dt)) ? dt : undefined,
      });
    }

    // kpi name → team → raw value (from KPI scores already computed)
    const kpiValueMap = new Map<string, Map<string, number>>();
    for (const insight of kpis) {
      const m = new Map<string, number>();
      for (const s of insight.scores) m.set(s.team, s.rawValue);
      kpiValueMap.set(insight.kpi, m);
    }

    const KPI_KEY_MAP: Array<{ key: keyof TeamKpiScorecard['kpis']; kpiName: string }> = [
      { key: 'osDia',         kpiName: 'OS Dia'       },
      { key: 'eficiencia',    kpiName: 'Eficiência'   },
      { key: 'utilizacao',    kpiName: 'Utilização'   },
      { key: 'tmeImp',        kpiName: 'TME IMP'      },
      { key: 'primeiroLogin', kpiName: '1º Login'     },
      { key: 'primeiroDesloc',kpiName: '1º Desloc.'   },
      { key: 'retornoBase',   kpiName: 'Retorno Base' },
    ];

    const allTeams = new Set<string>(teamMeta.keys());
    for (const insight of kpis) {
      for (const s of insight.scores) allTeams.add(s.team);
    }

    const result: TeamKpiScorecard[] = [];

    for (const team of allTeams) {
      const meta = teamMeta.get(team) ?? {};
      const kpiValues: TeamKpiScorecard['kpis']    = {};
      const kpiStatus: TeamKpiScorecard['kpiStatus'] = {};
      let score = 0;
      let kpisBelowMeta = 0;

      for (const { key, kpiName } of KPI_KEY_MAP) {
        const val = kpiValueMap.get(kpiName)?.get(team);
        if (val === undefined) continue;
        (kpiValues as Record<string, number>)[key] = val;
        const threshold = KPI_THRESHOLDS.find((t) => normalizeToken(t.kpi) === normalizeToken(kpiName));
        if (!threshold) continue;
        const isAbove = threshold.direction === 'higher-is-better' ? val >= threshold.meta : val <= threshold.meta;
        (kpiStatus as Record<string, string>)[key] = isAbove ? 'above' : 'below';
        if (isAbove) score++; else kpisBelowMeta++;
      }

      result.push({ team, ...meta, kpis: kpiValues, kpiStatus, score, kpisBelowMeta });
    }

    return result.sort((a, b) => {
      if (a.classificacao !== undefined && b.classificacao !== undefined) return a.classificacao - b.classificacao;
      if (a.classificacao !== undefined) return -1;
      if (b.classificacao !== undefined) return 1;
      return b.score - a.score;
    });
  }

  // ─── Executive Summary ─────────────────────────────────────────────────────
  private buildExecutiveSummary(
    kpis: KpiInsight[],
    scorecard: TeamKpiScorecard[],
    osDiaAnalysis: OsDiaTeamAnalysis[],
    utilizacaoAnalysis: UtilizacaoTeamAnalysis[],
    actionPlan: TeamActionPlan[],
    rankingRows: CsvRow[],
    tmeImpAnalysis: TmeImpTeamAnalysis[],
    retornoBaseAnalysis: RetornoBaseTeamAnalysis[],
  ): ExecutiveSummary {
    const totalTeams = scorecard.length;
    const teamsBelowMetaCount = scorecard.filter((s) => s.kpisBelowMeta >= 3).length;

    // Period days: max value of Dias Trabalhados across ranking rows
    let periodDays = 0;
    if (rankingRows.length > 0) {
      const acc = rankingRows.length > 0 ? createAccessor(rankingRows[0]) : null;
      const diasCol = acc?.resolve(['Dias Trabalhados', 'DiasTrabalhados']);
      if (diasCol) {
        for (const row of rankingRows) {
          const v = parseNumber(String(row[diasCol] ?? ''));
          if (v !== null && Number.isFinite(v) && v > periodDays) periodDays = v;
        }
      }
    }

    // KPI alerts: per-kpi count of teams below meta + worst
    const kpiAlerts: ExecutiveSummary['kpiAlerts'] = [];
    for (const insight of kpis) {
      const below = insight.scores.filter((s) =>
        insight.direction === 'higher-is-better'
          ? s.rawValue < insight.metaTarget
          : s.rawValue > insight.metaTarget,
      );
      if (below.length === 0) continue;
      const worst = insight.direction === 'higher-is-better'
        ? below.reduce((a, b) => a.rawValue < b.rawValue ? a : b)
        : below.reduce((a, b) => a.rawValue > b.rawValue ? a : b);
      kpiAlerts.push({
        kpi:            insight.kpi,
        teamsBelowMeta: below.length,
        worst:          { team: worst.team, value: round2(worst.rawValue) },
        meta:           insight.metaTarget,
      });
    }
    kpiAlerts.sort((a, b) => b.teamsBelowMeta - a.teamsBelowMeta);

    // Top action issues: count only Temp. Partida and Sem OS issues, per team (truly recurrent = ≥2 teams)
    const RECURRENT_PREFIXES = ['Temp. Partida elevado', 'SemOrdem\u226510min'];
    const issueCounts = new Map<string, number>();
    for (const plan of actionPlan) {
      const seenPrefixes = new Set<string>();
      for (const issue of plan.issues) {
        const prefix = RECURRENT_PREFIXES.find((p) => issue.startsWith(p));
        if (!prefix || seenPrefixes.has(prefix)) continue;
        seenPrefixes.add(prefix);
        issueCounts.set(prefix, (issueCounts.get(prefix) ?? 0) + 1);
      }
    }
    const topActionIssues = Array.from(issueCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([prefix, count]) => `${prefix}: ${count} equipes`);

    // Idle highlight
    const allWithIdle = ([...osDiaAnalysis, ...utilizacaoAnalysis] as Array<{ idleAnalysis?: { idlePct: number } }>)
      .filter((a) => a.idleAnalysis && a.idleAnalysis.idlePct >= 15);
    const idleHighlight = allWithIdle.length > 0
      ? `${allWithIdle.length} eq. ociosidade > 15% HD`
      : null;

    const retornoBaseAlertCount = retornoBaseAnalysis.filter((a) => a.retornoBaseValue > a.metaTarget).length;
    const tmeImpAlertCount = tmeImpAnalysis.filter((a) => a.tmeImpValue > a.metaTarget).length;

    return { periodDays, totalTeams, teamsBelowMetaCount, kpiAlerts, topActionIssues, idleHighlight, retornoBaseAlertCount, tmeImpAlertCount };
  }

  private analyzeOsDia(deslocRows: CsvRow[], rankingRows: CsvRow[], kpis: KpiInsight[]): OsDiaTeamAnalysis[] {
    if (deslocRows.length === 0 || rankingRows.length === 0) {
      return [];
    }

    const OS_DIA_META = 4.4;
    const OS_DIA_PCT_THRESHOLD = 0.20;
    const TEMP_PREP_THRESHOLD_MIN      = 10; // demais OS: Lib.Anterior → A Caminho
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
    const retornoBaseCol       = deslocAcc.resolve(['Retorno a base', 'Retorno a Base', 'Retorno Base']);
    const horasExtrasCol       = deslocAcc.resolve(['Horas Extras', 'Horas extras']);

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
    // Flag TL when it exceeds 25% above the global average (not % of HD)
    const TL_ABOVE_AVG_THRESHOLD = 1.25;

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
      const semOsValues: number[]    = [];
      const semOsIntervalApplied: boolean[] = [];
      let isInterACaminho = false;
      let isInterOrdem    = false;

      // First order: TempPrep from 1º Desloc, SemOS from 1º Despacho (raw spreadsheet value)
      tempPrepValues.push(firstDeslocCol   ? (parseNumber(String(firstRow[firstDeslocCol]   ?? '')) ?? Number.NaN) : Number.NaN);
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
        semOsIntervalApplied.push(semOs.intervalApplied);
      }

      // SemOrdem: gap between last order's Liberada and Log Off Corrigido, minus 60min interval and retorno base avg
      const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
      let semOsFimJornadaMin = Number.NaN;
      let semOsFimIntervalDiscounted = false;
      let semOsFimRetornoBaseDiscount = 0;
      let semOsFimRetornoBaseUsedRow = false;
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
            gapMin -= Math.min(intDuration, 60);           // discount up to 60 min
            if (intDuration > 60) gapMin += (intDuration - 60); // excess over 60 is penalized
            semOsFimIntervalDiscounted = true;
          }
          // Subtract Retorno a Base: use row value if present, otherwise fall back to average
          const retornoBaseRow = retornoBaseCol ? parseNumber(String(lastRow[retornoBaseCol] ?? '')) : null;
          const retornoBaseDiscount = (retornoBaseRow !== null && Number.isFinite(retornoBaseRow) && retornoBaseRow > 0)
            ? retornoBaseRow
            : retornoBaseAvg;
          if (retornoBaseDiscount > 0) {
            gapMin -= retornoBaseDiscount;
            semOsFimRetornoBaseDiscount = retornoBaseDiscount;
            semOsFimRetornoBaseUsedRow = retornoBaseRow !== null && Number.isFinite(retornoBaseRow) && retornoBaseRow > 0;
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
        if (globalAvgTlMin > 0 && tlOrdemMin > globalAvgTlMin * TL_ABOVE_AVG_THRESHOLD) {
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
            const prevDespStr = prevRow && despachadaCol ? String(prevRow[despachadaCol] ?? '').trim() || undefined : undefined;
            const prevDespDate = prevDespStr ? parseDateTimeBr(prevDespStr) : null;
            const prevLibStr  = prevRow && liberadaCol  ? String(prevRow[liberadaCol]  ?? '').trim() || undefined : undefined;
            const prevLibDate  = prevLibStr  ? parseDateTimeBr(prevLibStr)  : null;
            semOsDetails.push({
              type: 'entre_ordens',
              min:  round2(semOsMin),
              from: prevLibStr,
              to:   despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined,
              interval_discounted: semOsIntervalApplied[i] || undefined,
              desp_anterior: (prevDespDate && prevLibDate && prevDespDate.getTime() > prevLibDate.getTime()) ? prevDespStr : undefined,
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
          tempo_padrao_min:  tempoPadraoRaw !== null && Number.isFinite(tempoPadraoRaw) ? round2(tempoPadraoRaw) : undefined,
          temp_prep_os_min:  Number.isFinite(tempPrepOs) ? round2(tempPrepOs) : undefined,
          sem_os_details:    semOsDetails.length > 0 ? semOsDetails : undefined,
          sem_os_total_min:  semOsTotalMin,
          flags:             uniqueFlags,
        });
      }
      // Add fim de jornada to the last order's evidence
      const fimJornadaThreshold = retornoBaseAvg > 0 ? retornoBaseAvg * 0.15 : SEM_OS_THRESHOLD_MIN;
      if (Number.isFinite(semOsFimJornadaMin) && semOsFimJornadaMin >= fimJornadaThreshold) {
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
          retorno_base_discounted: semOsFimRetornoBaseDiscount > 0 ? round2(semOsFimRetornoBaseDiscount) : undefined,
          retorno_base_used_row:   semOsFimRetornoBaseUsedRow || undefined,
        };

        const existingEvidence = evidences.find((e) => e.nr_ordem === lastNrOrdem);
        const fimInicioIntervalo = semOsFimIntervalDiscounted && inicioIntervaloCol ? String(lastRow[inicioIntervaloCol] ?? '').trim() : '';
        const fimFimIntervalo    = semOsFimIntervalDiscounted && fimIntervaloCol    ? String(lastRow[fimIntervaloCol]    ?? '').trim() : '';
        if (existingEvidence) {
          const details = existingEvidence.sem_os_details ?? [];
          details.push(fimDetail);
          existingEvidence.sem_os_details = details;
          existingEvidence.sem_os_total_min = round2(details.reduce((s, d) => s + d.min, 0));
          if (!existingEvidence.flags.includes('sem_os_alto')) {
            existingEvidence.flags.push('sem_os_alto');
          }
          // Show interval chip if discounted from fim_jornada window
          if (semOsFimIntervalDiscounted && !existingEvidence.inicio_intervalo) {
            existingEvidence.inicio_intervalo = fimInicioIntervalo;
            existingEvidence.fim_intervalo    = fimFimIntervalo;
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
    const distinctDates = dateCol ? this.countDistinctDates(deslocRows, dateCol) : 0;
    const result: OsDiaTeamAnalysis[] = [];
    for (const [team, osDiaValue] of underPerforming.entries()) {
      // Skip if no deslocamento rows found for this team
      if (!Array.from(grouped.values()).some((g) => g.team === team)) {
        continue;
      }

      const flaggedOrders = this.mergeEvidenceFlags(teamEvidences.get(team) ?? []);
      const prioritizedFlaggedOrders = distinctDates > 7 ? this.selectTopOsDiaEvidences(flaggedOrders) : flaggedOrders;
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
  private mergeEvidenceFlags<T extends {
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

  private countDistinctDates(rows: CsvRow[], dateCol: string): number {
    const dates = new Set<string>();
    for (const row of rows) {
      const d = String(row[dateCol] ?? '').trim();
      if (d) dates.add(d);
    }
    return dates.size;
  }

  private selectTopUtilizacaoEvidences(
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

  private selectTopOsDiaEvidences(
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
        .sort((left, right) => this.scoreOsDiaEvidenceForFlag(right, flag) - this.scoreOsDiaEvidenceForFlag(left, flag))
        .slice(0, maxPerFlag);

      for (const evidence of topByFlag) {
        const key = `${evidence.nr_ordem}|${evidence.despachada}|${evidence.a_caminho}`;
        if (!selected.has(key)) {
          selected.set(key, evidence);
        }
      }
    }

    return Array.from(selected.values())
      .sort((left, right) => this.scoreOsDiaEvidence(right) - this.scoreOsDiaEvidence(left))
      .slice(0, maxPerFlag * flagPriority.length);
  }

  private scoreOsDiaEvidenceForFlag(
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

  private scoreOsDiaEvidence(evidence: OsDiaOrderEvidence): number {
    return (
      evidence.hd_pct_tr +
      evidence.hd_pct_tl +
      (evidence.temp_prep_os_min ?? 0) +
      (evidence.sem_os_total_min ?? 0)
    );
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
    const distinctDates = dateCol ? this.countDistinctDates(deslocRows, dateCol) : 0;
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
      const mergedFlaggedOrders = this.mergeEvidenceFlags(flaggedOrders);
      // Build a lookup map for O(1) key checks
      const flaggedOrdersMap = new Map(mergedFlaggedOrders.map((o) => [o.nr_ordem || `${o.despachada}|${o.a_caminho}`, o]));

      // Merge tempoPadraoVazioOrders into flaggedOrders:
      // - if OS already in flaggedOrders → add 'tempo_padrao_vazio' flag
      // - otherwise → append to flaggedOrders directly (all flags in one place)
      const tempoPadraoVazioDeduped = this.mergeEvidenceFlags(tempoPadraoVazioOrders);
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
        flaggedOrders: allFlagged,
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

  private analyzeUtilizacao(deslocRows: CsvRow[], kpis: KpiInsight[]): UtilizacaoTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const UTIL_META = 85;
    const IDLE_THRESHOLD_PCT = 15;
    const OS_DIA_PCT_THRESHOLD = 0.20;
    const TEMP_PREP_THRESHOLD_MIN = 10;
    const TEMP_PREP_THRESHOLD_FIRST_MIN = 25;
    const SEM_OS_THRESHOLD_MIN = 10;

    const utilizacaoKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Utilização'));
    if (!utilizacaoKpi) return [];

    const underPerforming = new Map<string, number>();
    for (const t of utilizacaoKpi.opportunityTeams) {
      underPerforming.set(t.team, t.value);
    }
    if (underPerforming.size === 0) return [];

    // Resolve columns (same as analyzeOsDia)
    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol             = deslocAcc.resolve(['Equipe']);
    const dateCol             = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const caminhoCol          = deslocAcc.resolve(['A_Caminho', 'A Caminho']);
    const despachadaCol       = deslocAcc.resolve(['Despachada']);
    const liberadaCol         = deslocAcc.resolve(['Liberada']);
    const firstDeslocCol      = deslocAcc.resolve(['1º Desloc', '1o Desloc']);
    const firstDespachoCol    = deslocAcc.resolve(['1º Despacho', '1o Despacho']);
    const intervaloCol        = deslocAcc.resolve(['Intervalo']);
    const inicioIntervaloCol  = deslocAcc.resolve(['Inicio Intervalo', 'Início Intervalo']);
    const fimIntervaloCol     = deslocAcc.resolve(['Fim Intervalo']);
    const nrOrdemCol          = deslocAcc.resolve(['Nr_Ordem', 'Nr Ordem', 'Numero Ordem']);
    const classeCol           = deslocAcc.resolve(['CLASSE', 'Classe']);
    const causaCol            = deslocAcc.resolve(['CAUSA', 'Causa']);
    const noLocalCol          = deslocAcc.resolve(['No_Local', 'No Local']);
    const trOrdemCol          = deslocAcc.resolve(['TR Ordem', 'TR_Ordem']);
    const tlOrdemCol          = deslocAcc.resolve(['TL Ordem', 'TL_Ordem']);
    const hdTotalCol          = deslocAcc.resolve(['HD Total', 'HD_Total']);
    const tempoPadraoCol      = deslocAcc.resolve(['tempo_padrao', 'Tempo Padrao', 'Tempo_Padrao', 'TempoPadrao']);
    const inicioCalendarioCol = deslocAcc.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
    const logInCorrigidoCol   = deslocAcc.resolve(['Log In Corrigido', 'LogIn Corrigido', 'Login Corrigido']);
    const logOffCorrigidoCol  = deslocAcc.resolve(['Log Off Corrigido', 'LogOff Corrigido']);
    const retornoBaseCol      = deslocAcc.resolve(['Retorno a base', 'Retorno a Base', 'Retorno Base']);
    const horasExtrasCol      = deslocAcc.resolve(['Horas Extras', 'Horas extras']);

    if (!teamCol || !dateCol || !caminhoCol || !despachadaCol || !liberadaCol) return [];

    // Baseline for sub-flag "Desl. Intervalo": global average without team-level filtering.
    const globalIntervaloDeslocValues: number[] = [];
    if (inicioIntervaloCol && fimIntervaloCol) {
      const allGrouped = new Map<string, CsvRow[]>();
      for (const row of deslocRows) {
        const team = String(row[teamCol] ?? '').trim();
        const date = String(row[dateCol] ?? '').trim();
        if (!team || !date) continue;
        const key = `${team}::${date}`;
        const rows = allGrouped.get(key) ?? [];
        rows.push(row);
        allGrouped.set(key, rows);
      }

      for (const rows of allGrouped.values()) {
        const orderedRows = [...rows].sort((a, b) => {
          const left = parseDateTimeBr(String(a[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const right = parseDateTimeBr(String(b[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return left - right;
        });

        for (let i = 1; i < orderedRows.length; i++) {
          const row = orderedRows[i];
          const prevRow = orderedRows[i - 1];
          const prevLiberadaDate = liberadaCol ? parseDateTimeBr(String(prevRow[liberadaCol] ?? '')) : null;
          const aCaminhoDate = parseDateTimeBr(String(row[caminhoCol] ?? ''));
          const inicioIntervaloRaw = String(row[inicioIntervaloCol] ?? '').trim();
          const fimIntervaloRaw = String(row[fimIntervaloCol] ?? '').trim();
          const inicioIntervaloDate = inicioIntervaloRaw ? parseDateTimeBr(inicioIntervaloRaw) : null;
          const fimIntervaloDate = fimIntervaloRaw ? parseDateTimeBr(fimIntervaloRaw) : null;

          const hasIntervaloDeslocamento = Boolean(
            prevLiberadaDate && aCaminhoDate &&
            inicioIntervaloDate && fimIntervaloDate &&
            inicioIntervaloDate.getTime() >= prevLiberadaDate.getTime() &&
            fimIntervaloDate.getTime() <= aCaminhoDate.getTime(),
          );
          if (!hasIntervaloDeslocamento || !inicioIntervaloDate || !prevLiberadaDate) continue;

          const intMin = minutesBetween(inicioIntervaloDate, prevLiberadaDate);
          if (Number.isFinite(intMin) && intMin > 0) {
            globalIntervaloDeslocValues.push(intMin);
          }
        }
      }
    }
    const globalAvgIntervaloDeslocMin = globalIntervaloDeslocValues.length > 0
      ? round2(globalIntervaloDeslocValues.reduce((sum, v) => sum + v, 0) / globalIntervaloDeslocValues.length)
      : 0;

    // Group by team+date, underperforming teams only
    const grouped = new Map<string, { team: string; date: string; rows: CsvRow[] }>();
    for (const row of deslocRows) {
      const team = String(row[teamCol] ?? '').trim();
      if (!underPerforming.has(team)) continue;
      const date = String(row[dateCol] ?? '').trim();
      if (!date) continue;
      const key = `${team}::${date}`;
      const entry = grouped.get(key) ?? { team, date, rows: [] };
      entry.rows.push(row);
      grouped.set(key, entry);
    }

    // Collect evidence per team (same pattern as analyzeOsDia)
    const teamEvidences = new Map<string, UtilizacaoOrderEvidence[]>();
    const teamHdTotals = new Map<string, { sum: number; count: number }>();
    const teamTotalOrders = new Map<string, number>();
    const teamTempPrepSum = new Map<string, number>();
    const teamSemOrdemSum = new Map<string, number>();
    const teamDayCount = new Map<string, number>();
    const teamDailyIdles = new Map<string, number[]>();
    const teamHorasExtrasSum = new Map<string, number>();
    // For jornada-level tracking (jornadasAbaixoMeta count)
    const teamJornadas = new Map<string, Array<{ htTotalMin: number; hdTotalMin: number }>>();

    for (const { team, date: _date, rows: groupRows } of grouped.values()) {
      teamDayCount.set(team, (teamDayCount.get(team) ?? 0) + 1);
      // Sort by A_Caminho ascending
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
      const semOsIntervalApplied: boolean[] = [];
      let isInterACaminho = false;
      let isInterOrdem    = false;

      tempPrepValues.push(firstDeslocCol   ? (parseNumber(String(firstRow[firstDeslocCol]   ?? '')) ?? Number.NaN) : Number.NaN);
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

        const tempPrep = this.calculateTempPrepValue({
          aCaminho, despachada, liberada,
          inicioIntervalo, fimIntervalo, intervaloMinutes,
          isIntervalAlreadyApplied: isInterACaminho,
        });
        if (tempPrep.intervalApplied) isInterACaminho = true;
        tempPrepValues.push(tempPrep.value);

        const semOs = this.calculateSemOsValue({
          despachada, liberada,
          inicioIntervalo: semOsIntervalStart,
          fimIntervalo:    semOsIntervalEnd,
          intervaloMinutes: firstIntervalMinutes,
          isIntervalAlreadyApplied: isInterOrdem,
        });
        if (semOs.intervalApplied) isInterOrdem = true;
        semOsValues.push(semOs.value);
        semOsIntervalApplied.push(semOs.intervalApplied);
      }

      // SemOrdem: gap between last Liberada and Log Off Corrigido
      const retornoBaseAvg = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'))?.average ?? 0;
      let semOsFimJornadaMin = Number.NaN;
      let semOsFimIntervalDiscounted = false;
      let semOsFimRetornoBaseDiscount = 0;
      let semOsFimRetornoBaseUsedRow = false;
      if (logOffCorrigidoCol && liberadaCol) {
        const lastRow = ordered[ordered.length - 1];
        const lastLiberada = parseDateTimeBr(String(lastRow[liberadaCol] ?? ''));
        const logOff = parseDateTimeBr(String(lastRow[logOffCorrigidoCol] ?? ''));
        if (lastLiberada && logOff && logOff.getTime() > lastLiberada.getTime()) {
          let gapMin = minutesBetween(logOff, lastLiberada);
          const intStart = inicioIntervaloCol ? parseDateTimeBr(String(lastRow[inicioIntervaloCol] ?? '')) : null;
          const intEnd   = fimIntervaloCol    ? parseDateTimeBr(String(lastRow[fimIntervaloCol]    ?? '')) : null;
          if (!isInterOrdem && intStart && intEnd &&
              intStart.getTime() >= lastLiberada.getTime() &&
              intEnd.getTime() <= logOff.getTime()) {
            const intDuration = minutesBetween(intEnd, intStart);
            gapMin -= Math.min(intDuration, 60);           // discount up to 60 min
            if (intDuration > 60) gapMin += (intDuration - 60); // excess over 60 is penalized
            semOsFimIntervalDiscounted = true;
          }
          // Subtract Retorno a Base: use row value if present, otherwise fall back to average
          const retornoBaseRow = retornoBaseCol ? parseNumber(String(lastRow[retornoBaseCol] ?? '')) : null;
          const retornoBaseDiscount = (retornoBaseRow !== null && Number.isFinite(retornoBaseRow) && retornoBaseRow > 0)
            ? retornoBaseRow
            : retornoBaseAvg;
          if (retornoBaseDiscount > 0) {
            gapMin -= retornoBaseDiscount;
            semOsFimRetornoBaseDiscount = retornoBaseDiscount;
            semOsFimRetornoBaseUsedRow = retornoBaseRow !== null && Number.isFinite(retornoBaseRow) && retornoBaseRow > 0;
          }
          if (gapMin > 0) {
            semOsFimJornadaMin = gapMin;
            semOsValues.push(gapMin);
          }
        }
      }

      // Jornada-level HT/HD for jornadasAbaixoMeta count
      let htJornada = 0;
      for (const row of ordered) {
        const trMin = trOrdemCol ? (parseNumber(String(row[trOrdemCol] ?? '')) ?? 0) : 0;
        const tlMin = tlOrdemCol ? (parseNumber(String(row[tlOrdemCol] ?? '')) ?? 0) : 0;
        htJornada += trMin + tlMin;
      }
      let hdJornada = 0;
      if (logInCorrigidoCol && logOffCorrigidoCol) {
        let logInStr = '';
        let logOffStr = '';
        for (const row of ordered) {
          const c = String(row[logInCorrigidoCol] ?? '').trim();
          if (c) { logInStr = c; break; }
        }
        for (const row of ordered) {
          const c = String(row[logOffCorrigidoCol] ?? '').trim();
          if (c) { logOffStr = c; break; }
        }
        const logInDate  = parseDateTimeBr(logInStr);
        const logOffDate = parseDateTimeBr(logOffStr);
        if (logInDate && logOffDate && logOffDate.getTime() > logInDate.getTime()) {
          hdJornada = minutesBetween(logOffDate, logInDate);
        }
      }
      const jornadasList = teamJornadas.get(team) ?? [];
      jornadasList.push({ htTotalMin: round2(htJornada), hdTotalMin: round2(hdJornada) });
      teamJornadas.set(team, jornadasList);

      // Accumulate HD Total from column
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

      // Accumulate TempPrep and SemOrdem
      for (const v of tempPrepValues) {
        if (Number.isFinite(v) && v > 0) teamTempPrepSum.set(team, (teamTempPrepSum.get(team) ?? 0) + v);
      }
      for (const v of semOsValues) {
        if (Number.isFinite(v) && v > 0) teamSemOrdemSum.set(team, (teamSemOrdemSum.get(team) ?? 0) + v);
      }
      const dayIdleTotal =
        tempPrepValues.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0) +
        semOsValues.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0);
      if (dayIdleTotal > 0) {
        const arr = teamDailyIdles.get(team) ?? [];
        arr.push(dayIdleTotal);
        teamDailyIdles.set(team, arr);
      }

      teamTotalOrders.set(team, (teamTotalOrders.get(team) ?? 0) + ordered.length);

      // Accumulate Horas Extras (per-jornada value — same for all OS in the group)
      if (horasExtrasCol) {
        const heVal = parseNumber(String(firstRow[horasExtrasCol] ?? ''));
        if (heVal !== null && Number.isFinite(heVal) && heVal > 0) {
          teamHorasExtrasSum.set(team, (teamHorasExtrasSum.get(team) ?? 0) + heVal);
        }
      }

      // Build per-order evidence (exact same logic as analyzeOsDia)
      const evidences = teamEvidences.get(team) ?? [];
      for (let i = 0; i < ordered.length; i++) {
        const row     = ordered[i];
        const prevRow = i > 0 ? ordered[i - 1] : null;

        const trOrdemMin    = trOrdemCol     ? (parseNumber(String(row[trOrdemCol]     ?? '')) ?? 0) : 0;
        const tlOrdemMin    = tlOrdemCol     ? (parseNumber(String(row[tlOrdemCol]     ?? '')) ?? 0) : 0;
        const hdTotalMin    = hdTotalCol     ? (parseNumber(String(row[hdTotalCol]     ?? '')) ?? 0) : 0;
        const tempoPadraoRaw = tempoPadraoCol ? parseNumber(String(row[tempoPadraoCol] ?? '')) : null;
        const tempPrepOs = tempPrepValues[i] ?? Number.NaN;
        const semOsMin   = semOsValues[i]    ?? Number.NaN;

        const hdPctTr = hdTotalMin > 0 ? round2((trOrdemMin / hdTotalMin) * 100) : 0;
        const hdPctTl = hdTotalMin > 0 ? round2((tlOrdemMin / hdTotalMin) * 100) : 0;

        const flags: UtilizacaoOrderEvidence['flags'] = [];
        const tempPrepThreshold = (i === 0) ? TEMP_PREP_THRESHOLD_FIRST_MIN : TEMP_PREP_THRESHOLD_MIN;
        if (Number.isFinite(tempPrepOs) && tempPrepOs >= tempPrepThreshold) flags.push('temp_prep_alto');
        if (Number.isFinite(semOsMin) && semOsMin >= SEM_OS_THRESHOLD_MIN) flags.push('sem_os_alto');

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
        const intervaloDeslocMin = hasIntervaloDeslocamento && inicioIntervaloDate && prevLiberadaDate
          ? round2(minutesBetween(inicioIntervaloDate, prevLiberadaDate))
          : null;
        const intervaloDeslocAboveGlobalAvg = Boolean(
          intervaloDeslocMin !== null &&
          Number.isFinite(intervaloDeslocMin) &&
          globalAvgIntervaloDeslocMin > 0 &&
          intervaloDeslocMin > globalAvgIntervaloDeslocMin,
        );
        if (intervaloDeslocAboveGlobalAvg) flags.push('sem_os_alto');

        const uniqueFlags = [...new Set(flags)] as UtilizacaoOrderEvidence['flags'];
        if (uniqueFlags.length === 0) continue;

        const intervaloNaJanela = Boolean(
          inicioIntervaloDate &&
          liberadaAtualDate &&
          inicioIntervaloDate.getTime() <= liberadaAtualDate.getTime() &&
          (prevLiberadaDate === null || inicioIntervaloDate.getTime() >= prevLiberadaDate.getTime()),
        );

        const semOsDetails: NonNullable<UtilizacaoOrderEvidence['sem_os_details']> = [];
        if (Number.isFinite(semOsMin) && semOsMin >= SEM_OS_THRESHOLD_MIN) {
          if (i === 0) {
            semOsDetails.push({
              type: 'inicio_jornada',
              min:  round2(semOsMin),
              from: inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
              to:   despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined,
            });
          } else {
            const prevDespStr = prevRow && despachadaCol ? String(prevRow[despachadaCol] ?? '').trim() || undefined : undefined;
            const prevDespDate = prevDespStr ? parseDateTimeBr(prevDespStr) : null;
            const prevLibStr  = prevRow && liberadaCol  ? String(prevRow[liberadaCol]  ?? '').trim() || undefined : undefined;
            const prevLibDate  = prevLibStr  ? parseDateTimeBr(prevLibStr)  : null;
            semOsDetails.push({
              type: 'entre_ordens',
              min:  round2(semOsMin),
              from: prevLibStr,
              to:   despachadaCol ? String(row[despachadaCol] ?? '').trim() || undefined : undefined,
              interval_discounted: semOsIntervalApplied[i] || undefined,
              desp_anterior: (prevDespDate && prevLibDate && prevDespDate.getTime() > prevLibDate.getTime()) ? prevDespStr : undefined,
            });
          }
        }
        if (intervaloDeslocAboveGlobalAvg && intervaloDeslocMin !== null) {
          const overPct = globalAvgIntervaloDeslocMin > 0
            ? round2(((intervaloDeslocMin - globalAvgIntervaloDeslocMin) / globalAvgIntervaloDeslocMin) * 100)
            : undefined;
          semOsDetails.push({
            type: 'intervalo_deslocamento',
            min:  intervaloDeslocMin,
            from: prevRow && liberadaCol ? String(prevRow[liberadaCol] ?? '').trim() || undefined : undefined,
            to:   inicioIntervaloRaw || undefined,
            global_avg_min: globalAvgIntervaloDeslocMin > 0 ? round2(globalAvgIntervaloDeslocMin) : undefined,
            above_avg_pct: overPct,
          });
        }

        const semOsTotalMin = semOsDetails.length > 0 ? round2(semOsDetails.reduce((s, d) => s + d.min, 0)) : undefined;

        evidences.push({
          date_ref:          dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
          nr_ordem:          nrOrdemCol ? String(row[nrOrdemCol] ?? '').trim()         : '',
          classe:            classeCol  ? String(row[classeCol]  ?? '').trim()         : '',
          causa:             causaCol   ? String(row[causaCol]   ?? '').trim()         : '',
          despachada:        despachadaCol       ? String(row[despachadaCol]       ?? '').trim() : '',
          a_caminho:                       String(row[caminhoCol]                     ?? '').trim(),
          no_local:          noLocalCol  ? String(row[noLocalCol]  ?? '').trim()    : '',
          liberada:          liberadaCol ? String(row[liberadaCol] ?? '').trim()    : '',
          inicio_intervalo:  intervaloNaJanela ? inicioIntervaloRaw : '',
          fim_intervalo:     intervaloNaJanela ? fimIntervaloRaw    : '',
          prev_liberada:     prevRow && liberadaCol    ? String(prevRow[liberadaCol]    ?? '').trim() : undefined,
          prev_nr_ordem:     prevRow && nrOrdemCol     ? String(prevRow[nrOrdemCol]     ?? '').trim() : undefined,
          prev_despachada:   prevRow && despachadaCol  ? String(prevRow[despachadaCol]  ?? '').trim() : undefined,
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
      const fimJornadaThreshold = retornoBaseAvg > 0 ? retornoBaseAvg * 0.15 : SEM_OS_THRESHOLD_MIN;
      if (Number.isFinite(semOsFimJornadaMin) && semOsFimJornadaMin >= fimJornadaThreshold) {
        const lastRow = ordered[ordered.length - 1];
        const lastNrOrdem = nrOrdemCol ? String(lastRow[nrOrdemCol] ?? '').trim() : '';
        const logOffStr  = logOffCorrigidoCol ? String(lastRow[logOffCorrigidoCol] ?? '').trim() : undefined;
        const liberadaStr = liberadaCol ? String(lastRow[liberadaCol] ?? '').trim() : undefined;
        const fimDetail: NonNullable<UtilizacaoOrderEvidence['sem_os_details']>[number] = {
          type: 'fim_jornada',
          min:  round2(semOsFimJornadaMin),
          from: liberadaStr || undefined,
          to:   logOffStr || undefined,
          interval_discounted: semOsFimIntervalDiscounted || undefined,
          retorno_base_discounted: semOsFimRetornoBaseDiscount > 0 ? round2(semOsFimRetornoBaseDiscount) : undefined,
          retorno_base_used_row:   semOsFimRetornoBaseUsedRow || undefined,
        };

        const existingEvidence = evidences.find((e) => e.nr_ordem === lastNrOrdem);
        const fimInicioIntervalo = semOsFimIntervalDiscounted && inicioIntervaloCol ? String(lastRow[inicioIntervaloCol] ?? '').trim() : '';
        const fimFimIntervalo    = semOsFimIntervalDiscounted && fimIntervaloCol    ? String(lastRow[fimIntervaloCol]    ?? '').trim() : '';
        if (existingEvidence) {
          const details = existingEvidence.sem_os_details ?? [];
          details.push(fimDetail);
          existingEvidence.sem_os_details = details;
          existingEvidence.sem_os_total_min = round2(details.reduce((s, d) => s + d.min, 0));
          if (!existingEvidence.flags.includes('sem_os_alto')) existingEvidence.flags.push('sem_os_alto');
          // Show interval chip if discounted from fim_jornada window
          if (semOsFimIntervalDiscounted && !existingEvidence.inicio_intervalo) {
            existingEvidence.inicio_intervalo = fimInicioIntervalo;
            existingEvidence.fim_intervalo    = fimFimIntervalo;
          }
        } else {
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
            date_ref:          dateCol ? String(row[dateCol] ?? '').trim() || undefined : undefined,
            nr_ordem:          lastNrOrdem,
            classe:            classeCol ? String(row[classeCol] ?? '').trim() : '',
            causa:             causaCol  ? String(row[causaCol]  ?? '').trim() : '',
            despachada:        despachadaCol ? String(row[despachadaCol] ?? '').trim() : '',
            a_caminho:         String(row[caminhoCol] ?? '').trim(),
            no_local:          noLocalCol ? String(row[noLocalCol] ?? '').trim() : '',
            liberada:          liberadaCol  ? String(row[liberadaCol]  ?? '').trim() : '',
            inicio_intervalo:  fimInicioIntervalo,
            fim_intervalo:     fimFimIntervalo,
            prev_liberada:     prevRow && liberadaCol    ? String(prevRow[liberadaCol]    ?? '').trim() : undefined,
            prev_nr_ordem:     prevRow && nrOrdemCol     ? String(prevRow[nrOrdemCol]     ?? '').trim() : undefined,
            prev_despachada:   prevRow && despachadaCol  ? String(prevRow[despachadaCol]  ?? '').trim() : undefined,
            inicio_calendario: inicioCalendarioCol ? String(row[inicioCalendarioCol] ?? '').trim() || undefined : undefined,
            log_in:            logInCorrigidoCol   ? String(row[logInCorrigidoCol]   ?? '').trim() || undefined : undefined,
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

    // Build result
    const distinctDates = dateCol ? this.countDistinctDates(deslocRows, dateCol) : 0;
    const result: UtilizacaoTeamAnalysis[] = [];
    for (const [team, utilizacaoValue] of underPerforming.entries()) {
      if (!Array.from(grouped.values()).some((g) => g.team === team)) continue;

      const flaggedOrders = this.mergeEvidenceFlags(teamEvidences.get(team) ?? []);
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
      const idleAnalysis: UtilizacaoTeamAnalysis['idleAnalysis'] =
        avgHdTotal > 0 && idlePct >= IDLE_THRESHOLD_PCT
          ? { idleMin, idlePct, horasExtras: round2((teamHorasExtrasSum.get(team) ?? 0) / dayCount) }
          : undefined;

      const allJornadas = teamJornadas.get(team) ?? [];
      const jornadasAbaixoMeta = allJornadas.filter(
        (j) => j.hdTotalMin > 0 && (j.htTotalMin / j.hdTotalMin) * 100 < UTIL_META,
      ).length;

      result.push({
        team,
        utilizacaoValue:  round2(utilizacaoValue),
        metaTarget:       UTIL_META,
        gap:              round2(UTIL_META - utilizacaoValue),
        hdTotalMin:       avgHdTotal,
        tempPrepTotalMin: tempPrepTotal,
        semOrdemTotalMin: semOrdemTotal,
        totalOrders,
        totalJornadas:    allJornadas.length,
        idleDays,
        idleAvgMin,
        jornadasAbaixoMeta,
        flaggedOrders: distinctDates > 7 ? this.selectTopUtilizacaoEvidences(flaggedOrders) : flaggedOrders,
        summary: {
          countTempPrepAlto: flaggedOrders.filter((e) => e.flags.includes('temp_prep_alto')).length,
          countSemOsAlto:    flaggedOrders.filter((e) => e.flags.includes('sem_os_alto')).length,
        },
        idleAnalysis,
      });
    }

    return result.sort((a, b) => {
      if (a.utilizacaoValue !== b.utilizacaoValue) return a.utilizacaoValue - b.utilizacaoValue;
      const aAlerts = a.summary.countTempPrepAlto + a.summary.countSemOsAlto;
      const bAlerts = b.summary.countTempPrepAlto + b.summary.countSemOsAlto;
      return bAlerts - aAlerts;
    }).slice(0, 3);
  }

  // ─── TME IMP Analyzer ─────────────────────────────────────────────────────
  private analyzeTmeImp(deslocRows: CsvRow[], rankingRows: CsvRow[], kpis: KpiInsight[]): TmeImpTeamAnalysis[] {
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

    const distinctDates = dateCol ? this.countDistinctDates(deslocRows, dateCol) : 0;

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

        if (flags.length === 0) continue;

        const nrOrdem = nrOrdemCol ? String(row[nrOrdemCol] ?? '').trim() : '';
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

      result.push({
        team,
        tmeImpValue,
        metaTarget: TME_IMP_META,
        gap: round2(tmeImpValue - TME_IMP_META),
        avgTmeImpMin: round2(teamAvgTme),
        globalAvgTmeImpMin: round2(globalAvgTme),
        totalOrders: teamRows.length,
        flaggedOrders: distinctDates > 7 ? flaggedOrders.slice(0, 10) : flaggedOrders,
        summary: { countTmeMuitoAlto, countSemDeslocamento, countSemExecucao },
      });
    }

    return result.sort((a, b) => b.tmeImpValue - a.tmeImpValue);
  }

  // ─── 1º Login Analyzer ────────────────────────────────────────────────────
  private analyzePrimeiroLogin(deslocRows: CsvRow[], kpis: KpiInsight[]): PrimeiroLoginTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const LOGIN_META = 8;

    const loginKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('1º Login'));
    if (!loginKpi) return [];

    const teamsToAnalyze = new Map<string, { value: number }>();
    for (const t of loginKpi.opportunityTeams) teamsToAnalyze.set(t.team, { value: t.value });
    if (teamsToAnalyze.size === 0) return [];

    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol            = deslocAcc.resolve(['Equipe']);
    const dateCol            = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const inicioCalCol       = deslocAcc.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
    const logInCorrigidoCol  = deslocAcc.resolve(['Log In Corrigido', 'LogIn Corrigido', 'Login Corrigido']);
    const primeiroLoginCorCol = deslocAcc.resolve(['1º Login Corrigido', '1o Login Corrigido']);
    const primeiroLoginCol   = deslocAcc.resolve(['1º Login', '1o Login']);

    if (!teamCol) return [];

    const distinctDates = dateCol ? this.countDistinctDates(deslocRows, dateCol) : 0;

    // Global: collect distinct jornada (team+date) first login values
    const globalLoginValues: number[] = [];
    const seenGlobal = new Set<string>();
    for (const row of deslocRows) {
      const team = teamCol ? String(row[teamCol] ?? '').trim() : '';
      const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
      const key = `${team}|${date}`;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      const loginMin = primeiroLoginCorCol
        ? parseNumber(String(row[primeiroLoginCorCol] ?? ''))
        : primeiroLoginCol ? parseNumber(String(row[primeiroLoginCol] ?? '')) : null;
      if (loginMin !== null && Number.isFinite(loginMin) && loginMin >= 0) globalLoginValues.push(loginMin);
    }
    const globalAvgLogin = globalLoginValues.length > 0
      ? globalLoginValues.reduce((s, x) => s + x, 0) / globalLoginValues.length : 0;

    const result: PrimeiroLoginTeamAnalysis[] = [];

    for (const [team, { value: loginValue }] of teamsToAnalyze.entries()) {
      const teamNorm = normalizeToken(team);
      let teamRows = deslocRows.filter((r) => String(r[teamCol] ?? '').trim() === team);
      if (teamRows.length === 0) {
        teamRows = deslocRows.filter((r) => normalizeToken(String(r[teamCol] ?? '').trim()) === teamNorm);
      }
      if (teamRows.length === 0) continue;

      // Deduplicate by date (one row per day for jornada-level metrics)
      const seenDates = new Set<string>();
      const jornadaRows: CsvRow[] = [];
      for (const row of teamRows) {
        const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
        if (!seenDates.has(date)) { seenDates.add(date); jornadaRows.push(row); }
      }

      const teamLoginValues: number[] = [];
      for (const row of jornadaRows) {
        const v = primeiroLoginCorCol
          ? parseNumber(String(row[primeiroLoginCorCol] ?? ''))
          : primeiroLoginCol ? parseNumber(String(row[primeiroLoginCol] ?? '')) : null;
        if (v !== null && Number.isFinite(v) && v >= 0) teamLoginValues.push(v);
      }
      const teamAvgLogin = teamLoginValues.length > 0
        ? teamLoginValues.reduce((s, x) => s + x, 0) / teamLoginValues.length : 0;

      const diasAcimaMetaCount = teamLoginValues.filter((v) => v > LOGIN_META).length;

      const flaggedDays: PrimeiroLoginDayEvidence[] = [];
      let countLoginTardio = 0;
      let countLoginMuitoTardio = 0;

      for (const row of jornadaRows) {
        const loginMin = primeiroLoginCorCol
          ? parseNumber(String(row[primeiroLoginCorCol] ?? ''))
          : primeiroLoginCol ? parseNumber(String(row[primeiroLoginCol] ?? '')) : null;
        if (loginMin === null || !Number.isFinite(loginMin)) continue;

        const flags: PrimeiroLoginDayEvidence['flags'] = [];
        // login_muito_tardio: > meta * 2 (acima de 16 min)
        // login_tardio: > meta (acima de 8 min)
        if (loginMin > LOGIN_META * 2) { flags.push('login_muito_tardio'); countLoginMuitoTardio++; }
        else if (loginMin > LOGIN_META) { flags.push('login_tardio'); countLoginTardio++; }

        if (flags.length === 0) continue;

        flaggedDays.push({
          date_ref: dateCol ? String(row[dateCol] ?? '').trim() : '',
          inicio_calendario: inicioCalCol ? String(row[inicioCalCol] ?? '').trim() : '',
          log_in_corrigido:  logInCorrigidoCol ? String(row[logInCorrigidoCol] ?? '').trim() : '',
          primeiro_login_min: round2(loginMin),
          team_avg_login_min: round2(teamAvgLogin),
          global_avg_login_min: round2(globalAvgLogin),
          flags,
        });
      }

      flaggedDays.sort((a, b) => b.primeiro_login_min - a.primeiro_login_min);

      result.push({
        team,
        primeiroLoginValue: loginValue,
        metaTarget: LOGIN_META,
        gap: round2(loginValue - LOGIN_META),
        avgLoginMin: round2(teamAvgLogin),
        globalAvgLoginMin: round2(globalAvgLogin),
        totalDays: jornadaRows.length,
        diasAcimaMetaCount,
        flaggedDays: distinctDates > 7 ? flaggedDays.slice(0, 10) : flaggedDays,
        summary: { countLoginTardio, countLoginMuitoTardio },
      });
    }

    return result.sort((a, b) => b.primeiroLoginValue - a.primeiroLoginValue);
  }

  // ─── 1º Desloc. Analyzer ──────────────────────────────────────────────────
  private analyzePrimeiroDesloc(deslocRows: CsvRow[], kpis: KpiInsight[]): PrimeiroDeslocTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const DESLOC_META = 25;

    const deslocKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('1º Desloc.'));
    if (!deslocKpi) return [];

    const teamsToAnalyze = new Map<string, { value: number }>();
    for (const t of deslocKpi.opportunityTeams) teamsToAnalyze.set(t.team, { value: t.value });
    if (teamsToAnalyze.size === 0) return [];

    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol             = deslocAcc.resolve(['Equipe']);
    const dateCol             = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const primeiroDeslocCol   = deslocAcc.resolve(['1º Desloc', '1o Desloc']);
    const horaPrimDeslocCol   = deslocAcc.resolve(['Hora 1º Deslocamento', 'Hora 1o Deslocamento']);
    const horaPrimDespachoCol = deslocAcc.resolve(['Hora 1º Despacho', 'Hora 1o Despacho']);
    const inicioCalCol        = deslocAcc.resolve(['Inicio Calendario', 'Início Calendário', 'Inicio Calendário', 'Início Calendario']);
    const logInCorrigidoCol   = deslocAcc.resolve(['Log In Corrigido', 'LogIn Corrigido', 'Login Corrigido']);
    const nrOrdemCol          = deslocAcc.resolve(['Nr_Ordem', 'Nr Ordem', 'Numero Ordem']);

    if (!teamCol) return [];

    const distinctDates = dateCol ? this.countDistinctDates(deslocRows, dateCol) : 0;

    // Threshold: first dispatch is considered "tardio" if > 10 min after inicio_calendario
    const DESPACHO_TARDIO_MIN = 10;

    // Global average
    const globalDeslocValues: number[] = [];
    const seenGlobal = new Set<string>();
    for (const row of deslocRows) {
      const team = teamCol ? String(row[teamCol] ?? '').trim() : '';
      const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
      const key = `${team}|${date}`;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      const v = primeiroDeslocCol ? parseNumber(String(row[primeiroDeslocCol] ?? '')) : null;
      if (v !== null && Number.isFinite(v) && v >= 0) globalDeslocValues.push(v);
    }
    const globalAvgDesloc = globalDeslocValues.length > 0
      ? globalDeslocValues.reduce((s, x) => s + x, 0) / globalDeslocValues.length : 0;

    const result: PrimeiroDeslocTeamAnalysis[] = [];

    for (const [team, { value: deslocValue }] of teamsToAnalyze.entries()) {
      const teamNorm = normalizeToken(team);
      let teamRows = deslocRows.filter((r) => String(r[teamCol] ?? '').trim() === team);
      if (teamRows.length === 0) {
        teamRows = deslocRows.filter((r) => normalizeToken(String(r[teamCol] ?? '').trim()) === teamNorm);
      }
      if (teamRows.length === 0) continue;

      // Deduplicate by date
      const seenDates = new Set<string>();
      const jornadaRows: CsvRow[] = [];
      for (const row of teamRows) {
        const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
        if (!seenDates.has(date)) { seenDates.add(date); jornadaRows.push(row); }
      }

      const teamDeslocValues: number[] = [];
      for (const row of jornadaRows) {
        const v = primeiroDeslocCol ? parseNumber(String(row[primeiroDeslocCol] ?? '')) : null;
        if (v !== null && Number.isFinite(v) && v >= 0) teamDeslocValues.push(v);
      }
      const teamAvgDesloc = teamDeslocValues.length > 0
        ? teamDeslocValues.reduce((s, x) => s + x, 0) / teamDeslocValues.length : 0;

      const diasAcimaMetaCount = teamDeslocValues.filter((v) => v > DESLOC_META).length;

      const flaggedDays: PrimeiroDeslocDayEvidence[] = [];
      let countDeslocLento = 0;
      let countDeslocMuitoLento = 0;
      let countSemDeslocRegistrado = 0;
      let countDespachioTardio = 0;

      for (const row of jornadaRows) {
        const deslocMin    = primeiroDeslocCol   ? parseNumber(String(row[primeiroDeslocCol] ?? '')) : null;
        const horaDesloc   = horaPrimDeslocCol   ? String(row[horaPrimDeslocCol] ?? '').trim() : '';
        const horaDespacho = horaPrimDespachoCol ? String(row[horaPrimDespachoCol] ?? '').trim() : '';
        const inicioCal    = inicioCalCol        ? String(row[inicioCalCol] ?? '').trim() : '';
        const logInCor     = logInCorrigidoCol   ? String(row[logInCorrigidoCol] ?? '').trim() : '';
        const dateRef      = dateCol ? String(row[dateCol] ?? '').trim() : '';

        // Compute despacho_apos_inicio_min: time from inicio_calendario to first dispatch
        // Also compute login_atraso_min: delay between inicio_calendario and actual login
        let despachoAposInicioMin = 0;
        let loginAtrasoMin = 0;
        const makeDate = (t: string) => {
          if (t.includes('/')) return parseDateTimeBr(t);
          const base = dateRef ? `${dateRef} ${t}` : `01/01/2000 ${t}`;
          return parseDateTimeBr(base);
        };
        if (inicioCal && horaDespacho) {
          const inicioDate  = makeDate(inicioCal);
          const dispDate    = makeDate(horaDespacho);
          if (inicioDate && dispDate) {
            const diff = minutesBetween(dispDate, inicioDate);
            if (Number.isFinite(diff) && diff >= 0) despachoAposInicioMin = round2(diff);
          }
        }
        if (inicioCal && logInCor) {
          const inicioDate = makeDate(inicioCal);
          const loginDate  = makeDate(logInCor);
          if (inicioDate && loginDate) {
            const diff = minutesBetween(loginDate, inicioDate);
            if (Number.isFinite(diff) && diff > 0) loginAtrasoMin = round2(diff);
          }
        }

        const flags: PrimeiroDeslocDayEvidence['flags'] = [];

        if (deslocMin === null || !Number.isFinite(deslocMin) || deslocMin < 0) {
          if (horaDespacho && !horaDesloc) {
            flags.push('sem_desloc_registrado');
            countSemDeslocRegistrado++;
          }
        } else {
          // desloc_muito_lento: > meta * 1.5 (> 37.5 min)
          // desloc_lento: > meta (> 25 min)
          if (deslocMin > DESLOC_META * 1.5) { flags.push('desloc_muito_lento'); countDeslocMuitoLento++; }
          else if (deslocMin > DESLOC_META)  { flags.push('desloc_lento');        countDeslocLento++; }
        }

        // despacho_tardio: first dispatch > DESPACHO_TARDIO_MIN after inicio_calendario
        // Only flagged as supplemental — requires a primary desloc flag to be present
        if (despachoAposInicioMin > DESPACHO_TARDIO_MIN && flags.length > 0) {
          flags.push('despacho_tardio');
          countDespachioTardio++;
        }

        if (flags.length === 0) continue;

        flaggedDays.push({
          date_ref:                   dateRef,
          nr_ordem:                   nrOrdemCol ? String(row[nrOrdemCol] ?? '').trim() : '',
          hora_primeiro_despacho:     horaDespacho,
          hora_primeiro_deslocamento: horaDesloc,
          inicio_calendario:          inicioCal,
          log_in_corrigido:           logInCor,
          primeiro_desloc_min:        deslocMin !== null && Number.isFinite(deslocMin) ? round2(deslocMin) : 0,
          despacho_apos_inicio_min:   despachoAposInicioMin,
          login_atraso_min:           loginAtrasoMin,
          team_avg_desloc_min:        round2(teamAvgDesloc),
          global_avg_desloc_min:      round2(globalAvgDesloc),
          is_primeira_os_jornada:     true,
          flags,
        });
      }

      flaggedDays.sort((a, b) => b.primeiro_desloc_min - a.primeiro_desloc_min);

      result.push({
        team,
        primeiroDeslocValue: deslocValue,
        metaTarget: DESLOC_META,
        gap: round2(deslocValue - DESLOC_META),
        avgDeslocMin: round2(teamAvgDesloc),
        globalAvgDeslocMin: round2(globalAvgDesloc),
        totalDays: jornadaRows.length,
        diasAcimaMetaCount,
        flaggedDays: distinctDates > 7 ? flaggedDays.slice(0, 10) : flaggedDays,
        summary: { countDeslocLento, countDeslocMuitoLento, countSemDeslocRegistrado, countDespachioTardio },
      });
    }

    return result.sort((a, b) => b.primeiroDeslocValue - a.primeiroDeslocValue);
  }

  // ─── Retorno Base Analyzer ────────────────────────────────────────────────
  private analyzeRetornoBase(deslocRows: CsvRow[], kpis: KpiInsight[]): RetornoBaseTeamAnalysis[] {
    if (deslocRows.length === 0) return [];

    const RETORNO_META = 40;

    const retornoKpi = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Retorno Base'));
    if (!retornoKpi) return [];

    const teamsToAnalyze = new Map<string, { value: number }>();
    for (const t of retornoKpi.opportunityTeams) teamsToAnalyze.set(t.team, { value: t.value });
    if (teamsToAnalyze.size === 0) return [];

    const deslocAcc = createAccessor(deslocRows[0]);
    const teamCol          = deslocAcc.resolve(['Equipe']);
    const dateCol          = deslocAcc.resolve(['Data Referência', 'Data Referencia']);
    const retornoBaseCol   = deslocAcc.resolve(['Retorno a base', 'Retorno a Base', 'Retorno Base']);
    const horaUltimaCol    = deslocAcc.resolve(['Hora Ultima Ordem', 'Hora Última Ordem']);
    const logOffCorCol     = deslocAcc.resolve(['Log Off Corrigido', 'LogOff Corrigido']);

    if (!teamCol) return [];

    const distinctDates = dateCol ? this.countDistinctDates(deslocRows, dateCol) : 0;

    // Global average
    const globalRetornoValues: number[] = [];
    const seenGlobal = new Set<string>();
    for (const row of deslocRows) {
      const team = teamCol ? String(row[teamCol] ?? '').trim() : '';
      const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
      const key = `${team}|${date}`;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      const v = retornoBaseCol ? parseNumber(String(row[retornoBaseCol] ?? '')) : null;
      if (v !== null && Number.isFinite(v) && v > 0) globalRetornoValues.push(v);
    }
    const globalAvgRetorno = globalRetornoValues.length > 0
      ? globalRetornoValues.reduce((s, x) => s + x, 0) / globalRetornoValues.length : 0;

    const result: RetornoBaseTeamAnalysis[] = [];

    for (const [team, { value: retornoValue }] of teamsToAnalyze.entries()) {
      const teamNorm = normalizeToken(team);
      let teamRows = deslocRows.filter((r) => String(r[teamCol] ?? '').trim() === team);
      if (teamRows.length === 0) {
        teamRows = deslocRows.filter((r) => normalizeToken(String(r[teamCol] ?? '').trim()) === teamNorm);
      }
      if (teamRows.length === 0) continue;

      // Deduplicate by date
      const seenDates = new Set<string>();
      const jornadaRows: CsvRow[] = [];
      for (const row of teamRows) {
        const date = dateCol ? String(row[dateCol] ?? '').trim() : '';
        if (!seenDates.has(date)) { seenDates.add(date); jornadaRows.push(row); }
      }

      const teamRetornoValues: number[] = [];
      for (const row of jornadaRows) {
        const v = retornoBaseCol ? parseNumber(String(row[retornoBaseCol] ?? '')) : null;
        if (v !== null && Number.isFinite(v) && v > 0) teamRetornoValues.push(v);
      }
      const teamAvgRetorno = teamRetornoValues.length > 0
        ? teamRetornoValues.reduce((s, x) => s + x, 0) / teamRetornoValues.length : 0;

      const diasAcimaMetaCount = teamRetornoValues.filter((v) => v > RETORNO_META).length;

      const flaggedDays: RetornoBaseDayEvidence[] = [];
      let countRetornoAlto = 0;
      let countRetornoMuitoAlto = 0;

      for (const row of jornadaRows) {
        const retornoMin = retornoBaseCol ? parseNumber(String(row[retornoBaseCol] ?? '')) : null;
        if (retornoMin === null || !Number.isFinite(retornoMin) || retornoMin <= 0) continue;

        const flags: RetornoBaseDayEvidence['flags'] = [];
        // retorno_muito_alto: > meta * 1.5 (> 60 min)
        // retorno_alto: > meta (> 40 min)
        if (retornoMin > RETORNO_META * 1.5) { flags.push('retorno_muito_alto'); countRetornoMuitoAlto++; }
        else if (retornoMin > RETORNO_META) { flags.push('retorno_alto'); countRetornoAlto++; }

        if (flags.length === 0) continue;

        flaggedDays.push({
          date_ref: dateCol ? String(row[dateCol] ?? '').trim() : '',
          retorno_base_min: round2(retornoMin),
          team_avg_retorno_min: round2(teamAvgRetorno),
          global_avg_retorno_min: round2(globalAvgRetorno),
          hora_ultima_ordem: horaUltimaCol ? String(row[horaUltimaCol] ?? '').trim() : '',
          log_off_corrigido: logOffCorCol  ? String(row[logOffCorCol] ?? '').trim()  : '',
          flags,
        });
      }

      flaggedDays.sort((a, b) => b.retorno_base_min - a.retorno_base_min);

      result.push({
        team,
        retornoBaseValue: retornoValue,
        metaTarget: RETORNO_META,
        gap: round2(retornoValue - RETORNO_META),
        avgRetornoMin: round2(teamAvgRetorno),
        globalAvgRetornoMin: round2(globalAvgRetorno),
        totalDays: jornadaRows.length,
        diasAcimaMetaCount,
        flaggedDays: distinctDates > 7 ? flaggedDays.slice(0, 10) : flaggedDays,
        summary: { countRetornoAlto, countRetornoMuitoAlto },
      });
    }

    return result.sort((a, b) => b.retornoBaseValue - a.retornoBaseValue);
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

        let firstEvidence = true;
        for (const analysis of insight.evidenceAnalysis) {
          if (!firstEvidence) { lines.push(hr); lines.push(''); }
          firstEvidence = false;
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

      let firstOsDia = true;
      for (const analysis of report.specialAnalysis.osDiaAnalysis) {
        if (!firstOsDia) { lines.push(hr); lines.push(''); }
        firstOsDia = false;
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

    // ── Utilização Drill-down ─────────────────────────────────────────
    if (report.specialAnalysis.utilizacaoAnalysis.length > 0) {
      lines.push('## 🔍 Análise Detalhada — Utilização');
      lines.push('');
      lines.push('> Evidências das 3 piores equipes em Utilização (meta: 85%). Fonte: **Tab_Completa-Deslocamentos**');
      lines.push('');

      let firstUtil = true;
      for (const analysis of report.specialAnalysis.utilizacaoAnalysis) {
        if (!firstUtil) { lines.push(hr); lines.push(''); }
        firstUtil = false;
        lines.push(`### ⚠ Oportunidade — ${analysis.team}`);
        lines.push('');
        lines.push(
          `**Utilização:** ${fmt(analysis.utilizacaoValue)}% | **Meta:** ${analysis.metaTarget}% | **Gap:** ${fmt(analysis.gap)}%`,
        );
        lines.push('');
        lines.push(
          `**HD Total (médio):** ${fmt(analysis.hdTotalMin)} min | **TempPrep:** ${fmt(analysis.tempPrepTotalMin)} min | **SemOrdem:** ${fmt(analysis.semOrdemTotalMin)} min`,
        );
        lines.push('');
        lines.push(
          `**Total de OS:** ${analysis.totalOrders} | **Jornadas:** ${analysis.totalJornadas} | **Abaixo da meta:** ${analysis.jornadasAbaixoMeta}`,
        );
        if (analysis.summary.countTempPrepAlto > 0 || analysis.summary.countSemOsAlto > 0) {
          lines.push('');
          const chips: string[] = [];
          if (analysis.summary.countTempPrepAlto > 0) chips.push(`TempPrep≥20min: ${analysis.summary.countTempPrepAlto}`);
          if (analysis.summary.countSemOsAlto > 0) chips.push(`SemOS≥10min: ${analysis.summary.countSemOsAlto}`);
          lines.push(`**Alertas:** ${chips.join(' | ')}`);
        }
        lines.push('');

        if (analysis.flaggedOrders.length === 0) {
          lines.push('_Nenhuma ordem com alertas nos dados filtrados._');
        } else {
          lines.push('| OS | Flags | TR (min) | TL (min) | HD (min) |');
          lines.push('| :--- | :--- | ---: | ---: | ---: |');
          for (const ev of analysis.flaggedOrders) {
            const flagStr = ev.flags.join(', ');
            lines.push(`| ${ev.nr_ordem} | ${flagStr} | ${fmt(ev.tr_ordem_min)} | ${fmt(ev.tl_ordem_min)} | ${fmt(ev.hd_total_min)} |`);
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
      let firstPlan = true;
      for (const plan of report.specialAnalysis.actionPlan) {
        if (!firstPlan) { lines.push(hr); lines.push(''); }
        firstPlan = false;
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
