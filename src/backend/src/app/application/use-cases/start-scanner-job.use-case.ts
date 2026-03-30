import { randomUUID } from 'node:crypto';

import type { ScannerJob } from '../../domain/entities/scanner-job.js';
import type { ScannerRunRequest } from '../../domain/entities/scanner-run-request.js';
import type { ScannerAutomationPort } from '../../domain/ports/scanner-automation.port.js';
import type { ScannerJobStorePort } from '../../domain/ports/scanner-job-store.port.js';

export class StartScannerJobUseCase {
  public constructor(
    private readonly automation: ScannerAutomationPort,
    private readonly jobStore: ScannerJobStorePort,
  ) {}

  public async execute(request: ScannerRunRequest): Promise<ScannerJob> {
    const now = new Date().toISOString();

    const job: ScannerJob = {
      id: randomUUID(),
      status: 'queued',
      request: {
        analysisTab: request.analysisTab,
        reportTitle: request.reportTitle ?? 'Scanner 4.0 - CE',
        tableTitle: request.tableTitle,
        selectedFilters: request.selectedFilters,
      },
      createdAt: now,
      updatedAt: now,
      filters: [],
      availableTabs: [],
      availableTables: [],
    };

    await this.jobStore.create(job);
    void this.run(job);
    return job;
  }

  private async run(job: ScannerJob): Promise<void> {
    const runningJob: ScannerJob = {
      ...job,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };

    await this.jobStore.update(runningJob);

    try {
      const result = await this.automation.runExtraction({
        analysisTab: runningJob.request.analysisTab,
        reportTitle: runningJob.request.reportTitle,
        tableTitle: runningJob.request.tableTitle,
        selectedFilters: runningJob.request.selectedFilters,
      });

      await this.jobStore.update({
        ...runningJob,
        status: 'completed',
        filters: result.filters,
        availableTabs: result.availableTabs,
        availableTables: result.availableTables,
        exportFilePath: result.exportFilePath,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown extraction error';

      await this.jobStore.update({
        ...runningJob,
        status: 'failed',
        errorMessage: message,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}