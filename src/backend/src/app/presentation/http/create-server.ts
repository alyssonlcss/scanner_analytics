import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

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

const filterSchema = z.object({
  title: z.string().trim().min(1),
  kind: z.enum(['list', 'range', 'text', 'toggle-group', 'unknown']),
  selectedValues: z.array(z.string()).default([]),
  options: z.array(z.object({
    label: z.string(),
    selected: z.boolean(),
  })).optional(),
  range: z.object({
    min: z.string(),
    max: z.string(),
    selectedMin: z.string(),
    selectedMax: z.string(),
  }).optional(),
  textValue: z.string().optional(),
});

const createExecutionSchema = z.object({
  analysisTab: z.string().trim().min(1).optional(),
  reportTitle: z.string().optional(),
  tableTitle: z.string().trim().min(1).optional(),
  selectedFilters: z.array(filterSchema).optional(),
});

const dataDownloadSchema = z.object({
  reportTitle: z.string().trim().min(1).optional(),
  selectedFilters: z.array(filterSchema).optional(),
  periodSelection: z.object({
    year: z.union([z.string().trim(), z.array(z.string().trim())]).optional(),
    month: z.union([z.string().trim(), z.array(z.string().trim())]).optional(),
    dayRange: z.object({
      min: z.number().int().min(1),
      max: z.number().int().min(1),
    }).optional(),
  }).optional(),
});

const DATA_DOWNLOAD_TARGETS = [
  {
    analysisTab: 'Tab Completa',
    tableTitle: 'Tabela Completa todas Colunas',
  },
  {
    analysisTab: 'Ranking',
    tableTitle: 'Detalhamento Diário',
  },
] as const;

export async function createServer() {
  const server = Fastify({ logger: true });
  const jobStore = new InMemoryJobStore();
  const catalogStore = new InMemorySpotfireCatalogStore(environment.spotfire.defaultReportTitle);
  const automation = new PuppeteerSpotfireAutomation(environment);
  const startScannerJob = new StartScannerJobUseCase(automation, jobStore);
  const getScannerJob = new GetScannerJobUseCase(jobStore);
  let activeDataDownloadController: AbortController | null = null;

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
      await automation.prepareSession(environment.spotfire.defaultReportTitle);

      catalogStore.set({
        status: 'ready',
        reportTitle: environment.spotfire.defaultReportTitle,
        filters: [],
        availableTabs: [],
        availableTables: [],
        updatedAt: new Date().toISOString(),
      });

      server.log.info({
        reportTitle: environment.spotfire.defaultReportTitle,
      }, 'Spotfire session warmup completed without metadata collection');
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

  server.get('/api/scanner/catalog', async () => {
    return server.getSpotfireCatalog();
  });

  server.post('/api/scanner/executions', async (request, reply) => {
    const payload = createExecutionSchema.parse(request.body);
    const job = await startScannerJob.execute(payload);
    return reply.code(202).send(job);
  });

  server.post('/api/scanner/data-download', async (request, reply) => {
    const payload = dataDownloadSchema.parse(request.body);
    const reportTitle = payload.reportTitle ?? environment.spotfire.defaultReportTitle;
    const dataDirectory = resolve(process.cwd(), environment.spotfire.outputDirectory);
    const controller = new AbortController();

    activeDataDownloadController?.abort(createAbortError('data download superseded by a newer request'));
    activeDataDownloadController = controller;

    request.raw.once('aborted', () => {
      if (activeDataDownloadController === controller) {
        controller.abort(createAbortError('client disconnected during data download'));
      }
    });

    try {
      throwIfAborted(controller.signal);
      await resetDataDirectory(dataDirectory);

      const downloadedFiles: Array<{
        analysisTab: string;
        tableTitle: string;
        fileName: string;
        filePath: string;
      }> = [];

      let latestCatalog: SpotfireCatalog | null = null;

      for (const target of DATA_DOWNLOAD_TARGETS) {
        throwIfAborted(controller.signal);

        const result = await automation.runExtraction({
          reportTitle,
          analysisTab: target.analysisTab,
          tableTitle: target.tableTitle,
          selectedFilters: payload.selectedFilters,
          periodSelection: payload.periodSelection,
          signal: controller.signal,
        });

        throwIfAborted(controller.signal);

        if (!result.exportFilePath) {
          throw new Error(`export file was not generated for table: ${target.tableTitle}`);
        }

        const fileName = `${reportTitle} - ${target.tableTitle}.csv`;
        const filePath = await moveDownloadedFile(result.exportFilePath, dataDirectory, fileName);

        downloadedFiles.push({
          analysisTab: target.analysisTab,
          tableTitle: target.tableTitle,
          fileName,
          filePath,
        });

        latestCatalog = {
          status: 'ready',
          reportTitle,
          filters: result.filters,
          availableTabs: result.availableTabs,
          availableTables: result.availableTables,
          updatedAt: new Date().toISOString(),
        } satisfies SpotfireCatalog;
      }

      throwIfAborted(controller.signal);
      await cleanupDataDirectory(dataDirectory, downloadedFiles.map((file) => file.fileName));

      return reply.send({
        status: 'completed',
        reportTitle,
        updatedAt: new Date().toISOString(),
        files: downloadedFiles,
        filters: latestCatalog?.filters ?? [],
        availableTabs: latestCatalog?.availableTabs ?? [],
        availableTables: latestCatalog?.availableTables ?? [],
      });
    } catch (error) {
      if (isAbortError(error)) {
        return reply.code(409).send({
          message: normalizeAbortMessage(error),
        });
      }

      throw error;
    } finally {
      if (activeDataDownloadController === controller) {
        activeDataDownloadController = null;
      }
    }
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

async function resetDataDirectory(dataDirectory: string): Promise<void> {
  await rm(dataDirectory, { recursive: true, force: true });
  await mkdir(dataDirectory, { recursive: true });
}

async function moveDownloadedFile(sourcePath: string, dataDirectory: string, targetFileName: string): Promise<string> {
  await mkdir(dataDirectory, { recursive: true });

  const targetPath = join(dataDirectory, targetFileName);
  await rm(targetPath, { force: true });
  await rename(sourcePath, targetPath);

  return targetPath;
}

async function cleanupDataDirectory(dataDirectory: string, preservedFileNames: string[]): Promise<void> {
  const preserved = new Set(preservedFileNames);
  const remainingEntries = await readdir(dataDirectory);

  for (const entry of remainingEntries) {
    if (!preserved.has(entry)) {
      const entryPath = join(dataDirectory, entry);
      await rm(entryPath, { recursive: true, force: true });
    }
  }
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw normalizeAbortError(signal.reason);
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') {
      return reason;
    }

    const error = new Error(reason.message);
    error.name = 'AbortError';
    return error;
  }

  return createAbortError(
    typeof reason === 'string' && reason.trim().length > 0
      ? reason
      : 'data download aborted',
  );
}

function normalizeAbortMessage(error: Error): string {
  return error.message.trim().length > 0 ? error.message : 'data download aborted';
}