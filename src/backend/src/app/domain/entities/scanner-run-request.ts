import type { SpotfireFilter } from './spotfire-filter.js';

export interface ScannerRunRequest {
  analysisTab?: string;
  reportTitle?: string;
  tableTitle?: string;
  selectedFilters?: SpotfireFilter[];
}