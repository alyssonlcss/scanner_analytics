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

export interface ScannerReportGenerateResult {
  status: 'completed';
  generatedReport: {
    generatedAt: string;
    outputFiles: {
      jsonPath: string;
      markdownPath: string;
    };
  };
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
      includeExtraTags?: boolean;
    };
  }): Observable<ScannerReportGenerateResult> {
    return this.http.post<ScannerReportGenerateResult>(`${this.baseUrl}/scanner/reports/generate`, payload);
  }

  public getExportDownloadUrl(jobId: string): string {
    return `${this.baseUrl}/scanner/executions/${jobId}/export`;
  }
}