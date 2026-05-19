// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SpotfireFilter } from '../../models/spotfire-catalog.model';

export interface ScannerDataDownloadResult {
  status: 'completed';
  reportTitle: string;
  updatedAt: string;
  files: Array<{
    analysisTab: string;
    tableTitle: string;
    fileName: string;
    filePath: string;
  }>;
  filters: SpotfireFilter[];
  availableTabs: string[];
  availableTables: string[];
  generatedReport?: {
    generatedAt: string;
    outputFiles: {
      jsonPath: string;
      markdownPath: string;
    };
  };
}

export interface ReportKpiTeamScore {
  team: string;
  rawValue: number;
  score: number;
}

export interface ReportKpiInsight {
  kpi: string;
  direction: 'higher-is-better' | 'lower-is-better';
  topTeams: Array<{ team: string; value: number }>;
  opportunityTeams: Array<{ team: string; value: number }>;
  scores: ReportKpiTeamScore[];
  average: number;
  metaTarget: number;
  /** Chart scaling config from backend KPI_THRESHOLDS — worst/best/direction/meta. */
  chartConfig?: { worst: number; best: number; direction: 'h' | 'l'; meta: number };
  dailyTrend?: Array<{ date: string; avgValue: number }>;
  /** Per-team per-day counts for OS Dia (enables non-flat team lines in the analytic chart). */
  perTeamDailyData?: Array<{ team: string; dailyPoints: Array<{ date: string; value: number }> }>;
  evidenceAnalysis?: EficienciaTeamAnalysis[];
  tmeImpAnalysis?: TmeImpTeamAnalysis[];
  primeiroLoginAnalysis?: PrimeiroLoginTeamAnalysis[];
  primeiroDeslocAnalysis?: PrimeiroDeslocTeamAnalysis[];
  retornoBaseAnalysis?: RetornoBaseTeamAnalysis[];
}

export interface ReportTeamMetric {
  team: string;
  records: number;
  tempPrepJornada: number;
  semOrdemJornada: number;
}

export interface ReportCrossedInsight {
  title: string;
  description: string;
  evidence: Array<Record<string, string | number>>;
}

export interface ReportActionPlan {
  team: string;
  issues: string[];
  recommendations: string[];
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
  global_avg_tl_min: number;
  global_avg_tr_min: number;
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
    /** Pre-computed label (e.g. "Entre OS"). */
    label?: string;
    /** Pre-computed body text describing the detail. */
    body?: string;
  }>;
  sem_os_total_min?: number;
  flags: Array<'tr_excede_hd' | 'tl_excede_hd' | 'temp_prep_alto' | 'sem_os_alto'>;
  /** Pre-computed alert text keyed by flag code. */
  alertTexts?: Record<string, string>;
  /** True when TR exceeds the global average repair time AND exceeds the M300 standard time. */
  flag_temp_reparo_excedido?: boolean;
  /** Gap from fim_intervalo to despachada when > 10 min and not covered by sem_os_details. */
  entreOsAfterIntervalo?: { min: number; from: string; to: string };
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
  summary: {
    countTrExceeds: number;
    countTlExceeds: number;
    countTempPrepAlto: number;
    countSemOsAlto: number;
  };
  idleAnalysis?: {
    idleMin: number;
    idlePct: number;
    horasExtras?: number;
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
  tl_ordem_min: number;
  tr_ordem_min: number;
  hd_total_min: number;
  hd_pct_tr: number;
  tempo_padrao_min?: number;
  global_avg_tr_min?: number;
  prev_liberada?: string;
  flags: Array<'deslocamento_curto' | 'tr_excede_hd' | 'tempo_padrao_vazio' | 'tr_muito_baixo'>;
  /** Pre-computed alert text keyed by flag code. */
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
    interval_discounted?: boolean;
    retorno_base_discounted?: number;
    retorno_base_used_row?: boolean;
    desp_anterior?: string;
    /** Pre-computed label (e.g. "Entre OS"). */
    label?: string;
    /** Pre-computed body text describing the detail. */
    body?: string;
  }>;
  sem_os_total_min?: number;
  flags: Array<'temp_prep_alto' | 'sem_os_alto' | 'tr_excede_hd'>;
  /** Pre-computed alert text keyed by flag code. */
  alertTexts?: Record<string, string>;
  /** Gap from fim_intervalo to despachada when > 10 min and not covered by sem_os_details. */
  entreOsAfterIntervalo?: { min: number; from: string; to: string };
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
  summary: {
    countTempPrepAlto: number;
    countSemOsAlto: number;
  };
  idleAnalysis?: {
    idleMin: number;
    idlePct: number;
    horasExtras?: number;
  };
}

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
  tme_imp_min: number;
  team_avg_tme_min: number;
  global_avg_tme_min: number;
  flags: Array<'tme_muito_alto' | 'sem_deslocamento' | 'sem_execucao'>;
  /** Pre-computed alert text keyed by flag code. */
  alertTexts?: Record<string, string>;
}

