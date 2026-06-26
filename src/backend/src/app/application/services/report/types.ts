// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.



export type TeamType = 'propria' | 'parceira';

export type CsvRow = Record<string, string>;

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
  dates?: string[];
}

export interface TeamMetricSummary {
  team: string;
  records: number;
  tempPrepJornada: number;
  semOrdemJornada: number;
}

export interface KpiRankItem {
  team: string;
  value: number;
}

export interface KpiTeamScore {
  team: string;
  rawValue: number;
  score: number;
}

export interface DailyTrendPoint {
  /** Date formatted as dd/mm */
  date: string;
  avgValue: number;
}

export interface PerTeamDailyPoint {
  /** Date formatted as dd/mm */
  date: string;
  value: number;
}

export interface KpiInsight {
  kpi: string;
  direction: 'higher-is-better' | 'lower-is-better';
  topTeams: KpiRankItem[];
  opportunityTeams: KpiRankItem[];
  scores: KpiTeamScore[];
  average: number;
  metaTarget: number;
  /** Chart scaling config derived from KPI_THRESHOLDS — worst/best/direction/meta for bar chart rendering. */
  chartConfig?: { worst: number; best: number; direction: 'h' | 'l'; meta: number };
  dailyTrend?: DailyTrendPoint[];
  dailyTrendByBase?: Array<{ base: string; teamType: string; trend: DailyTrendPoint[] }>;
  /** Per-team per-day values (e.g. Nr_Ordem count for OS Dia). Enables non-flat team lines in the analytic chart. */
  perTeamDailyData?: Array<{ team: string; dailyPoints: PerTeamDailyPoint[] }>;
  evidenceAnalysis?: EficienciaTeamAnalysis[];
  tmeImpAnalysis?: TmeImpTeamAnalysis[];
  primeiroLoginAnalysis?: PrimeiroLoginTeamAnalysis[];
  primeiroDeslocAnalysis?: PrimeiroDeslocTeamAnalysis[];
  retornoBaseAnalysis?: RetornoBaseTeamAnalysis[];
}

export interface DeviationInsight {
  category: string;
  occurrences: number;
}

export interface DeviationByTeam {
  team: string;
  deviations: string[];
}

export interface CrossedInsight {
  title: string;
  description: string;
  evidence: Array<Record<string, string | number>>;
}

export interface TeamActionPlan {
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
  /** Pre-computed flag metadata for rendering (labels keyed by flag code). */
  flagMeta?: {
    labels: Record<string, string>;
  };
  /** Actual date range found in the Data Referência column of the downloaded file (DD/MM/YYYY). */
  dataDateRange?: { min: string; max: string } | null;
  availableDates: string[];
}

export interface TempSemOsRow {
  team: string;
  dateRef: string;
  tempPrep: number;
  semOsEntreOs: number;
  tempPrepJornada: number;
  semOrdemJornada: number;
}

export interface OsDiaOrderEvidence {
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
  global_avg_tr_min: number;   // global average TR across all teams (threshold reference)
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
    /** Excess minutes above retorno base; only present when the Antes Log Off flag is active. */
    excess_min?: number;
    desp_anterior?: string;
    /** Label for the from-point (e.g. 'Lib. Anterior', 'Despachada', 'Fim Intervalo'). */
    from_label?: string;
    /** Pre-computed label (e.g. "Entre OS", "1º Despacho"). */
    label?: string;
    /** Pre-computed body text describing the detail. */
    body?: string;
  }>;
  sem_os_total_min?: number;
  flags: Array<'tr_excede_hd' | 'tl_excede_hd' | 'temp_prep_alto' | 'sem_os_alto' | 'antes_log_off_alto' | 'triagem_alto' | 'primeiro_desloc_alto'>;
  /** Pre-computed alert text per flag code. */
  alertTexts?: Record<string, string>;
  /** True when TR exceeds the global average repair time AND exceeds the M300 standard time. */
  flag_temp_reparo_excedido?: boolean;
  /** Gap from fim_intervalo to despachada when > 10 min and not covered by sem_os_details. */
  entreOsAfterIntervalo?: { min: number; from: string; to: string };
  /**
   * When set, indicates that another OS (this nr_ordem) was dispatched to the team
   * BEFORE this OS's 'Despachada'. The segment label changes from '1º Despacho' to 'Despacho'
   * and a warning flag is shown in the evidence card / PDF.
   */
  nr_ordem_despacho_anterior?: string;
  /** Timestamp of that prior dispatch (raw CSV string, e.g. "24/05/2026 13:07:15"). */
  hora_despacho_anterior?: string;
  /** Duration in minutes from hora_despacho_anterior to despachada (the "triagem" window). */
  triagem_min?: number;
  /** Global average triagem_min across all rows with a prior dispatch conflict. */
  triagem_global_avg_min?: number;
  /** Total idle time: Início Cal. → A Caminho for 1ª OS; prev_liberada → A Caminho for others. */
  ocioso_min?: number;
  /** True if this is the last OS of the day. */
  is_last_os?: boolean;
}

