import { __decorate } from "tslib";
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { environment } from '../../../environments/environment';
let ScannerApiService = class ScannerApiService {
    constructor() {
        this.http = inject(HttpClient);
        this.baseUrl = environment.apiBaseUrl;
    }
    startExecution(payload) {
        return this.http.post(`${this.baseUrl}/scanner/executions`, payload);
    }
    getExecution(jobId) {
        return this.http.get(`${this.baseUrl}/scanner/executions/${jobId}`);
    }
    getCatalog(options) {
        let params = new HttpParams();
        if (options?.analysisTab) {
            params = params.set('analysisTab', options.analysisTab);
        }
        if (options?.reportTitle) {
            params = params.set('reportTitle', options.reportTitle);
        }
        return this.http.get(`${this.baseUrl}/scanner/catalog`, { params }).pipe(map((payload) => this.normalizeCatalog(payload)));
    }
    getExportDownloadUrl(jobId) {
        return `${this.baseUrl}/scanner/executions/${jobId}/export`;
    }
    normalizeCatalog(payload) {
        const source = (payload ?? {});
        const filters = Array.isArray(source['filters']) ? source['filters'] : [];
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
    normalizeStringArray(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        return value
            .filter((entry) => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    }
};
ScannerApiService = __decorate([
    Injectable({ providedIn: 'root' })
], ScannerApiService);
export { ScannerApiService };
//# sourceMappingURL=scanner-api.service.js.map