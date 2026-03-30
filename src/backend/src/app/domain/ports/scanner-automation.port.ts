import type { ScannerRunRequest } from '../entities/scanner-run-request.js';
import type { SpotfireFilter } from '../entities/spotfire-filter.js';

export interface ScannerAutomationResult {
  filters: SpotfireFilter[];
  availableTabs: string[];
  availableTables: string[];
  exportFilePath?: string;
}

export interface ScannerAutomationPort {
  runExtraction(request: ScannerRunRequest): Promise<ScannerAutomationResult>;
}