export interface OsDiaTeamAnalysis {
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
  extraFlaggedOrders?: OsDiaOrderEvidence[];
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

export interface EficienciaOrderEvidence {
  nr_ordem: string;
  date_ref?: string;
  classe: string;
  causa: string;
  despachada: string;
  a_caminho: string;
  no_local: string;
  liberada: string;
  inicio_intervalo?: string;
  fim_intervalo?: string;
  tl_ordem_min: number;
  tr_ordem_min: number;
  hd_total_min: number;
  hd_pct_tr: number;
  tempo_padrao_min?: number;
  global_avg_tr_min?: number;   // global average TR across all teams (threshold reference)
  prev_liberada?: string;
  flags: Array<'deslocamento_curto' | 'tr_excede_hd' | 'tempo_padrao_vazio' | 'tr_muito_baixo'>;
  /** Pre-computed alert text per flag code. */
  alertTexts?: Record<string, string>;
  /** True when TR exceeds the global average repair time AND exceeds the M300 standard time. */
  flag_temp_reparo_excedido?: boolean;
}

export interface EficienciaTeamAnalysis {
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
  extraFlaggedOrders?: EficienciaOrderEvidence[];
  tempoPadraoVazioOrders: EficienciaOrderEvidence[];
  simulatedEficiencia?: number;
  summary: {
    totalOrders: number;
    countDeslocamentoCurto: number;
    countTrExcedeHd: number;
    countTempoPadraoVazio: number;
  };
}

export interface UtilizacaoOrderEvidence {
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
    /** Excess minutes above retorno base; only present when the Antes Log Off flag is active. */
    excess_min?: number;
    desp_anterior?: string;
    /** Label for the from-point (e.g. 'Lib. Anterior', 'Despachada', 'Fim Intervalo'). */
    from_label?: string;
  }>;
  sem_os_total_min?: number;
  flags: Array<'temp_prep_alto' | 'sem_os_alto' | 'antes_log_off_alto' | 'tr_excede_hd' | 'triagem_alto' | 'primeiro_desloc_alto'>;
  alertTexts?: Record<string, string>;
  /**
   * When set, another OS (this nr_ordem) was dispatched to the team BEFORE this OS's
   * first 'A Caminho'. Segment label changes from '1º Despacho' to 'Despacho' and
   * a warning flag is shown in the evidence card / PDF.
   */
  nr_ordem_despacho_anterior?: string;
  /** Timestamp of that prior dispatch (raw CSV string, e.g. "24/05/2026 13:07:15"). */
  hora_despacho_anterior?: string;
  /** Duration in minutes from hora_despacho_anterior to despachada (the "triagem" window). */
  triagem_min?: number;
  /** Global average triagem_min across all rows with a prior dispatch conflict. */
  triagem_global_avg_min?: number;
  /** Total idle time: Início Cal. → A Caminho for 1ª OS; prev_liberada → A Caminho for others. */
  ocioso_min?: number;
  /** True if this is the last OS of the day. */
  is_last_os?: boolean;
}

