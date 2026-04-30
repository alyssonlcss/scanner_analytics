// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import type { ScannerRunRequest } from '../entities/scanner-run-request.js';
import type { SpotfireFilter } from '../entities/spotfire-filter.js';

export interface ScannerAutomationResult {
  filters: SpotfireFilter[];
  availableTabs: string[];
  availableTables: string[];
  exportFilePath?: string;
  exportedFiles: Array<string | undefined>;
}

export interface ScannerAutomationPort {
  runExtraction(request: ScannerRunRequest): Promise<ScannerAutomationResult>;
}