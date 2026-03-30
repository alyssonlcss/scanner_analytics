import type { SpotfireFilter } from './spotfire-filter.js';

export type ScannerJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ScannerJob {
  id: string;
  status: ScannerJobStatus;
  request: {
    analysisTab?: string;
    reportTitle: string;
    tableTitle?: string;
    selectedFilters?: SpotfireFilter[];
  };
  createdAt: string;
  updatedAt: string;
  filters: SpotfireFilter[];
  availableTabs: string[];
  availableTables: string[];
  exportFilePath?: string;
  errorMessage?: string;
}