export interface UtilizacaoTeamAnalysis {
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
  extraFlaggedOrders?: UtilizacaoOrderEvidence[];
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
export interface TmeImpOrderEvidence {
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
  /** Pre-computed alert text per flag code. */
  alertTexts?: Record<string, string>;
}

export interface TmeImpTeamAnalysis {
  team: string;
  tmeImpValue: number;    // KPI médio da equipe (do ranking)
  metaTarget: number;
  gap: number;
  avgTmeImpMin: number;   // média calculada pelas ordens
  globalAvgTmeImpMin: number;
  totalOrders: number;
  flaggedOrders: TmeImpOrderEvidence[];
  extraFlaggedOrders?: TmeImpOrderEvidence[];
  summary: {
    countTmeMuitoAlto: number;
    countSemDeslocamento: number;
    countSemExecucao: number;
  };
}

// ─── 1º Login ──────────────────────────────────────────────────────────────
export interface PrimeiroLoginDayEvidence {
  date_ref: string;
  inicio_calendario: string;
  log_in_corrigido: string;
  primeiro_login_min: number;   // 1º Login Corrigido (min)
  team_avg_login_min: number;
  global_avg_login_min: number;
  flags: Array<'login_tardio' | 'login_muito_tardio'>;
  /** Pre-computed alert text per flag code. */
  alertTexts?: Record<string, string>;
}

export interface PrimeiroLoginTeamAnalysis {
  team: string;
  primeiroLoginValue: number;   // KPI médio (do ranking)
  metaTarget: number;
  gap: number;
  avgLoginMin: number;
  globalAvgLoginMin: number;
  totalDays: number;
  diasAcimaMetaCount: number;
  flaggedDays: PrimeiroLoginDayEvidence[];
  extraFlaggedDays?: PrimeiroLoginDayEvidence[];
  summary: {
    countLoginTardio: number;
    countLoginMuitoTardio: number;
  };
}

// ─── 1º Desloc. ────────────────────────────────────────────────────────────
export interface PrimeiroDeslocDayEvidence {
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
  /**
   * When set, indicates that another OS (this nr_ordem) was dispatched to the team
   * BEFORE the first 'A Caminho'. The segment label changes from '1º Despacho' to 'Despacho'
   * and a warning flag is shown in the evidence card / PDF.
   */
  nr_ordem_despacho_anterior?: string;
  /** Timestamp of that prior dispatch (raw CSV string, e.g. "24/05/2026 13:07:15"). */
  hora_despacho_anterior?: string;
  /** Despachada timestamp of the primary (first 'A Caminho') OS. */
  despachada?: string;
  flags: Array<'desloc_lento' | 'desloc_muito_lento' | 'sem_desloc_registrado' | 'despacho_tardio' | 'triagem_alto'>;
  /** Pre-computed alert text per flag code. */
  alertTexts?: Record<string, string>;
  /** Duration in minutes from hora_despacho_anterior to despachada (the "Desp. Prioritário" window). */
  triagem_min?: number;
  /** Global average triagem_min across all rows with a prior dispatch conflict. */
  triagem_global_avg_min?: number;
}

export interface PrimeiroDeslocTeamAnalysis {
  team: string;
  primeiroDeslocValue: number;   // KPI médio (do ranking)
  metaTarget: number;
  gap: number;
  avgDeslocMin: number;
  globalAvgDeslocMin: number;
  totalDays: number;
  diasAcimaMetaCount: number;
  flaggedDays: PrimeiroDeslocDayEvidence[];
  extraFlaggedDays?: PrimeiroDeslocDayEvidence[];
  summary: {
    countDeslocLento: number;
    countDeslocMuitoLento: number;
    countSemDeslocRegistrado: number;
    countDespachioTardio: number;
  };
}

// ─── Retorno Base ──────────────────────────────────────────────────────────
export interface RetornoBaseDayEvidence {
  date_ref: string;
  retorno_base_min: number;
  team_avg_retorno_min: number;
  global_avg_retorno_min: number;
  hora_ultima_ordem: string;
  log_off_corrigido: string;
  flags: Array<'retorno_alto' | 'retorno_muito_alto' | 'retorno_divergente'>;
  true_retorno_min?: number;
  /** Pre-computed alert text per flag code. */
  alertTexts?: Record<string, string>;
}

export interface RetornoBaseTeamAnalysis {
  team: string;
  retornoBaseValue: number;   // KPI médio (do ranking)
  metaTarget: number;
  gap: number;
  avgRetornoMin: number;
  globalAvgRetornoMin: number;
  totalDays: number;
  diasAcimaMetaCount: number;
  flaggedDays: RetornoBaseDayEvidence[];
  extraFlaggedDays?: RetornoBaseDayEvidence[];
  summary: {
    countRetornoAlto: number;
    countRetornoMuitoAlto: number;
  };
}

// ─── Team Scorecard ────────────────────────────────────────────────────────
export interface TeamKpiScorecard {
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
export interface ExecutiveSummary {
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

/**
 * KPIs whose column value is fixed per (team × Data Referência) in the ranking/detail CSV.
 * When iterating ranking rows, only the FIRST row per (team, date) pair is counted to avoid
 * inflating the average when multiple OS rows repeat the same jornada-level value.
 */
