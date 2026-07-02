import { __decorate } from "tslib";
// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
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
    dataDownload(payload) {
        return this.http.post(`${this.baseUrl}/scanner/data-download`, payload);
    }
    async dataDownloadWithProgress(payload, callbacks, signal) {
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
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            let currentEvent = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                }
                else if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    try {
                        const parsed = JSON.parse(data);
                        if (currentEvent === 'progress') {
                            callbacks.onProgress?.(parsed.message);
                        }
                        else if (currentEvent === 'result') {
                            callbacks.onResult?.(parsed);
                        }
                        else if (currentEvent === 'error') {
                            callbacks.onError?.(parsed.message);
                        }
                    }
                    catch {
                        // ignore malformed JSON
                    }
                    currentEvent = '';
                }
            }
        }
    }
    generateReport(payload) {
        return this.http.post(`${this.baseUrl}/scanner/reports/generate`, payload);
    }
    /** Gera dados filtrados por base/tipo/equipe sem sobrescrever o relatório salvo. */
    exportData(payload) {
        return this.http.post(`${this.baseUrl}/scanner/reports/export-data`, payload);
    }
    /**
     * Apaga os PDFs gerados anteriormente de um tipo (atual/proprias/parceiras) da pasta Downloads.
     * O backend localiza arquivos com prefixo ScannerAnalytics_{Tipo}_ e os remove.
     */
    cleanupExports(type) {
        return this.http.post(`${this.baseUrl}/export/cleanup`, { type });
    }
    getTeams() {
        return this.http.get(`${this.baseUrl}/scanner/reports/teams`);
    }
    getExportDownloadUrl(jobId) {
        return `${this.baseUrl}/scanner/executions/${jobId}/export`;
    }
    getBasesConfig() {
        return this.http.get(`${this.baseUrl}/scanner/config/bases`);
    }
};
ScannerApiService = __decorate([
    Injectable({ providedIn: 'root' })
], ScannerApiService);
export { ScannerApiService };
//# sourceMappingURL=scanner-api.service.js.map