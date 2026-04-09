import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SpotfireCatalog, SpotfireFilter } from '../../models/spotfire-catalog.model';

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

  public getCatalog(options?: { analysisTab?: string; reportTitle?: string }): Observable<SpotfireCatalog> {
    let params = new HttpParams();

    if (options?.analysisTab) {
      params = params.set('analysisTab', options.analysisTab);
    }

    if (options?.reportTitle) {
      params = params.set('reportTitle', options.reportTitle);
    }

    return this.http.get<unknown>(`${this.baseUrl}/scanner/catalog`, { params }).pipe(
      map((payload) => this.normalizeCatalog(payload)),
    );
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

  public getExportDownloadUrl(jobId: string): string {
    return `${this.baseUrl}/scanner/executions/${jobId}/export`;
  }

  private normalizeCatalog(payload: unknown): SpotfireCatalog {
    const source = (payload ?? {}) as Record<string, unknown>;
    const filters = Array.isArray(source['filters']) ? source['filters'] as SpotfireFilter[] : [];
    const availableTabs = this.normalizeStringArray(source['availableTabs'] ?? source['tabs']);
    const availableTables = this.normalizeStringArray(source['availableTables'] ?? source['tables']);
    const status = source['status'];

    return {
      status: status === 'ready' || status === 'failed' ? status : 'loading',
      reportTitle: typeof source['reportTitle'] === 'string' && source['reportTitle'].trim().length > 0
        ? source['reportTitle']
        : 'Scanner 4.0 - CE',
      filters,
      availableTabs,
      availableTables,
      updatedAt: typeof source['updatedAt'] === 'string' ? source['updatedAt'] : undefined,
      errorMessage: typeof source['errorMessage'] === 'string' ? source['errorMessage'] : undefined,
    };
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}