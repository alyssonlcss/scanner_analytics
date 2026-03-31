import type { SpotfireFilter } from './spotfire-filter.js';

export interface ScannerPeriodSelection {
  year?: string;
  month?: string;
  dayRange?: {
    min: number;
    max: number;
  };
}

export interface ScannerRunRequest {
  analysisTab?: string;
  reportTitle?: string;
  tableTitle?: string;
  selectedFilters?: SpotfireFilter[];
  periodSelection?: ScannerPeriodSelection;
}