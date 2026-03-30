import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SpotfireCatalog, SpotfireFilter } from '../../models/spotfire-catalog.model';

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