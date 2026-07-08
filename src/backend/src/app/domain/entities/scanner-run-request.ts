// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import type { SpotfireFilter } from './spotfire-filter.js';

export interface ScannerPeriodSelection {
  year?: string | string[];
  month?: string | string[];
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
  clientBrowserType?: 'edge' | 'chrome';
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}