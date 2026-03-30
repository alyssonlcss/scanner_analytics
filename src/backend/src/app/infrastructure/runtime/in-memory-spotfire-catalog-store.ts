import type { SpotfireCatalog } from '../../domain/entities/spotfire-catalog.js';

export class InMemorySpotfireCatalogStore {
  private catalog: SpotfireCatalog;

  public constructor(reportTitle: string) {
    this.catalog = {
      status: 'loading',
      reportTitle,
      filters: [],
      availableTabs: [],
      availableTables: [],
    };
  }

  public get(): SpotfireCatalog {
    return structuredClone(this.catalog);
  }

  public set(catalog: SpotfireCatalog): void {
    this.catalog = structuredClone(catalog);
  }
}