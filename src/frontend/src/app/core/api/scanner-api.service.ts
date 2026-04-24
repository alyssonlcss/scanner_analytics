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
  evidenceAnalysis?: EficienciaTeamAnalysis[];
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

export interface OsDiaTeamAnalysis {
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

export interface EficienciaOrderEvidence {
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
  flags: Array<'temp_prep_alto' | 'sem_os_alto'>;
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
  jornadasAbaixoMeta: number;
  flaggedOrders: UtilizacaoOrderEvidence[];
  summary: {
    countTempPrepAlto: number;
    countSemOsAlto: number;
  };
  idleAnalysis?: {
    idleMin: number;
    idlePct: number;
  };
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
  specialAnalysis: {
    tempPrepAndSemOs: ReportTeamMetric[];
    crossedInsights: ReportCrossedInsight[];
    actionPlan: ReportActionPlan[];
    osDiaAnalysis: OsDiaTeamAnalysis[];
    utilizacaoAnalysis: UtilizacaoTeamAnalysis[];
  };
  outputFiles: {
    jsonPath: string;
    markdownPath: string;
  };
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

  public getTeams(): Observable<{ teams: string[] }> {
    return this.http.get<{ teams: string[] }>(`${this.baseUrl}/scanner/reports/teams`);
  }

  public getExportDownloadUrl(jobId: string): string {
    return `${this.baseUrl}/scanner/executions/${jobId}/export`;
  }
}