export interface TmeImpTeamAnalysis {
  team: string;
  tmeImpValue: number;
  metaTarget: number;
  gap: number;
  avgTmeImpMin: number;
  globalAvgTmeImpMin: number;
  totalOrders: number;
  flaggedOrders: TmeImpOrderEvidence[];
  summary: {
    countTmeMuitoAlto: number;
    countSemDeslocamento: number;
    countSemExecucao: number;
  };
}

export interface PrimeiroLoginDayEvidence {
  date_ref: string;
  inicio_calendario: string;
  log_in_corrigido: string;
  primeiro_login_min: number;
  team_avg_login_min: number;
  global_avg_login_min: number;
  flags: Array<'login_tardio' | 'login_muito_tardio'>;
  /** Pre-computed alert text keyed by flag code. */
  alertTexts?: Record<string, string>;
}

export interface PrimeiroLoginTeamAnalysis {
  team: string;
  primeiroLoginValue: number;
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

export interface PrimeiroDeslocDayEvidence {
  date_ref: string;
  nr_ordem: string;
  hora_primeiro_despacho: string;
  hora_primeiro_deslocamento: string;
  inicio_calendario: string;
  log_in_corrigido: string;
  primeiro_desloc_min: number;
  despacho_apos_inicio_min: number;
  login_atraso_min: number;
  team_avg_desloc_min: number;
  global_avg_desloc_min: number;
  is_primeira_os_jornada: boolean;
  flags: Array<'desloc_lento' | 'desloc_muito_lento' | 'sem_desloc_registrado' | 'despacho_tardio'>;
  /** Pre-computed alert text keyed by flag code. */
  alertTexts?: Record<string, string>;
}

export interface PrimeiroDeslocTeamAnalysis {
  team: string;
  primeiroDeslocValue: number;
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

export interface RetornoBaseDayEvidence {
  date_ref: string;
  retorno_base_min: number;
  team_avg_retorno_min: number;
  global_avg_retorno_min: number;
  hora_ultima_ordem: string;
  log_off_corrigido: string;
  flags: Array<'retorno_alto' | 'retorno_muito_alto'>;
  /** Pre-computed alert text keyed by flag code. */
  alertTexts?: Record<string, string>;
}

export interface RetornoBaseTeamAnalysis {
  team: string;
  retornoBaseValue: number;
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

export interface GeneratedReport {
  generatedAt: string;
  filtersApplied: {
    bases: string[];
    teamTypes: string[];
    includeExtraTags: boolean;
    extraTags: string[];
  };
  totals: {
    teams: number;
    deslocamentos: number;
    rankingRows: number;
    desviosRows: number;
  };
  kpis: ReportKpiInsight[];
  deviations: {
    mostRecurring: Array<{ category: string; occurrences: number }>;
    teamBreakdown: Array<{ team: string; deviations: string[] }>;
  };
  executiveSummary: ExecutiveSummary;
  teamScorecard: TeamKpiScorecard[];
  specialAnalysis: {
    tempPrepAndSemOs: ReportTeamMetric[];
    crossedInsights: ReportCrossedInsight[];
    actionPlan: ReportActionPlan[];
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
}

export interface ScannerReportGenerateResult {
  status: 'completed';
  generatedReport: GeneratedReport;
}

export interface ScannerJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  request: {
    analysisTab?: string;
    reportTitle: string;
    tableTitle?: string;
    selectedFilters?: SpotfireFilter[];
  };
  filters: SpotfireFilter[];
  availableTabs: string[];
  availableTables: string[];
  exportFilePath?: string;
  errorMessage?: string;
}

export interface DataDownloadCallbacks {
  onProgress?: (message: string) => void;
  onResult?: (result: ScannerDataDownloadResult) => void;
  onError?: (error: string) => void;
}

@Injectable({ providedIn: 'root' })
export class ScannerApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  public startExecution(payload: {
    analysisTab?: string;
    reportTitle?: string;
    tableTitle?: string;
    selectedFilters?: SpotfireFilter[];
  }): Observable<ScannerJob> {
    return this.http.post<ScannerJob>(`${this.baseUrl}/scanner/executions`, payload);
  }

