import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';

import { StartScannerJobUseCase } from '../../application/use-cases/start-scanner-job.use-case.js';
import { GetScannerJobUseCase } from '../../application/use-cases/get-scanner-job.use-case.js';
import type { SpotfireCatalog } from '../../domain/entities/spotfire-catalog.js';
import { environment } from '../../infrastructure/config/env.js';
import { InMemoryJobStore } from '../../infrastructure/runtime/in-memory-job-store.js';
import { InMemorySpotfireCatalogStore } from '../../infrastructure/runtime/in-memory-spotfire-catalog-store.js';
import { PuppeteerSpotfireAutomation } from '../../infrastructure/spotfire/puppeteer-spotfire-automation.js';

const createExecutionSchema = z.object({
  analysisTab: z.string().trim().min(1).optional(),
  reportTitle: z.string().optional(),
  tableTitle: z.string().trim().min(1).optional(),
});

export async function createServer() {
  const server = Fastify({ logger: true });
  const jobStore = new InMemoryJobStore();
  const catalogStore = new InMemorySpotfireCatalogStore(environment.spotfire.defaultReportTitle);
  const automation = new PuppeteerSpotfireAutomation(environment);
  const startScannerJob = new StartScannerJobUseCase(automation, jobStore);
  const getScannerJob = new GetScannerJobUseCase(jobStore);

  await server.register(cors, {
    origin: true,
  });

  server.decorate('config', {
    port: environment.port,
  });

  server.decorate('getSpotfireCatalog', () => catalogStore.get());
  server.decorate('warmupSpotfireCatalog', async () => {
    server.log.info({
      reportTitle: environment.spotfire.defaultReportTitle,
    }, 'starting Spotfire catalog warmup');

    catalogStore.set({
      status: 'loading',
      reportTitle: environment.spotfire.defaultReportTitle,
      filters: [],
      availableTabs: [],
      availableTables: [],
    });

    try {
      const catalog = await automation.runExtraction({
        reportTitle: environment.spotfire.defaultReportTitle,
      });

      catalogStore.set({
        status: 'ready',
        reportTitle: environment.spotfire.defaultReportTitle,
        filters: catalog.filters,
        availableTabs: catalog.availableTabs,
        availableTables: catalog.availableTables,
        updatedAt: new Date().toISOString(),
      });

      server.log.info({
        reportTitle: environment.spotfire.defaultReportTitle,
        tabCount: catalog.availableTabs.length,
        tabs: catalog.availableTabs,
        tableCount: catalog.availableTables.length,
        tables: catalog.availableTables,
        filterCount: catalog.filters.length,
        filters: catalog.filters.map((filter) => ({
          title: filter.title,
          kind: filter.kind,
          selectedValues: filter.selectedValues,
          optionCount: filter.options?.length ?? 0,
        })),
      }, 'Spotfire catalog warmup completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown catalog warmup error';

      catalogStore.set({
        status: 'failed',
        reportTitle: environment.spotfire.defaultReportTitle,
        filters: [],
        availableTabs: [],
        availableTables: [],
        updatedAt: new Date().toISOString(),
        errorMessage: message,
      });

      server.log.error({
        reportTitle: environment.spotfire.defaultReportTitle,
        errorMessage: message,
      }, 'Spotfire catalog warmup failed');

      throw error;
    }
  });

  server.get('/api/health', async () => ({
    status: 'ok',
    reportTitle: environment.spotfire.defaultReportTitle,
    catalogStatus: server.getSpotfireCatalog().status,
  }));

  server.get('/api/scanner/catalog', async () => server.getSpotfireCatalog());

  server.post('/api/scanner/executions', async (request, reply) => {
    const payload = createExecutionSchema.parse(request.body);
    const job = await startScannerJob.execute(payload);
    return reply.code(202).send(job);
  });

  server.get('/api/scanner/executions/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = await getScannerJob.execute(params.jobId);

    if (!job) {
      return reply.code(404).send({ message: 'job not found' });
    }

    return reply.send(job);
  });

  server.get('/api/scanner/executions/:jobId/export', async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = await getScannerJob.execute(params.jobId);

    if (!job?.exportFilePath) {
      return reply.code(404).send({ message: 'export not available for this job' });
    }

    try {
      await access(job.exportFilePath);
    } catch {
      return reply.code(404).send({ message: 'export file not found' });
    }

    const extension = extname(job.exportFilePath).toLowerCase();
    const fileName = basename(job.exportFilePath);
    const contentType = extension === '.csv' || extension === '.txt'
      ? 'text/csv; charset=utf-8'
      : 'application/octet-stream';

    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    reply.type(contentType);

    return reply.send(createReadStream(job.exportFilePath));
  });

  server.get('/api/scanner/filters/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = await getScannerJob.execute(params.jobId);

    if (!job) {
      return reply.code(404).send({ message: 'job not found' });
    }

    return reply.send({
      jobId: job.id,
      status: job.status,
      filters: job.filters,
      availableTabs: job.availableTabs,
      availableTables: job.availableTables,
      exportFilePath: job.exportFilePath,
    });
  });

  return server;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: {
      port: number;
    };
    getSpotfireCatalog: () => SpotfireCatalog;
    warmupSpotfireCatalog: () => Promise<void>;
  }
}