// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import type { ScannerJob } from '../entities/scanner-job.js';

export interface ScannerJobStorePort {
  create(job: ScannerJob): Promise<void>;
  update(job: ScannerJob): Promise<void>;
  findById(id: string): Promise<ScannerJob | null>;
}