  public getExecution(jobId: string): Observable<ScannerJob> {
    return this.http.get<ScannerJob>(`${this.baseUrl}/scanner/executions/${jobId}`);
  }

  public dataDownload(payload: {
    reportTitle?: string;
    selectedFilters?: SpotfireFilter[];
    periodSelection?: {
      year?: string[];
      month?: string[];
      dayRange?: {
        min: number;
        max: number;
      };
    };
  }): Observable<ScannerDataDownloadResult> {
    return this.http.post<ScannerDataDownloadResult>(`${this.baseUrl}/scanner/data-download`, payload);
  }

  public async dataDownloadWithProgress(
    payload: {
      reportTitle?: string;
      selectedFilters?: SpotfireFilter[];
      periodSelection?: {
        year?: string[];
        month?: string[];
        dayRange?: { min: number; max: number };
      };
    },
    callbacks: DataDownloadCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/scanner/data-download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok || !response.body) {
      callbacks.onError?.(`HTTP ${response.status}`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let currentEvent = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6);

          try {
            const parsed = JSON.parse(data);

            if (currentEvent === 'progress') {
              callbacks.onProgress?.(parsed.message);
            } else if (currentEvent === 'result') {
              callbacks.onResult?.(parsed as ScannerDataDownloadResult);
            } else if (currentEvent === 'error') {
              callbacks.onError?.(parsed.message);
            }
          } catch {
            // ignore malformed JSON
          }

          currentEvent = '';
        }
      }
    }
  }

  public generateReport(payload: {
    reportFilters?: {
      bases?: string[];
      teamTypes?: Array<'propria' | 'parceira'>;
      teams?: string[];
      includeExtraTags?: boolean;
    };
  }): Observable<ScannerReportGenerateResult> {
    return this.http.post<ScannerReportGenerateResult>(`${this.baseUrl}/scanner/reports/generate`, payload);
  }

  /** Gera dados filtrados por base/tipo/equipe sem sobrescrever o relatório salvo. */
  public exportData(payload: {
    reportFilters: {
      bases: string[];
      teamTypes: Array<'propria' | 'parceira'>;
      teams?: string[];
    };
  }): Observable<ScannerReportGenerateResult> {
    return this.http.post<ScannerReportGenerateResult>(`${this.baseUrl}/scanner/reports/export-data`, payload);
  }

  public getTeams(): Observable<{ teams: string[] }> {
    return this.http.get<{ teams: string[] }>(`${this.baseUrl}/scanner/reports/teams`);
  }

  public getExportDownloadUrl(jobId: string): string {
    return `${this.baseUrl}/scanner/executions/${jobId}/export`;
  }
}