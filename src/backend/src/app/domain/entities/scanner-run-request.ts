// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import type { SpotfireFilter } from './spotfire-filter.js';

export interface ScannerPeriodSelection {
  year?: string | string[];
  month?: string | string[];
  dayRange?: {
    min: number;
    max: number;
  };
}

export interface TableExportConfig {
  tab: string;
  tableTitle: string;
}

export interface ScannerRunRequest {
  analysisTab?: string;
  reportTitle?: string;
  tableTitle?: string;
  tablesToExport?: TableExportConfig[];
  selectedFilters?: SpotfireFilter[];
  periodSelection?: ScannerPeriodSelection;
  skipFilterReset?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}