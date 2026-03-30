import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

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

  public startExecution(payload: { analysisTab?: string; reportTitle?: string; tableTitle?: string }): Observable<ScannerJob> {
    return this.http.post<ScannerJob>(`${this.baseUrl}/scanner/executions`, payload);
  }

  public getExecution(jobId: string): Observable<ScannerJob> {
    return this.http.get<ScannerJob>(`${this.baseUrl}/scanner/executions/${jobId}`);
  }

  public getCatalog(): Observable<SpotfireCatalog> {
    return this.http.get<SpotfireCatalog>(`${this.baseUrl}/scanner/catalog`);
  }

  public getExportDownloadUrl(jobId: string): string {
    return `${this.baseUrl}/scanner/executions/${jobId}/export`;
  }
}