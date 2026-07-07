// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import type { SpotfireFilter } from './spotfire-filter.js';

export interface ScannerPeriodSelection {
  year?: string | string[];
  month?: string | string[];
  /** Single day-range applied uniformly to every selected month */
  dayRange?: {
    min: number;
    max: number;
  };
  /**
   * Per-month day ranges for cross-month selections (e.g. 29/04 – 02/05).
   * Keys are month abbreviations ("jan" … "dez").
   * When present, takes precedence over `dayRange`.
   */
  monthDayRanges?: Record<string, { min: number; max: number }>;
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