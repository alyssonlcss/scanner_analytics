import type { ScannerJob } from '../../domain/entities/scanner-job.js';
import type { ScannerJobStorePort } from '../../domain/ports/scanner-job-store.port.js';

export class GetScannerJobUseCase {
  public constructor(private readonly jobStore: ScannerJobStorePort) {}

  public async execute(jobId: string): Promise<ScannerJob | null> {
    return this.jobStore.findById(jobId);
  }
}