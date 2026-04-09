import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';

import { StartScannerJobUseCase } from '../../application/use-cases/start-scanner-job.use-case.js';
import { GetScannerJobUseCase } from '../../application/use-cases/get-scanner-job.use-case.js';
import { environment } from '../../infrastructure/config/env.js';
import { InMemoryJobStore } from '../../infrastructure/runtime/in-memory-job-store.js';
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
    tableTitle: 'Deslocamentos',
  },
  {
    analysisTab: 'Ranking',
    tableTitle: 'Detalhamento Diário',
  },
] as const;

export async function createServer() {
  const server = Fastify({ logger: true });
  const jobStore = new InMemoryJobStore();
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

  server.get('/api/health', async () => ({
    status: 'ok',
    reportTitle: environment.spotfire.defaultReportTitle,
  }));

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

    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': request.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
    });

    const sendEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onProgress = (message: string) => {
      sendEvent('progress', { message });
    };

    try {
      throwIfAborted(controller.signal);
      onProgress('Preparando diretório de dados...');
      await resetDataDirectory(dataDirectory);

      const tableNames = DATA_DOWNLOAD_TARGETS.map(t => t.tableTitle).join(' e ');
      onProgress(`Baixando tabelas: ${tableNames}...`);

      server.log.info({ targetCount: DATA_DOWNLOAD_TARGETS.length, targets: DATA_DOWNLOAD_TARGETS }, 'starting data download for configured tables');

      const result = await automation.runExtraction({
        reportTitle,
        analysisTab: DATA_DOWNLOAD_TARGETS[0].analysisTab,
        tableTitle: DATA_DOWNLOAD_TARGETS[0].tableTitle,
        tablesToExport: DATA_DOWNLOAD_TARGETS.map(t => ({ tab: t.analysisTab, tableTitle: t.tableTitle })),
        selectedFilters: payload.selectedFilters,
        periodSelection: payload.periodSelection,
        signal: controller.signal,
        onProgress,
      });

      throwIfAborted(controller.signal);

      const allExportedFiles = result.exportedFiles ?? (result.exportFilePath ? [result.exportFilePath] : []);

      const downloadedFiles: Array<{
        analysisTab: string;
        tableTitle: string;
        fileName: string;
        filePath: string;
      }> = [];

      for (let i = 0; i < DATA_DOWNLOAD_TARGETS.length; i++) {
        const target = DATA_DOWNLOAD_TARGETS[i];
        const exportedFile = allExportedFiles[i];

        if (!exportedFile) {
          server.log.error({ tab: target.analysisTab, table: target.tableTitle }, 'export file was not generated');
          throw new Error(`export file was not generated for table: ${target.tableTitle}`);
        }

        const fileName = `${reportTitle} - ${target.tableTitle}.csv`;
        const filePath = await moveDownloadedFile(exportedFile, dataDirectory, fileName);

        server.log.info({ tab: target.analysisTab, table: target.tableTitle, fileName, filePath }, `table "${target.tableTitle}" moved successfully`);

        downloadedFiles.push({
          analysisTab: target.analysisTab,
          tableTitle: target.tableTitle,
          fileName,
          filePath,
        });
      }

      server.log.info({ downloadedCount: downloadedFiles.length, files: downloadedFiles.map(f => f.fileName) }, 'all tables downloaded successfully');
      onProgress('Todas as tabelas baixadas! Finalizando...');

      throwIfAborted(controller.signal);
      await cleanupDataDirectory(dataDirectory, downloadedFiles.map((file) => file.fileName));

      sendEvent('result', {
        status: 'completed',
        reportTitle,
        updatedAt: new Date().toISOString(),
        files: downloadedFiles,
        filters: result.filters ?? [],
        availableTabs: result.availableTabs ?? [],
        availableTables: result.availableTables ?? [],
      });

      reply.raw.end();
    } catch (error) {
      if (isAbortError(error)) {
        sendEvent('error', { message: normalizeAbortMessage(error) });
        reply.raw.end();
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'unknown error';
      sendEvent('error', { message: errorMessage });
      reply.raw.end();
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