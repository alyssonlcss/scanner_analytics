import type { SpotfireFilter } from './spotfire-filter.js';

export type SpotfireCatalogStatus = 'loading' | 'ready' | 'failed';

export interface SpotfireCatalog {
  status: SpotfireCatalogStatus;
  reportTitle: string;
  filters: SpotfireFilter[];
  availableTabs: string[];
  availableTables: string[];
  updatedAt?: string;
  errorMessage?: string;
}