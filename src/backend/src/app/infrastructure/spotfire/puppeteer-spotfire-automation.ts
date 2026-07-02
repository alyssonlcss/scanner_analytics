// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import puppeteer, { Browser, Page } from 'puppeteer';

import type { ScannerRunRequest } from '../../domain/entities/scanner-run-request.js';
import type { SpotfireFilter } from '../../domain/entities/spotfire-filter.js';
import type { ScannerAutomationPort, ScannerAutomationResult } from '../../domain/ports/scanner-automation.port.js';
import type { Environment } from '../config/env.js';

const DOWNLOAD_TIMEOUT_MS = 120000;
const DOWNLOAD_POLL_INTERVAL_MS = 500;
const DOWNLOAD_EXTENSIONS = new Set(['.csv', '.txt', '.xlsx', '.xls']);
const ALL_OPTION = 'All';
const MONTH_OPTIONS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export class PuppeteerSpotfireAutomation implements ScannerAutomationPort {
  /** Resolves when the current serialized task finishes (or was aborted). */
  private activeQueue: Promise<void> = Promise.resolve();
  /** AbortController for the currently-running serialized task. Aborted when a newer request arrives. */
  private activeTaskAbort?: AbortController;
  private persistentBrowser?: Browser;
  private persistentPage?: Page;

  private readonly verbose: boolean;

  public constructor(private readonly environment: Environment) {
    this.verbose = environment.spotfire.debug;
  }

  /** Essential log — always printed. Clean, concise output. */
  private info(message: string): void {
    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
    console.info('[spotfire]', ts, message);
  }

  /** Debug log — only printed when SPOTFIRE_DEBUG=true. */
  private log(message: string, details?: Record<string, unknown>): void {
    if (!this.verbose) return;

    const prefix = '[spotfire]';
    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });

    if (details) {
      console.info(prefix, ts, message, details);
      return;
    }

    console.info(prefix, ts, message);
  }

  /** Always-visible log — used for WARN/FAIL regardless of verbose mode. */
  private logAlways(message: string, details?: Record<string, unknown>): void {
    const prefix = '[spotfire]';
    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
    if (details) {
      console.info(prefix, ts, message, details);
    } else {
      console.info(prefix, ts, message);
    }
  }

  private stepTimers = new Map<string, number>();

  /** Debug step log — WARN/FAIL always print, START/OK only when SPOTFIRE_DEBUG=true. */
  private logStep(step: string, status: 'START' | 'OK' | 'WARN' | 'FAIL', message: string, details?: Record<string, unknown>): void {
    if (status === 'START') {
      this.stepTimers.set(step, Date.now());
    }

    const started = this.stepTimers.get(step);
    const elapsed = started ? `${((Date.now() - started) / 1000).toFixed(1)}s` : '';

    if (status !== 'START' && started) {
      this.stepTimers.delete(step);
    }

    // Always print warnings/failures; START/OK only in verbose mode
    if (!this.verbose && status !== 'WARN' && status !== 'FAIL') return;

    const suffix = elapsed && status !== 'START' ? ` (${elapsed})` : '';
    if (status === 'WARN' || status === 'FAIL') {
      this.logAlways(`[${status}] ${step} :: ${message}${suffix}`, details);
    } else {
      this.log(`[${status}] ${step} :: ${message}${suffix}`, details);
    }
  }

  private emitProgress(request: ScannerRunRequest, message: string): void {
    request.onProgress?.(message);
  }

  public async runExtraction(request: ScannerRunRequest): Promise<ScannerAutomationResult> {
    return this.runSerialized(async (combinedSignal) => {
      // Overlay the combined (external + supersede) signal so all inner raceAbort calls react.
      const req: ScannerRunRequest = { ...request, signal: combinedSignal };
      const outputDirectory = await this.raceAbort(this.prepareOutputDirectory(), req.signal);
      this.emitProgress(req, 'Iniciando extração de dados...');
      this.logStep('data-download', 'START', 'starting extraction run', {
        reportTitle: request.reportTitle ?? this.environment.spotfire.defaultReportTitle,
        analysisTab: request.analysisTab ?? null,
        tableTitle: request.tableTitle ?? null,
        headless: this.environment.spotfire.headless,
        keepOpen: this.environment.spotfire.keepOpen,
        outputDirectory,
      });

      // ── Full-extraction retry loop ─────────────────────────────────────────
      // If a filter or any step fails (non-abort), the session is disposed and
      // the entire data-download is restarted up to MAX_EXTRACTION_RETRIES times.
      const MAX_EXTRACTION_RETRIES = 2;
      let lastExtractionError: unknown;

      for (let extractionAttempt = 1; extractionAttempt <= MAX_EXTRACTION_RETRIES; extractionAttempt++) {
        this.throwIfAborted(req.signal);

        if (extractionAttempt > 1) {
          this.info(`[data-download] Reiniciando extração completa (tentativa ${extractionAttempt}/${MAX_EXTRACTION_RETRIES})...`);
          this.emitProgress(req, `Reiniciando extração (tentativa ${extractionAttempt}/${MAX_EXTRACTION_RETRIES})...`);
          // Brief pause before reopening the browser session
          await new Promise<void>((r) => setTimeout(r, 3000));
          this.throwIfAborted(req.signal);
        }

        const abortHandler = () => {
          if (this.isSupersededAbort(req.signal)) {
            this.logStep('data-download', 'WARN', 'extraction superseded by a newer request — keeping session alive for reuse');
            return;
          }
          this.logStep('data-download', 'WARN', 'aborting extraction run — disposing session');
          void this.disposeAutomationSession().catch(() => undefined);
        };

        req.signal?.addEventListener('abort', abortHandler, { once: true });

        const { browser, page, createdNewPage } = await this.raceAbort(this.getAutomationSession(), req.signal);
        const errorMonitor = this.startErrorPopupMonitor(page, req);

        let extractionResult: ScannerAutomationResult | undefined;

        try {
          this.throwIfAborted(req.signal);

          if (createdNewPage && !this.usesExternalBrowserConnection()) {
            this.emitProgress(req, 'Preparando navegador...');
            await this.raceAbort(page.setViewport({ width: 1600, height: 1000 }), req.signal);
            this.logStep('browser', 'OK', 'created new browser page for extraction run', {
              width: 1600,
              height: 1000,
            });
          }

          this.emitProgress(req, 'Abrindo análise no Spotfire...');
          await this.withSpotfireRecovery(page, async () => {
            await this.raceAbort(
              this.openAnalysis(page, req.reportTitle ?? this.environment.spotfire.defaultReportTitle),
              req.signal,
            );
          }, req);
          this.logStep('analysis', 'OK', 'opened Spotfire analysis URL and starting tab/filter/export actions', {
            currentUrl: page.url(),
          });

          this.emitProgress(req, 'Preparando visualização...');
          await this.withSpotfireRecovery(page, async () => {
            await this.raceAbort(this.ensureNoMaximizedVisualization(page), req.signal);

            if (req.analysisTab?.trim()) {
              this.emitProgress(req, `Abrindo aba "${req.analysisTab}"...`);
              await this.raceAbort(this.openAnalysisTab(page, req.analysisTab), req.signal);
            }

            await this.raceAbort(this.ensureNoMaximizedVisualization(page), req.signal);
          }, req);
          const { availableTabs, availableTables, filters } = await this.withSpotfireRecovery(page, async () => {
            this.emitProgress(req, 'Carregando filtros...');
            await this.raceAbort(this.ensureAllFiltersVisible(page), req.signal);

            if (!req.skipFilterReset) {
              this.info('Resetando filtros...');
              this.emitProgress(req, 'Resetando filtros...');
              await this.raceAbort(this.resetVisibleFilters(page), req.signal);
              await this.raceAbort(this.ensureAllFiltersVisible(page), req.signal);
            } else {
              this.log('skipping filter reset because skipFilterReset=true');
            }

            const availableTabs = await this.raceAbort(this.loadAvailableTabs(page), req.signal);
            this.emitProgress(req, 'Lendo tabelas disponíveis...');
            const availableTables = await this.raceAbort(this.loadAvailableTables(page), req.signal);
            this.emitProgress(req, 'Lendo estado dos filtros...');
            let filters = await this.raceAbort(this.readVisibleFilters(page), req.signal);

            this.logFiltersSummary(filters);

            const filtersToApply = this.buildFiltersToApply(filters, req);

            if (filtersToApply.length > 0) {
              this.info(`Aplicando ${filtersToApply.length} filtro(s): ${filtersToApply.map(f => f.title).join(', ')}`);
              this.emitProgress(req, `Aplicando ${filtersToApply.length} filtro(s)...`);
              await this.raceAbort(this.applySelectedFilters(page, filtersToApply, req), req.signal);
              await this.raceAbort(this.ensureAllFiltersVisible(page), req.signal);
              filters = await this.raceAbort(this.readVisibleFilters(page), req.signal);
              this.logFiltersSummary(filters);
            }

            return { availableTabs, availableTables, filters };
          }, req);

          // Apply Data Referência filter in right panel (LAST filter — after all left-panel filters)
          if (req.periodSelection?.dayRange || req.periodSelection?.monthDayRanges) {
            await this.withSpotfireRecovery(page, async () => {
              await this.raceAbort(
                this.applyDataReferenciaFilter(page, req.periodSelection!, req),
                req.signal,
              );
            }, req);
          }

          const exportedFiles: Array<string | undefined> = [];
          const MAX_TABLE_RETRIES = 2;

          // New multi-table export logic
          if (req.tablesToExport && req.tablesToExport.length > 0) {
            this.logStep('export', 'START', `starting multi-table export for ${req.tablesToExport.length} tables`);
            this.emitProgress(req, 'Preparando exportação das tabelas...');
            const totalTables = req.tablesToExport.length;

            for (let i = 0; i < totalTables; i++) {
              const tableConfig = req.tablesToExport[i];
              const label = `[${i + 1}/${totalTables}]`;
              this.logStep('export', 'START', `${label} exporting table "${tableConfig.tableTitle}" from tab "${tableConfig.tab}"`);

              let exportedFile: string | undefined;
              let lastError: string | undefined;

              for (let attempt = 1; attempt <= 1 + MAX_TABLE_RETRIES; attempt++) {
                try {
                  exportedFile = await this.exportSingleTableFromTab(
                    page, outputDirectory, req, tableConfig.tab, tableConfig.tableTitle, label,
                  );

                  if (exportedFile) {
                    this.logStep('export', 'OK', `${label} downloaded "${tableConfig.tableTitle}" -> ${exportedFile}`);
                    break;
                  }

                  // No file returned — treat as failure for retry
                  lastError = 'nenhum arquivo gerado pelo download';
                  this.info(`${label} Tabela "${tableConfig.tableTitle}" — download sem arquivo (tentativa ${attempt}/${1 + MAX_TABLE_RETRIES})`);
                } catch (err) {
                  lastError = err instanceof Error ? err.message : String(err);
                  this.info(`${label} Erro ao exportar "${tableConfig.tableTitle}" (tentativa ${attempt}/${1 + MAX_TABLE_RETRIES}): ${lastError}`);
                }

                if (attempt <= MAX_TABLE_RETRIES) {
                  this.info(`${label} Tentando novamente exportar "${tableConfig.tableTitle}"...`);
                  this.emitProgress(req, `${label} Tentando novamente exportar "${tableConfig.tableTitle}"...`);
                  await this.waitForSpotfireIdle(page);
                }
              }

              exportedFiles.push(exportedFile);
              if (!exportedFile) {
                this.info(`${label} Tabela "${tableConfig.tableTitle}" FALHOU após ${1 + MAX_TABLE_RETRIES} tentativas ✗`);
                this.emitProgress(req, `${label} Tabela "${tableConfig.tableTitle}" não pôde ser baixada — pulando`);
              }
            }

            const successCount = exportedFiles.filter(Boolean).length;
            this.info(`Exportação: ${successCount}/${totalTables} tabelas baixadas${successCount === totalTables ? ' ✓' : ''}`);
            this.logStep('export', 'OK', `multi-table export completed: ${successCount}/${totalTables} files downloaded`);
          } else {
            this.logStep('export', 'WARN', 'no tables configured for export (check SPOTFIRE_DOWNLOAD_TABLES env var)');
          }

          const successFiles = exportedFiles.filter((f): f is string => Boolean(f));
          this.log(`export summary: ${successFiles.length} files downloaded`, { exportedFiles });

          extractionResult = {
            filters,
            availableTabs,
            availableTables,
            exportFilePath: exportedFiles.find(Boolean),
            exportedFiles,
          };
        } catch (err) {
          lastExtractionError = err;

          // Abort errors are never retried — propagate immediately
          if ((err instanceof Error && err.name === 'AbortError') || req.signal?.aborted) {
            throw err;
          }

          if (extractionAttempt < MAX_EXTRACTION_RETRIES) {
            this.info(
              `[data-download] Extração falhou na tentativa ${extractionAttempt}/${MAX_EXTRACTION_RETRIES}: ` +
              `${err instanceof Error ? err.message : String(err)} — encerrando sessão e reiniciando...`,
            );
            this.logStep('data-download', 'WARN', `attempt ${extractionAttempt} failed — will retry full data-download`, {
              error: err instanceof Error ? err.message : String(err),
              extractionAttempt,
            });
          }
        } finally {
          errorMonitor.stop();
          req.signal?.removeEventListener('abort', abortHandler);

          if (extractionResult !== undefined && this.environment.spotfire.keepOpen) {
            this.logStep('browser', 'OK', 'keeping browser and page open because keepOpen=true');
          } else if (this.isSupersededAbort(req.signal)) {
            this.logStep('browser', 'OK', 'keeping browser and page open because job was superseded — next job will reuse this session');
          } else {
            const reason = extractionResult !== undefined
              ? 'closing browser because keepOpen=false'
              : `closing browser after failed extraction attempt ${extractionAttempt}`;
            this.logStep('browser', 'WARN', reason);
            await this.disposeAutomationSession().catch(() => undefined);
          }
        }

        if (extractionResult !== undefined) {
          return extractionResult;
        }
        // extractionResult is undefined → error was non-abort, loop continues
      }

      // All retries exhausted
      throw lastExtractionError instanceof Error
        ? lastExtractionError
        : new Error('runExtraction exhausted all retries');
    }, request.signal);
  }

  private logFiltersSummary(filters: SpotfireFilter[]): void {
    const summaries = filters.map((filter) => ({
      title: filter.title,
      kind: filter.kind,
      selectedValues: filter.selectedValues,
      optionCount: filter.options?.length ?? 0,
      sampleOptions: filter.options?.slice(0, 5).map((option) => option.label) ?? [],
      textValue: filter.textValue ?? null,
      range: filter.range
        ? {
          min: filter.range.min,
          max: filter.range.max,
          selectedMin: filter.range.selectedMin,
          selectedMax: filter.range.selectedMax,
        }
        : null,
    }));

    this.log('collected filters from right panel', {
      count: filters.length,
      filters: summaries,
    });
  }

  private async applySelectedFilters(page: Page, filters: SpotfireFilter[], req?: ScannerRunRequest): Promise<void> {
    this.log('applying selected filters from request (sequential with validation)', {
      count: filters.length,
      order: filters.map((f) => f.title),
      filters: filters.map((filter) => ({
        title: filter.title,
        kind: filter.kind,
        selectedValues: filter.selectedValues,
        textValue: filter.textValue ?? null,
        range: filter.range
          ? { selectedMin: filter.range.selectedMin, selectedMax: filter.range.selectedMax }
          : null,
      })),
    });

    const appliedFilters: string[] = [];
    const failedFilters: Array<{ title: string; reason: string }> = [];

    for (let filterIndex = 0; filterIndex < filters.length; filterIndex += 1) {
      const filter = filters[filterIndex];

      if (!this.hasRequestedFilterValue(filter)) {
        this.log('skipping filter without requested value', { title: filter.title, filterIndex });
        continue;
      }

      this.logStep('filter-sequence', 'START', `starting filter ${filterIndex + 1}/${filters.length}`, {
        title: filter.title,
        kind: filter.kind,
        selectedValues: filter.selectedValues,
        previouslyApplied: appliedFilters,
      });

      let result: { applied: boolean; reason: string } = { applied: false, reason: 'not attempted' };
      let lastAttemptReason = 'not attempted';
      const MAX_FILTER_RETRIES = 2;

      // Outer retry loop: each retry re-locates and re-applies the filter from scratch.
      // On the last outer round we also reset all filters before retrying.
      for (let retryRound = 0; retryRound <= MAX_FILTER_RETRIES; retryRound += 1) {
        if (retryRound > 0) {
          if (retryRound === MAX_FILTER_RETRIES) {
            // Last round: full reset before retrying to clear any stale filter state
            this.info(`Filtro "${filter.title}" — resetando filtros e tentando novamente (round ${retryRound}/${MAX_FILTER_RETRIES})...`);
            await this.resetVisibleFilters(page);
            await this.ensureAllFiltersVisible(page);
            // Re-apply all previously confirmed filters so the state is consistent
            for (const prevTitle of appliedFilters) {
              const prevFilter = filters.find((f) => f.title === prevTitle);
              if (prevFilter) {
                await this.waitForSpotfireIdle(page);
                await this.applySingleFilter(page, prevFilter);
              }
            }
          } else {
            this.info(`Filtro "${filter.title}" — nova tentativa (round ${retryRound}/${MAX_FILTER_RETRIES})...`);
          }
          await this.waitForSpotfireIdle(page);
          await this.ensureAllFiltersVisible(page);
        }

        // Inner retry: 3 quick attempts per round
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          result = await this.applySingleFilter(page, filter);
          lastAttemptReason = result.reason;

          this.log('filter application attempt result', {
            title: filter.title,
            kind: filter.kind,
            retryRound,
            attempt,
            result,
          });

          if (result.applied) {
            break;
          }

          await this.waitForSpotfireIdle(page);
        }

        if (!result.applied) {
          continue; // go to next outer round
        }

        // ── Post-apply verification ──────────────────────────────────────────
        // Read back the actual filter state and confirm the value was accepted.
        const MAX_VERIFY_RETRIES = 2;
        let verified = false;
        let verifyReason = 'not checked';

        for (let verifyAttempt = 1; verifyAttempt <= MAX_VERIFY_RETRIES; verifyAttempt += 1) {
          await this.waitForSpotfireIdle(page);
          const check = await this.verifyFilterApplied(page, filter);
          verifyReason = check.reason;

          this.log('post-apply filter verification', {
            title: filter.title,
            verifyAttempt,
            match: check.match,
            reason: check.reason,
            actual: check.actual ?? null,
          });

          if (check.match) {
            verified = true;
            break;
          }

          if (verifyAttempt < MAX_VERIFY_RETRIES) {
            this.info(`Filtro "${filter.title}" — verificação falhou (tentativa ${verifyAttempt}/${MAX_VERIFY_RETRIES}): ${check.reason}. Reaplicando...`);
            // Re-apply and try verification again
            await this.applySingleFilter(page, filter);
          }
        }

        if (verified) {
          break; // outer retry loop done for this filter
        }

        // Verification failed — treat as not applied and go to next outer round
        result = { applied: false, reason: `verification failed: ${verifyReason}` };
        lastAttemptReason = result.reason;
        this.info(`Filtro "${filter.title}" — verificação não confirmada após ${MAX_VERIFY_RETRIES} tentativas: ${verifyReason}`);
      }

      if (!result.applied) {
        const expectedLabel = (filter.selectedValues ?? []).join(', ') || filter.textValue || '';
        this.info(`Filtro "${filter.title}" [${filterIndex + 1}/${filters.length}]: esperado=[${expectedLabel}] → FALHOU: ${lastAttemptReason} ✗`);

        this.logStep('filter-sequence', 'FAIL', `filter validation FAILED - stopping sequence`, {
          title: filter.title,
          reason: lastAttemptReason,
          filterIndex,
          appliedFilters,
          remainingFilters: filters.slice(filterIndex + 1).map((f) => f.title),
        });

        failedFilters.push({ title: filter.title, reason: lastAttemptReason });

        throw new Error(
          `Filter "${filter.title}" failed validation after 3×${1 + MAX_FILTER_RETRIES} attempts: ${lastAttemptReason}. ` +
          `Applied filters: [${appliedFilters.join(', ')}]. Stopping filter sequence.`
        );
      }

      appliedFilters.push(filter.title);

      const expectedLabel = (filter.selectedValues ?? []).join(', ') || filter.textValue || '';
      this.info(`Filtro "${filter.title}" [${filterIndex + 1}/${filters.length}]: esperado=[${expectedLabel}] → aplicado ✓`);
      if (req) {
        this.emitProgress(req, `✓ Filtro "${filter.title}": [${expectedLabel || '—'}]`);
      }

      this.logStep('filter-sequence', 'OK', `filter ${filterIndex + 1}/${filters.length} validated - proceeding to next`, {
        title: filter.title,
        appliedFilters,
        remainingFilters: filters.slice(filterIndex + 1).map((f) => f.title),
      });

      await this.waitForSpotfireIdle(page);
    }

    this.logStep('filter-sequence', 'OK', 'all filters applied and validated successfully', {
      totalFilters: filters.length,
      appliedFilters,
    });

    await this.waitForSpotfireIdle(page);
  }

  private async applySingleFilterWithRetry(page: Page, filter: SpotfireFilter): Promise<{ applied: boolean; reason: string; attempts: number }> {
    if (!this.hasRequestedFilterValue(filter)) {
      return { applied: true, reason: 'no requested value', attempts: 0 };
    }

    let result: { applied: boolean; reason: string } = { applied: false, reason: 'not attempted' };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      result = await this.applySingleFilter(page, filter);

      this.log('filter application result', {
        title: filter.title,
        kind: filter.kind,
        attempt,
        result,
      });

      if (result.applied) {
        return { applied: true, reason: result.reason, attempts: attempt };
      }

      await this.waitForSpotfireIdle(page);
    }

    return { applied: false, reason: result.reason, attempts: 3 };
  }

  private async applySingleFilter(page: Page, filter: SpotfireFilter): Promise<{ applied: boolean; reason: string }> {
    const hostInspectionBeforeLocate = await this.inspectFilterHost(page, filter.title);
    this.log('filter host inspection before locate', {
      filterTitle: filter.title,
      filterKind: filter.kind,
      expectedHost: this.getExpectedFilterHost(filter.title),
      resolvedHost: hostInspectionBeforeLocate.resolvedHost,
      matchedTitle: hostInspectionBeforeLocate.matchedTitle,
      panelMatch: hostInspectionBeforeLocate.panelMatch,
      leftVisualMatch: hostInspectionBeforeLocate.leftVisualMatch,
    });

    const found = await this.locateFilterElement(page, filter.title);

    const hostInspectionAfterLocate = await this.inspectFilterHost(page, filter.title);
    this.log('filter host inspection after locate', {
      filterTitle: filter.title,
      filterKind: filter.kind,
      expectedHost: this.getExpectedFilterHost(filter.title),
      found,
      resolvedHost: hostInspectionAfterLocate.resolvedHost,
      matchedTitle: hostInspectionAfterLocate.matchedTitle,
      panelMatch: hostInspectionAfterLocate.panelMatch,
      leftVisualMatch: hostInspectionAfterLocate.leftVisualMatch,
    });

    if (!found) {
      return { applied: false, reason: 'filter not found in DOM' };
    }

    switch (filter.kind) {
      case 'text':
        return this.applyTextFilterPhysical(page, filter.title, filter.textValue?.trim() ?? '');
      case 'list':
        return this.applyListFilterPhysical(page, filter.title, filter.selectedValues ?? []);
      case 'toggle-group':
        return this.applyToggleGroupPhysical(page, filter.title, filter.selectedValues ?? []);
      case 'range':
        return this.applyRangeFilterPhysical(page, filter.title, filter.range);
      default:
        return { applied: false, reason: `unsupported filter kind: ${filter.kind}` };
    }
  }

  private normalizeForCompare(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  private getExpectedFilterHost(filterTitle: string): 'right-panel' | 'left-filtros' {
    void filterTitle;
    return 'left-filtros';
  }

  private async inspectFilterHost(page: Page, filterTitle: string): Promise<{
    resolvedHost: 'right-panel' | 'left-filtros' | null;
    matchedTitle: string | null;
    panelMatch: boolean;
    leftVisualMatch: boolean;
  }> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const wanted = trimColon(title);

      const filtersVisual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
        const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
          ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
        return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
      }) ?? null;

      let leftFilter: HTMLElement | null = null;

      if (filtersVisual) {
        for (const control of Array.from(filtersVisual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
          const paragraph = control.closest('p');
          const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
          if (trimColon(labelParagraph?.textContent) === wanted) {
            leftFilter = control;
            break;
          }
        }
      }

      const resolvedHost: 'right-panel' | 'left-filtros' | null = leftFilter ? 'left-filtros' : null;
      const matchedTitle = leftFilter
        ? ((leftFilter.closest('p')?.previousElementSibling?.textContent ?? '').trim() || null)
        : null;

      return {
        resolvedHost,
        matchedTitle,
        panelMatch: false,
        leftVisualMatch: leftFilter !== null,
      };
    }, filterTitle);
  }

  private async locateFilterElement(page: Page, filterTitle: string): Promise<boolean> {
    return page.evaluate(async (title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      async function wait(ms: number): Promise<void> {
        await new Promise((r) => setTimeout(r, ms));
      }

      function findTextAreaFilter(): HTMLElement | null {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (!visual) {
          return null;
        }

        const wanted = trimColon(title);
        for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
          const paragraph = control.closest('p');
          const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
          if (trimColon(labelParagraph?.textContent) === wanted) {
            return control;
          }
        }

        return null;
      }

      function find(): HTMLElement | null {
        return findTextAreaFilter();
      }

      let el = find();
      if (el) {
        el.scrollIntoView({ block: 'center' });
        return true;
      }
      return false;
    }, filterTitle);
  }

  /**
   * Lightweight read of ONLY the currently rendered (virtualized) filters.
   * Does not scroll the filter panel or scroll inside listboxes.
   */
  private async readVisibleFilters(page: Page): Promise<SpotfireFilter[]> {
    await page.waitForSelector('span.sf-element-filter-content.sf-element-filter-title[title], .HtmlTextAreaControl.sf-element-filter-content', {
      timeout: 60000,
    });

    return page.evaluate(function () {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      function normalizeTitle(value: string | null | undefined): string {
        return normalize(value).replace(/:$/, '');
      }

      function extractFilter(filterElement: HTMLElement, explicitTitle?: string): SpotfireFilter | null {
        const titleElement = filterElement.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        const title = explicitTitle ? normalizeTitle(explicitTitle) : normalize(titleElement?.getAttribute('title') ?? titleElement?.textContent);

        if (!title) {
          return null;
        }

        const rangeLabels = Array.from(filterElement.querySelectorAll<HTMLElement>('.ValueLabel'))
          .map(function (label) { return normalize(label.getAttribute('title') ?? label.textContent); })
          .filter(function (value) { return value.length > 0; });

        if (rangeLabels.length >= 2) {
          return {
            title,
            kind: 'range',
            selectedValues: rangeLabels.slice(0, 2),
            range: {
              min: rangeLabels[0],
              max: rangeLabels[1],
              selectedMin: rangeLabels[0],
              selectedMax: rangeLabels[1],
            },
          };
        }

        const toggleOptions = Array.from(filterElement.querySelectorAll<HTMLElement>('.ColumnFilter .sf-element-filter-item'))
          .map(function (option) {
            const labelElement = option.querySelector<HTMLElement>('.sf-element-text-box');
            const checkbox = option.querySelector<HTMLElement>('.sf-element-check-box');
            return {
              label: normalize(labelElement?.getAttribute('title') ?? labelElement?.textContent),
              selected: checkbox?.classList.contains('sfpc-checked') ?? false,
            };
          })
          .filter(function (option) { return option.label.length > 0; });

        if (toggleOptions.length > 0) {
          return {
            title,
            kind: 'toggle-group',
            selectedValues: toggleOptions.filter(function (o) { return o.selected; }).map(function (o) { return o.label; }),
            options: toggleOptions,
          };
        }

        const listItems = Array.from(filterElement.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
          .map(function (item) {
            return {
              label: normalize(item.getAttribute('title') ?? item.textContent),
              selected: item.classList.contains('sfpc-selected'),
            };
          })
          .filter(function (item) { return item.label.length > 0; });

        if (listItems.length > 0 || filterElement.querySelector('.VirtualListBox, .ListContainer, .sf-element-list-box-item') !== null) {
          return {
            title,
            kind: 'list',
            selectedValues: listItems.filter(function (o) { return o.selected; }).map(function (o) { return o.label; }),
            options: listItems,
          };
        }

        const textInput = filterElement.querySelector<HTMLInputElement>('input[placeholder*="Type to filter by text"], input.SearchInput');
        if (textInput) {
          const textValue = normalize(textInput.value);
          return {
            title,
            kind: 'text',
            selectedValues: textValue ? [textValue] : [],
            textValue,
          };
        }

        return {
          title,
          kind: 'unknown',
          selectedValues: [],
        };
      }

      const collected: SpotfireFilter[] = [];
      const seen = new Set<string>();

      const filtersVisual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
        const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
          ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
        return normalizeTitle(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'Filtros';
      });

      if (filtersVisual) {
        for (const control of Array.from(filtersVisual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
          const paragraph = control.closest('p');
          const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
          const title = normalizeTitle(labelParagraph?.textContent);
          if (!title || seen.has(title)) continue;
          const extracted = extractFilter(control, title);
          if (!extracted) continue;
          seen.add(extracted.title);
          collected.push(extracted);
        }
      }

      return collected;
    });
  }

  private async getFilterTitleCoords(page: Page, filterTitle: string): Promise<{ x: number; y: number } | null> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const t = trimColon(title);
      const isReferenceFilter = t === 'data referencia';

      const panelFilter = isReferenceFilter
        ? Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null
        : null;

      let titleEl: HTMLElement | null = null;

      if (panelFilter) {
        titleEl = panelFilter.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]')
          ?? panelFilter.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title');
      } else {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (visual) {
          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              titleEl = labelParagraph;
              break;
            }
          }
        }
      }

      if (!titleEl) {
        return null;
      }

      titleEl.scrollIntoView({ block: 'center' });
      const r = titleEl.getBoundingClientRect();

      if (r.width === 0 || r.height === 0) {
        return null;
      }

      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, filterTitle);
  }

  private async getFilterBodyActivationCoords(page: Page, filterTitle: string): Promise<{ x: number; y: number } | null> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const t = trimColon(title);
      const isReferenceFilter = t === 'data referencia';

      let filterEl = isReferenceFilter
        ? Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null
        : null;

      let titleEl: HTMLElement | null = null;

      if (filterEl) {
        titleEl = filterEl.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]')
          ?? filterEl.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title');
      } else {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (visual) {
          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              filterEl = control;
              titleEl = labelParagraph;
              break;
            }
          }
        }
      }

      if (!filterEl || !titleEl) {
        return null;
      }

      filterEl.scrollIntoView({ block: 'center' });

      const titleRect = titleEl.getBoundingClientRect();
      const filterRect = filterEl.getBoundingClientRect();

      if (titleRect.width === 0 || titleRect.height === 0 || filterRect.width === 0 || filterRect.height === 0) {
        return null;
      }

      const x = Math.round(titleRect.left + Math.min(18, Math.max(8, titleRect.width * 0.1)));
      const y = Math.round(Math.min(filterRect.bottom - 8, titleRect.bottom + Math.max(10, titleRect.height * 0.9)));

      return { x, y };
    }, filterTitle);
  }

  private async activateFilter(page: Page, filterTitle: string, clickCount: number = 1): Promise<void> {
    const titleCoords = await this.getFilterTitleCoords(page, filterTitle);
    if (!titleCoords) {
      return;
    }

    await page.mouse.click(titleCoords.x, titleCoords.y, { clickCount });
    await new Promise((r) => setTimeout(r, 150));
  }

  private async activateListFilter(page: Page, filterTitle: string): Promise<void> {
    // Click on the TITLE of the filter (not on list items) to activate it.
    // This focuses the filter for interaction without toggling any selections.
    const titleCoords = await this.getFilterTitleCoords(page, filterTitle);
    if (titleCoords) {
      await page.mouse.click(titleCoords.x, titleCoords.y, { clickCount: 2 });
      await new Promise((r) => setTimeout(r, 120));
      await page.mouse.click(titleCoords.x, titleCoords.y);
      await new Promise((r) => setTimeout(r, 150));
      return;
    }

    // Fallback: use activateFilter
    await this.activateFilter(page, filterTitle, 2);
    await this.activateFilter(page, filterTitle, 1);
  }

  private async findListItemCoords(
    page: Page,
    filterTitle: string,
    itemLabel: string,
  ): Promise<{
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
    clickX: number;
    clickY: number;
    selected: boolean;
    label: string;
    labelX?: number;
    labelY?: number;
    checkboxX?: number;
    checkboxY?: number;
  } | null> {
    return page.evaluate(async (args: { title: string; label: string }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      async function wait(ms: number): Promise<void> {
        await new Promise((r) => setTimeout(r, ms));
      }

      function matchLabel(candidate: string, requested: string): boolean {
        if (requested === '(all)') {
          return candidate.startsWith('(all)');
        }

        if (candidate === requested) {
          return true;
        }

        return false;
      }

      const t = trimColon(args.title);

      const isReferenceFilter = t === 'data referencia';
      let filterEl = isReferenceFilter
        ? Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null
        : null;

      if (!filterEl && !isReferenceFilter) {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (visual) {
          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              filterEl = control;
              break;
            }
          }
        }
      }

      if (!filterEl) {
        return null;
      }

      const reqLabel = nc(args.label);
      const sc = filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.ListContainer .sf-element-list-box')
        ?? filterEl.querySelector<HTMLElement>('.StyledScrollbar.ListContainerScroll .sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable');

      const listItems = filterEl.querySelector<HTMLElement>('.ListItems');
      const scrollArea = filterEl.querySelector<HTMLElement>('.ScrollArea');

      function isElementVisibleInContainer(el: HTMLElement, container: HTMLElement | null): boolean {
        if (!container) return true;
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        return elRect.top >= containerRect.top - 5 && elRect.bottom <= containerRect.bottom + 5;
      }

      function findVisibleItemByTitle(): HTMLElement | null {
        const allItems = Array.from(filterEl!.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
        for (const item of allItems) {
          const itemTitle = (item.getAttribute('title') ?? '').trim();
          if (itemTitle === args.label && isElementVisibleInContainer(item, sc)) {
            return item;
          }
        }
        return null;
      }

      let item: HTMLElement | null = null;

      if (sc) {
        // Reset scroll to top
        sc.scrollTop = 0;
        if (listItems) {
          listItems.style.top = '0px';
        }
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(100);

        // Full sweep through the scroll range
        const itemHeight = 15;
        const containerHeight = sc.clientHeight || 60;
        const scrollAreaHeight = scrollArea?.scrollHeight || sc.scrollHeight || 200;
        const maxScroll = Math.max(scrollAreaHeight - containerHeight, 0);
        const step = itemHeight;

        item = findVisibleItemByTitle();
        
        for (let offset = 0; offset <= maxScroll + itemHeight && !item; offset += step) {
          sc.scrollTop = offset;
          if (listItems) {
            listItems.style.top = `-${offset}px`;
          }
          sc.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(80);
          item = findVisibleItemByTitle();
        }

        if (!item) {
          // Final attempt: scroll to very end
          sc.scrollTop = maxScroll;
          if (listItems) {
            listItems.style.top = `-${maxScroll}px`;
          }
          sc.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(100);
          item = findVisibleItemByTitle();
        }
      } else {
        item = findVisibleItemByTitle();
      }

      if (!item) {
        return null;
      }

      // Try to click the visible label text first (more reliable than clicking the row center)
      const labelEl = item.querySelector<HTMLElement>('.sf-element-text-box')
        ?? item.querySelector<HTMLElement>('.sf-element-list-box-item-text')
        ?? item.querySelector<HTMLElement>('[role="option"]');

      const checkbox = item.querySelector<HTMLElement>('.sf-element-check-box');
      const labelRect = labelEl?.getBoundingClientRect();
      const checkboxRect = checkbox?.getBoundingClientRect();

      const targetRect = (labelRect && labelRect.width > 0 && labelRect.height > 0)
        ? labelRect
        : (checkboxRect && checkboxRect.width > 0 && checkboxRect.height > 0)
          ? checkboxRect
          : item.getBoundingClientRect();

      const label = nc(item.getAttribute('title') ?? item.textContent);

      const ariaSelected = (item.getAttribute('aria-selected') ?? '').toLowerCase() === 'true';
      const ariaChecked = (item.getAttribute('aria-checked') ?? '').toLowerCase() === 'true';
      const classSelected = item.classList.contains('sfpc-selected')
        || item.classList.contains('sfpc-highlighted')
        || item.classList.contains('sfpc-active')
        || item.classList.contains('sfpc-checked');
      const checkboxChecked = checkbox?.classList.contains('sfpc-checked') ?? false;

      const selected = ariaSelected || ariaChecked || classSelected || checkboxChecked;

      return {
        x: Math.round(targetRect.left + targetRect.width / 2),
        y: Math.round(targetRect.top + targetRect.height / 2),
        left: Math.round(targetRect.left),
        top: Math.round(targetRect.top),
        width: Math.round(targetRect.width),
        height: Math.round(targetRect.height),
        // Clicking near the left side tends to hit the text reliably in Spotfire list items.
        clickX: Math.round(targetRect.left + Math.min(24, Math.max(8, targetRect.width * 0.25))),
        // Bias the click lower inside the row to avoid accidentally hitting the option above.
        clickY: Math.round(targetRect.top + Math.min(targetRect.height - 3, Math.max(targetRect.height * 0.72, targetRect.height / 2 + 3))),
        selected,
        label,
        labelX: labelRect && labelRect.width > 0 && labelRect.height > 0 ? Math.round(labelRect.left + labelRect.width / 2) : undefined,
        labelY: labelRect && labelRect.width > 0 && labelRect.height > 0
          ? Math.round(labelRect.top + Math.min(labelRect.height - 2, Math.max(labelRect.height * 0.72, labelRect.height / 2 + 2)))
          : undefined,
        checkboxX: checkboxRect && checkboxRect.width > 0 && checkboxRect.height > 0 ? Math.round(checkboxRect.left + checkboxRect.width / 2) : undefined,
        checkboxY: checkboxRect && checkboxRect.width > 0 && checkboxRect.height > 0
          ? Math.round(checkboxRect.top + Math.min(checkboxRect.height - 2, Math.max(checkboxRect.height * 0.72, checkboxRect.height / 2 + 2)))
          : undefined,
      };
    }, { title: filterTitle, label: itemLabel });
  }

  private async getSelectedListItems(page: Page, filterTitle: string): Promise<string[]> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const t = trimColon(title);
      const isReferenceFilter = t === 'data referencia';
      let filterEl = isReferenceFilter
        ? Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null
        : null;

      if (!filterEl && !isReferenceFilter) {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (visual) {
          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              filterEl = control;
              break;
            }
          }
        }
      }

      if (!filterEl) {
        return [];
      }

      return Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
        .filter((item) => {
          const checkbox = item.querySelector<HTMLElement>('.sf-element-check-box');
          return item.classList.contains('sfpc-selected') || (checkbox?.classList.contains('sfpc-checked') ?? false);
        })
        .map((item) => nc(item.getAttribute('title') ?? item.textContent))
        .filter((l) => l.length > 0 && !l.startsWith('(all)'));
    }, filterTitle);
  }

  private async applyListFilterPhysical(page: Page, filterTitle: string, selectedValues: string[]): Promise<{ applied: boolean; reason: string }> {
    const values = selectedValues.map((v) => v.replace(/\s+/g, ' ').trim()).filter((v) => v.length > 0);

    if (!values.length) {
      return { applied: true, reason: 'no values to select' };
    }

    const isAllSelect = values.some((v) => v.toLowerCase().startsWith('(all)'));
    const clickValues = isAllSelect ? ['(All)'] : values;
    const isSingleExplicitSelection = !isAllSelect && clickValues.length === 1;
    const filterHost = await this.inspectFilterHost(page, filterTitle);
    const normalizedFilterTitle = this.normalizeFilterName(filterTitle);

    if (this.usesScrollableListSelectionWorkflow(filterTitle)) {
      return this.applyScrollableListFilterPhysical(page, filterTitle, clickValues, isAllSelect);
    }

    const requiresSearchBeforeSelect = normalizedFilterTitle === 'ano' && !isAllSelect;
    const requiresScrollBeforeSelect = (normalizedFilterTitle === 'mes' || normalizedFilterTitle === 'base') && !isAllSelect;
    const requiresSingleClickSelection = (normalizedFilterTitle === 'mes' || normalizedFilterTitle === 'base') && !isAllSelect;
    const requiresExactDomSelection = normalizedFilterTitle === 'mes' && !isAllSelect;
    const requiresAtomicScrolledDomSelection = normalizedFilterTitle === 'mes' && !isAllSelect;

    if (filterHost.resolvedHost === 'right-panel' && normalizedFilterTitle === 'ano') {
      return this.applyRightPanelYearFilter(page, filterTitle, values, isAllSelect);
    }

    const readListFilterSummary = async (): Promise<{
      allRowLabel: string | null;
      imageTitle: string | null;
      filteredCount: number | null;
      totalCount: number | null;
    }> => {
      return page.evaluate((title: string) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }

        function trimColon(v: string | null | undefined): string {
          return nc(v).replace(/:$/, '');
        }

        function resolveFilterElement(): HTMLElement | null {
          const t = trimColon(title);
          const isReferenceFilter = t === 'data referencia';

          if (isReferenceFilter) {
            return Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
              const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
              return nc(el?.getAttribute('title') ?? el?.textContent) === t;
            }) ?? null;
          }

          const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
            const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
              ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
            return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
          });

          if (!visual) {
            return null;
          }

          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              return control;
            }
          }

          return null;
        }

        const filterEl = resolveFilterElement();

        if (!filterEl) {
          return { allRowLabel: null, imageTitle: null, filteredCount: null, totalCount: null };
        }

        const allRowLabel = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
          .map((item) => (item.getAttribute('title') ?? item.textContent ?? '').trim())
          .find((label) => label.toLowerCase().startsWith('(all)')) ?? null;

        const imageTitle = filterEl.querySelector<HTMLElement>('.Image')?.getAttribute('title') ?? null;

        function parseCounts(s: string | null): { filtered: number | null; total: number | null } {
          if (!s) return { filtered: null, total: null };
          const m = s.match(/(\d+)\s+of\s+(\d+)\s+values\s+filtered/i);
          if (m) return { filtered: Number(m[1]), total: Number(m[2]) };
          const m2 = s.match(/\(all\)\s*(\d+)\s*values?/i);
          if (m2) return { filtered: Number(m2[1]), total: null };
          return { filtered: null, total: null };
        }

        const fromImage = parseCounts(imageTitle);
        const fromAll = parseCounts(allRowLabel);

        return {
          allRowLabel,
          imageTitle,
          filteredCount: fromImage.filtered ?? fromAll.filtered,
          totalCount: fromImage.total ?? fromAll.total,
        };
      }, filterTitle);
    };

    const clearRightPanelSelections = async (): Promise<void> => {
      if (filterHost.resolvedHost !== 'right-panel' || isAllSelect) {
        return;
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const summary = await readListFilterSummary();
        const filteredCount = summary.filteredCount;

        if (filteredCount === null || filteredCount === 0) {
          return;
        }

        const cleared = await this.clickListItemDomFallback(page, filterTitle, '(All)', false);
        if (!cleared) {
          return;
        }

        await new Promise((r) => setTimeout(r, 250));
        await this.waitForSpotfireIdle(page, 8000);
      }
    };

    const summarySelectedLabels = (summary: {
      allRowLabel: string | null;
      imageTitle: string | null;
      filteredCount: number | null;
      totalCount: number | null;
    }): string[] => {
      const imageTitle = summary.imageTitle ?? '';
      const afterColon = imageTitle.includes(':') ? imageTitle.split(':').slice(1).join(':') : '';

      return afterColon
        .split(/[;,]/)
        .map((value) => this.normalizeForCompare(value))
        .filter((value) => value.length > 0);
    };

    const snapshotVisibleItems = async (): Promise<Array<{ label: string; className: string; ariaSelected: string | null; ariaChecked: string | null }>> => {
      return page.evaluate((title: string) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }

        function trimColon(v: string | null | undefined): string {
          return nc(v).replace(/:$/, '');
        }

        function resolveFilterElement(): HTMLElement | null {
          const t = trimColon(title);
          const isReferenceFilter = t === 'data referencia';

          if (isReferenceFilter) {
            return Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
              const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
              return nc(el?.getAttribute('title') ?? el?.textContent) === t;
            }) ?? null;
          }

          const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
            const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
              ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
            return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
          });

          if (!visual) {
            return null;
          }

          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              return control;
            }
          }

          return null;
        }

        const filterEl = resolveFilterElement();

        if (!filterEl) {
          return [];
        }

        return Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item')).slice(0, 12).map((item) => {
          return {
            label: nc(item.getAttribute('title') ?? item.textContent),
            className: item.className,
            ariaSelected: item.getAttribute('aria-selected'),
            ariaChecked: item.getAttribute('aria-checked'),
          };
        });
      }, filterTitle);
    };

    const clickValueWithFallbacks = async (
      searchTerm: string,
      allowCtrlFallback: boolean,
      useCtrlForPrimaryClick: boolean,
    ): Promise<boolean> => {
      if (requiresSearchBeforeSelect) {
        const inputPrepared = await this.setLeftFiltrosSearchInputValue(page, filterTitle, searchTerm);
        this.logStep('list-filter', inputPrepared ? 'OK' : 'WARN', 'prepared left-side search input before selecting list value', {
          filterTitle,
          searchTerm,
          inputPrepared,
        });

        if (!inputPrepared) {
          return false;
        }

        await new Promise((r) => setTimeout(r, 180));
      }

      // Re-locate the filter to ensure it's in the viewport
      await this.locateFilterElement(page, filterTitle);

      // Right-panel filters are sensitive to activation clicks and can clear the current selection.
      if (filterHost.resolvedHost !== 'right-panel') {
        await this.activateListFilter(page, filterTitle);
      }
      await new Promise((r) => setTimeout(r, 180));

      if (requiresScrollBeforeSelect) {
        const scrolled = await this.scrollListItemIntoView(page, filterTitle, searchTerm);
        this.logStep('list-filter', scrolled ? 'OK' : 'WARN', 'scrolled list to requested value before selection', {
          filterTitle,
          searchTerm,
          scrolled,
        });
        await new Promise((r) => setTimeout(r, 120));
      }

      let item = await this.findListItemCoords(page, filterTitle, searchTerm);

      if (!item) {
        this.logStep('list-filter', 'WARN', 'list item not found', { filterTitle, searchTerm });
        return false;
      }

      const mustReapplyExactBaseline = requiresAtomicScrolledDomSelection && !useCtrlForPrimaryClick;

      if (item.selected && !mustReapplyExactBaseline) {
        return true;
      }

      // Click near the left side (on top of the text) – this matches the user's manual interaction.
      const primaryX = item.labelX ?? item.clickX;
      const primaryY = item.labelY ?? item.clickY;

      if (filterHost.resolvedHost !== 'right-panel' && !requiresExactDomSelection) {
        await this.activateFilter(page, filterTitle);
      }

      const performMouseClick = async (): Promise<void> => {
        if (!useCtrlForPrimaryClick) {
          await page.mouse.click(primaryX, primaryY);
          return;
        }

        await page.keyboard.down('Control');
        await page.mouse.click(primaryX, primaryY);
        await page.keyboard.up('Control');
      };

      const performDomClick = async (): Promise<boolean> => {
        return this.clickListItemDomFallback(page, filterTitle, searchTerm, useCtrlForPrimaryClick);
      };

      const verifySelected = async (): Promise<boolean> => {
        const after = await this.findListItemCoords(page, filterTitle, searchTerm);
        if (after?.selected) {
          return true;
        }

        if (isSingleExplicitSelection) {
          const summary = await readListFilterSummary();
          if (summary.filteredCount === 1) {
            return true;
          }
        }

        return false;
      };

      if (filterHost.resolvedHost === 'right-panel') {
        const clickedViaDom = await performDomClick();
        if (clickedViaDom) {
          await new Promise((r) => setTimeout(r, 250));

          if (await verifySelected()) {
            return true;
          }
        }
      }

      if (requiresAtomicScrolledDomSelection) {
        const clickedViaDom = await this.scrollAndClickExactListItem(page, filterTitle, searchTerm, useCtrlForPrimaryClick);
        if (!clickedViaDom) {
          return false;
        }

        await new Promise((r) => setTimeout(r, 250));
        return verifySelected();
      }

      if (requiresExactDomSelection) {
        const clickedViaDom = await performDomClick();
        if (!clickedViaDom) {
          return false;
        }

        await new Promise((r) => setTimeout(r, 250));
        return verifySelected();
      }

      await performMouseClick();
      await new Promise((r) => setTimeout(r, 200));

      if (await verifySelected()) {
        return true;
      }

      if (requiresSingleClickSelection) {
        await this.waitForSpotfireIdle(page, 8000);
        await this.scrollListItemIntoView(page, filterTitle, searchTerm);
        return verifySelected();
      }

      const clickedViaDom = await performDomClick();
      if (clickedViaDom) {
        await new Promise((r) => setTimeout(r, 250));

        if (await verifySelected()) {
          return true;
        }
      }

      // Retry a second click (Spotfire sometimes ignores the first click when focus shifts)
      await performMouseClick();
      await new Promise((r) => setTimeout(r, 200));

      if (await verifySelected()) {
        return true;
      }

      // Ctrl+click fallback (multi-select listboxes)
      if (allowCtrlFallback) {
        await page.keyboard.down('Control');
        await page.mouse.click(primaryX, primaryY);
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 250));

        if (await verifySelected()) {
          return true;
        }

        const ctrlClickedViaDom = await this.clickListItemDomFallback(page, filterTitle, searchTerm, true);
        if (ctrlClickedViaDom) {
          await new Promise((r) => setTimeout(r, 250));

          if (await verifySelected()) {
            return true;
          }
        }
      }

      return false;
    };

    await clearRightPanelSelections();

    for (let i = 0; i < clickValues.length; i += 1) {
      const searchTerm = clickValues[i];
      const useCtrlForPrimaryClick = i > 0 && !isAllSelect;

      const ok = await clickValueWithFallbacks(searchTerm, i === 0, useCtrlForPrimaryClick);

      if (!ok) {
        this.logStep('list-filter', 'WARN', 'value click did not immediately verify as selected', {
          filterTitle,
          value: searchTerm,
        });
      }

      await this.waitForSpotfireIdle(page, 8000);
      await this.locateFilterElement(page, filterTitle);
    }

    if (requiresSearchBeforeSelect) {
      await this.setLeftFiltrosSearchInputValue(page, filterTitle, '');
      await new Promise((r) => setTimeout(r, 150));
    }

    await this.waitForSpotfireIdle(page);

    // NOTE: Spotfire listboxes are virtualized. Selected items may not be rendered,
    // so verifying by scanning only visible `.sf-element-list-box-item` can produce false negatives.
    // To verify reliably, we search each expected value and check its selected state.
    const expectedNorm = clickValues.map((v) => this.normalizeForCompare(v));
    const verifiedSelected: string[] = [];

    if (!isAllSelect) {
      for (const verifyValue of clickValues) {
        if (requiresSearchBeforeSelect) {
          await this.setLeftFiltrosSearchInputValue(page, filterTitle, verifyValue);
          await new Promise((r) => setTimeout(r, 120));
        }

        if (requiresScrollBeforeSelect) {
          await this.scrollListItemIntoView(page, filterTitle, verifyValue);
        }

        await this.locateFilterElement(page, filterTitle);
        if (filterHost.resolvedHost !== 'right-panel') {
          await this.activateFilter(page, filterTitle);
        }

        const item = await this.findListItemCoords(page, filterTitle, verifyValue);

        if (item?.selected) {
          verifiedSelected.push(item.label);
        }
      }

      if (requiresSearchBeforeSelect) {
        await this.setLeftFiltrosSearchInputValue(page, filterTitle, '');
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    const evaluateSelectionState = async (): Promise<{
      actualSelected: string[];
      summary: Awaited<ReturnType<typeof readListFilterSummary>>;
      summaryLabels: string[];
      allFound: boolean;
    }> => {
      const visibleSelected = await this.getSelectedListItems(page, filterTitle);
      const actualSelected = Array.from(new Set([...verifiedSelected, ...visibleSelected]));
      const summary = await readListFilterSummary();
      const summaryLabels = summarySelectedLabels(summary);
      const expectedCount = isAllSelect ? null : clickValues.length;
      const labelsMatchExpected = expectedNorm.every((exp) => actualSelected.some((act) => act.includes(exp) || exp.includes(act)));
      const summaryLabelsMatchExpected = summaryLabels.length > 0
        && expectedNorm.every((exp) => summaryLabels.some((act) => act.includes(exp) || exp.includes(act)));
      const countMatches = expectedCount !== null
        && summary.filteredCount !== null
        && summary.filteredCount === expectedCount
        && (!actualSelected.length || labelsMatchExpected || summaryLabelsMatchExpected);

      return {
        actualSelected,
        summary,
        summaryLabels,
        allFound: isAllSelect || labelsMatchExpected || summaryLabelsMatchExpected || countMatches,
      };
    };

    let { actualSelected, summary, summaryLabels, allFound } = await evaluateSelectionState();

    if (!allFound && normalizedFilterTitle === 'mes' && !isAllSelect) {
      const reconciled = await this.reconcileExactMonthSelection(page, filterTitle, clickValues);
      this.logStep('list-filter', reconciled ? 'OK' : 'WARN', 'reconciled month selection after mismatch', {
        filterTitle,
        expected: clickValues,
        reconciled,
      });

      if (reconciled) {
        await this.waitForSpotfireIdle(page, 8000);
        ({ actualSelected, summary, summaryLabels, allFound } = await evaluateSelectionState());
      }
    }

    this.logStep('list-filter', allFound ? 'OK' : 'WARN', `list verification for ${filterTitle}`, {
      expected: expectedNorm,
      actual: actualSelected,
      summaryLabels,
      summary,
    });

    if (!allFound) {
      const snapshot = await snapshotVisibleItems();
      this.logStep('list-filter', 'WARN', `list snapshot for ${filterTitle}`, {
        snapshot,
      });
    }

    return {
      applied: allFound,
      reason: allFound ? 'list filter applied' : `expected [${expectedNorm.join(', ')}] but found [${actualSelected.join(', ')}]`,
    };
  }

  private usesScrollableListSelectionWorkflow(filterTitle: string): boolean {
    const normalized = this.normalizeFilterName(filterTitle);

    return normalized === 'ano'
      || normalized === 'mes'
      || normalized === 'atuacao'
      || normalized === 'atuacaohd'
      || normalized === 'base'
      || normalized === 'periodo'
      || normalized === 'equipe';
  }

  private async applyScrollableListFilterPhysical(
    page: Page,
    filterTitle: string,
    selectedValues: string[],
    isAllSelect: boolean,
  ): Promise<{ applied: boolean; reason: string }> {
    await this.locateFilterElement(page, filterTitle);
    await this.activateListFilter(page, filterTitle);
    await new Promise((r) => setTimeout(r, 180));

    // DON NOT click "(All)" - that would toggle selection of all items!
    // Just hover to activate the list for keyboard navigation.
    // If isAllSelect is true, we need to click (All) once to select all items.
    if (isAllSelect) {
      const allClicked = await this.scrollAndClickExactListItem(page, filterTitle, '(All)', false);
      this.logStep('list-filter', allClicked ? 'OK' : 'WARN', 'clicked (All) to select all items', {
        filterTitle,
        allClicked,
      });
      await this.waitForSpotfireIdle(page, 8000);
      return {
        applied: allClicked,
        reason: allClicked ? 'list filter applied' : 'could not click (All) to activate list',
      };
    }

    // For selecting specific items, just activate by hovering (already done above)
    this.logStep('list-filter', 'OK', 'list activated via hover, ready for item selection', {
      filterTitle,
      itemsToSelect: selectedValues,
    });

    await this.waitForSpotfireIdle(page, 8000);

    // Stay within the filter and select items one by one, verifying after each click
    // IMPORTANT: Hold Ctrl CONTINUOUSLY after the first selection to preserve previous selections
    const maxRetries = 3;
    let ctrlHeld = false;

    try {
      for (let index = 0; index < selectedValues.length; index += 1) {
        const value = selectedValues[index];
        const useCtrl = index > 0;
        let itemSelected = false;

        // Hold Ctrl from the second item onwards and KEEP IT HELD
        if (useCtrl && !ctrlHeld) {
          await page.keyboard.down('Control');
          ctrlHeld = true;
          this.logStep('list-filter', 'OK', 'holding Ctrl for multi-select', { filterTitle, index });
        }

        for (let attempt = 0; attempt < maxRetries && !itemSelected; attempt++) {
          // Re-activate filter if needed (but stay focused on the list)
          if (attempt > 0) {
            await this.locateFilterElement(page, filterTitle);
            await this.activateListFilter(page, filterTitle);
            await new Promise((r) => setTimeout(r, 120));
          }

          // Step 1: Scroll the item into view (Ctrl is already held if needed)
          const scrolled = await this.scrollListItemIntoView(page, filterTitle, value);
          if (!scrolled) {
            this.logStep('list-filter', 'WARN', 'could not scroll item into view', { filterTitle, value, attempt });
            continue;
          }

          // Step 2: Wait for DOM to stabilize
          await this.waitForListStabilization(page, filterTitle, value);

          // Step 3: Click the item (Ctrl is already held via keyboard.down if useCtrl)
          const clicked = await this.clickListItemBySelector(page, filterTitle, value, false); // Don't pass useCtrl - we're holding it globally
          if (!clicked) {
            // Fallback to coordinate-based click
            const item = await this.findListItemCoords(page, filterTitle, value);
            if (item) {
              const clickX = item.labelX ?? item.clickX;
              const clickY = item.labelY ?? item.clickY;
              await page.mouse.click(clickX, clickY);
            }
          }

          await new Promise((r) => setTimeout(r, 300));

          // Step 4: Verify THIS item is now selected.
          const currentSelected = await this.getAllSelectedListItems(page, filterTitle);
          const currentValueNorm = this.normalizeForCompare(value);
          const actualNorm = currentSelected.map((v) => this.normalizeForCompare(v));

          const thisItemSelected = actualNorm.includes(currentValueNorm);

          this.logStep('list-filter', thisItemSelected ? 'OK' : 'WARN', `item selection check (${index + 1}/${selectedValues.length})`, {
            filterTitle,
            value,
            attempt: attempt + 1,
            currentValueNorm,
            actualSelected: actualNorm,
            thisItemSelected,
            ctrlHeld,
          });

          if (thisItemSelected) {
            itemSelected = true;
          } else {
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        if (!itemSelected) {
          return { applied: false, reason: `could not select ${value} after ${maxRetries} attempts` };
        }
      }
    } finally {
      // Always release Ctrl when done
      if (ctrlHeld) {
        await page.keyboard.up('Control');
        this.logStep('list-filter', 'OK', 'released Ctrl after multi-select', { filterTitle });
      }
    }

    // We already verified each item individually after clicking.
    // Just do a simple read of visible items for logging (no scroll - that changes selection).
    const visibleSelected = await this.getAllSelectedListItems(page, filterTitle);
    const expectedNorm = selectedValues.map((value) => this.normalizeForCompare(value));
    const actualNorm = visibleSelected.map((value) => this.normalizeForCompare(value));

    this.logStep('list-filter', 'OK', `final state for ${filterTitle}`, {
      expected: expectedNorm,
      visibleSelected: actualNorm,
      note: 'each item was verified individually after click',
    });

    // Trust the per-item verification - we confirmed each selection in the loop above
    return {
      applied: true,
      reason: 'list filter applied (verified each item individually)',
    };
  }

  /**
   * Scroll through the entire list and collect all selected items.
   * This is needed because virtual lists only render items in the current viewport.
   */
  private async collectAllSelectedWithScroll(page: Page, filterTitle: string): Promise<string[]> {
    const allSelected = new Set<string>();

    // Get list coordinates for hovering
    const listCoords = await page.evaluate((args: { title: string }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
        const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
          ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
        return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
      });

      if (!visual) return null;

      let filterEl: HTMLElement | null = null;
      for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
        const paragraph = control.closest('p');
        const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
        if (trimColon(labelParagraph?.textContent) === trimColon(args.title)) {
          filterEl = control;
          break;
        }
      }

      if (!filterEl) return null;

      const listBox = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.sf-element-list-box');

      if (!listBox) return null;

      const rect = listBox.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }, { title: filterTitle });

    if (!listCoords) {
      // Fall back to simple read
      return this.getAllSelectedListItems(page, filterTitle);
    }

    // Move to list area (don't click - we don't want to toggle anything during verification)
    await page.mouse.move(listCoords.x, listCoords.y);
    await new Promise((r) => setTimeout(r, 50));
    await page.keyboard.press('Home');
    await new Promise((r) => setTimeout(r, 200));

    // Collect selected items from current view
    const collectVisible = async () => {
      const items = await this.getAllSelectedListItems(page, filterTitle);
      for (const item of items) {
        allSelected.add(item);
      }
    };

    await collectVisible();

    // Scroll through with PageDown and collect
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('PageDown');
      await new Promise((r) => setTimeout(r, 150));
      await collectVisible();
    }

    // Press End and collect one more time
    await page.keyboard.press('End');
    await new Promise((r) => setTimeout(r, 200));
    await collectVisible();

    return Array.from(allSelected);
  }

  /**
   * Get all selected items from a list filter by checking sfpc-selected class.
   * This reads the DOM without needing to scroll - checks all items in memory.
   */
  private async getAllSelectedListItems(page: Page, filterTitle: string): Promise<string[]> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
        const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
          ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
        return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
      });

      if (!visual) return [];

      let filterEl: HTMLElement | null = null;
      for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
        const paragraph = control.closest('p');
        const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
        if (trimColon(labelParagraph?.textContent) === trimColon(title)) {
          filterEl = control;
          break;
        }
      }

      if (!filterEl) return [];

      const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
      const selected: string[] = [];

      for (const item of items) {
        const itemTitle = (item.getAttribute('title') ?? '').trim();
        // Skip placeholders and (All)
        if (itemTitle === '...' || itemTitle === '' || itemTitle.toLowerCase().startsWith('(all)')) continue;

        const isSelected = item.classList.contains('sfpc-selected')
          || item.classList.contains('sfpc-checked')
          || item.classList.contains('sfpc-highlighted')
          || item.getAttribute('aria-selected') === 'true'
          || item.getAttribute('aria-checked') === 'true';

        const checkbox = item.querySelector<HTMLElement>('.sf-element-check-box');
        const checkboxSelected = checkbox?.classList.contains('sfpc-checked') ?? false;

        if (isSelected || checkboxSelected) {
          selected.push(nc(itemTitle));
        }
      }

      return selected;
    }, filterTitle);
  }

  private async setLeftFiltrosSearchInputValue(page: Page, filterTitle: string, value: string): Promise<boolean> {
    return page.evaluate((args: { title: string; value: string }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
        const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
          ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
        return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
      });

      if (!visual) {
        return false;
      }

      let filterEl: HTMLElement | null = null;

      for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
        const paragraph = control.closest('p');
        const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
        if (trimColon(labelParagraph?.textContent) === trimColon(args.title)) {
          filterEl = control;
          break;
        }
      }

      const input = filterEl?.querySelector<HTMLInputElement>('input.SearchInput, input[placeholder*="Type to search in list"]');
      if (!input || !isVisible(input)) {
        return false;
      }

      input.scrollIntoView({ block: 'center' });
      input.focus();
      input.click();
      input.value = args.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        key: args.value ? args.value.slice(-1) : 'Backspace',
      }));

      return document.activeElement === input && input.value === args.value;
    }, { title: filterTitle, value });
  }

  /**
   * Wait for the list to stabilize after scrolling.
   * Spotfire virtual lists may render "..." placeholders temporarily that shift bounding boxes.
   * This function waits until no "..." items are visible OR the target item is found.
   */
  private async waitForListStabilization(page: Page, filterTitle: string, targetValue: string): Promise<void> {
    const maxAttempts = 10;
    const delay = 100;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const state = await page.evaluate((args: { title: string; target: string }) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }
        function trimColon(v: string | null | undefined): string {
          return nc(v).replace(/:$/, '');
        }

        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (!visual) return { stable: true, hasDots: false, hasTarget: false };

        let filterEl: HTMLElement | null = null;
        for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
          const paragraph = control.closest('p');
          const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
          if (trimColon(labelParagraph?.textContent) === trimColon(args.title)) {
            filterEl = control;
            break;
          }
        }

        if (!filterEl) return { stable: true, hasDots: false, hasTarget: false };

        const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
        const visibleItems = items.map(el => (el.getAttribute('title') ?? el.textContent ?? '').trim());
        
        const hasDots = visibleItems.some(v => v === '...');
        const hasTarget = visibleItems.includes(args.target);

        return { stable: hasTarget && !hasDots, hasDots, hasTarget, visibleItems };
      }, { title: filterTitle, target: targetValue });

      if (state.stable || state.hasTarget) {
        this.logStep('list-filter', 'OK', 'list stabilized', {
          filterTitle,
          targetValue,
          attempt,
          hasDots: state.hasDots,
          hasTarget: state.hasTarget,
        });
        return;
      }

      await new Promise((r) => setTimeout(r, delay));
    }

    this.logStep('list-filter', 'WARN', 'list stabilization timeout', { filterTitle, targetValue });
  }

  /**
   * Click on a list item using fresh coordinates and page.mouse.click().
   * Gets coordinates right before clicking to avoid stale position issues in virtual lists.
   */
  private async clickListItemBySelector(
    page: Page,
    filterTitle: string,
    itemLabel: string,
    useCtrl: boolean,
  ): Promise<boolean> {
    // Get fresh coordinates directly before clicking
    const coords = await page.evaluate((args: { title: string; label: string }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
        const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
          ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
        return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
      });

      if (!visual) return null;

      let filterEl: HTMLElement | null = null;
      for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
        const paragraph = control.closest('p');
        const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
        if (trimColon(labelParagraph?.textContent) === trimColon(args.title)) {
          filterEl = control;
          break;
        }
      }

      if (!filterEl) return null;

      // Find the exact item by title attribute
      const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
      for (const item of items) {
        const itemTitle = (item.getAttribute('title') ?? '').trim();
        if (itemTitle === args.label) {
          // DON'T use scrollIntoView - it causes offset issues in virtual lists
          // Just get the current bounding rect
          const rect = item.getBoundingClientRect();

          // Check if element is actually visible (has dimensions)
          if (rect.width <= 0 || rect.height <= 0) {
            return null;
          }

          // The Spotfire virtual list has a coordinate offset issue.
          // Clicking at the reported element's bottom selects the item BELOW it.
          // We compensate by clicking near the TOP of the reported element.
          // This ensures we click within the correct item's visual bounds.
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + 5), // Click near top of element
            // Also return the visible text for verification
            text: itemTitle,
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }
      }

      return null;
    }, { title: filterTitle, label: itemLabel });

    if (!coords) {
      this.logStep('list-filter', 'WARN', 'could not find item coordinates', { filterTitle, itemLabel });
      return false;
    }

    this.logStep('list-filter', 'OK', 'found item for click', {
      filterTitle,
      itemLabel,
      coords,
    });

    // Wait a tiny bit for any scroll animation to complete
    await new Promise((r) => setTimeout(r, 50));

    try {
      if (useCtrl) {
        await page.keyboard.down('Control');
      }

      // Use page.mouse.click with the fresh coordinates
      await page.mouse.click(coords.x, coords.y);

      if (useCtrl) {
        await page.keyboard.up('Control');
      }

      return true;
    } catch (err) {
      this.logStep('list-filter', 'WARN', 'mouse click failed', {
        filterTitle,
        itemLabel,
        error: String(err),
      });
      return false;
    }
  }

  private async scrollListItemIntoView(page: Page, filterTitle: string, itemLabel: string): Promise<boolean> {
    // Helper to check if item is visible without scrolling
    const checkItemVisible = async (): Promise<boolean> => {
      return page.evaluate((args: { title: string; label: string }) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }
        function trimColon(v: string | null | undefined): string {
          return nc(v).replace(/:$/, '');
        }

        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (!visual) return false;

        let filterEl: HTMLElement | null = null;
        for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
          const paragraph = control.closest('p');
          const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
          if (trimColon(labelParagraph?.textContent) === trimColon(args.title)) {
            filterEl = control;
            break;
          }
        }

        if (!filterEl) return false;

        const sc = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
          ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable');

        const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
        for (const item of items) {
          const itemTitle = (item.getAttribute('title') ?? '').trim();
          if (itemTitle === '...' || itemTitle === '') continue;
          if (itemTitle === args.label) {
            // Check if visible in container
            if (!sc) return true;
            const itemRect = item.getBoundingClientRect();
            const scRect = sc.getBoundingClientRect();
            return itemRect.top >= scRect.top - 5 && itemRect.bottom <= scRect.bottom + 5;
          }
        }
        return false;
      }, { title: filterTitle, label: itemLabel });
    };

    // First check: is item already visible without doing anything?
    if (await checkItemVisible()) {
      return true;
    }

    // Get scroll button coordinates - using buttons doesn't affect selection!
    const scrollButtons = await page.evaluate((args: { title: string }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
        const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
          ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
        return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
      });

      if (!visual) return null;

      let filterEl: HTMLElement | null = null;
      for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
        const paragraph = control.closest('p');
        const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
        if (trimColon(labelParagraph?.textContent) === trimColon(args.title)) {
          filterEl = control;
          break;
        }
      }

      if (!filterEl) return null;

      // Find scroll buttons: .ScrollbarButton.sfpc-top (up) and .ScrollbarButton.sfpc-bottom (down)
      const upButton = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-top');
      const downButton = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-bottom');

      if (!upButton || !downButton) return null;

      const upRect = upButton.getBoundingClientRect();
      const downRect = downButton.getBoundingClientRect();

      return {
        up: { x: Math.round(upRect.left + upRect.width / 2), y: Math.round(upRect.top + upRect.height / 2) },
        down: { x: Math.round(downRect.left + downRect.width / 2), y: Math.round(downRect.top + downRect.height / 2) },
      };
    }, { title: filterTitle });

    if (!scrollButtons) {
      this.logStep('scroll', 'WARN', 'could not find scroll buttons', { filterTitle, itemLabel });
      return false;
    }

    // Click UP button multiple times to go to top
    for (let i = 0; i < 20; i++) {
      await page.mouse.click(scrollButtons.up.x, scrollButtons.up.y);
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));

    // Check if already visible after going to top
    if (await checkItemVisible()) {
      return true;
    }

    // Get total items to know when to stop
    const totalItems = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
        const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
          ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
        return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
      });

      if (!visual) return 20;

      let filterEl: HTMLElement | null = null;
      for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
        const paragraph = control.closest('p');
        const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
        if (trimColon(labelParagraph?.textContent) === trimColon(title)) {
          filterEl = control;
          break;
        }
      }

      if (!filterEl) return 20;

      const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
      for (const item of items) {
        const itemTitle = (item.getAttribute('title') ?? item.textContent ?? '').trim();
        const match = itemTitle.match(/\(All\)\s*(\d+)\s*values?/i);
        if (match) {
          return parseInt(match[1], 10);
        }
      }
      return 20;
    }, filterTitle);

    // Click DOWN button to scroll through the list - each click scrolls ~1 item
    const maxClicks = totalItems + 10;

    for (let i = 0; i < maxClicks; i++) {
      // Click down button
      await page.mouse.click(scrollButtons.down.x, scrollButtons.down.y);
      await new Promise((r) => setTimeout(r, 80));

      // Check every few clicks if item is visible
      if (i % 2 === 0) {
        if (await checkItemVisible()) {
          await new Promise((r) => setTimeout(r, 150));
          return true;
        }
      }
    }

    this.logStep('scroll', 'WARN', 'item not found after scrolling entire list', {
      filterTitle,
      itemLabel,
      totalItems,
      maxClicks,
    });

    return false;
  }

  private async scrollAndClickExactListItem(page: Page, filterTitle: string, itemLabel: string, ctrlKey: boolean): Promise<boolean> {
    return page.evaluate(async (args: { title: string; label: string; ctrlKey: boolean }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      async function wait(ms: number): Promise<void> {
        await new Promise((r) => window.setTimeout(r, ms));
      }

      function resolveFilterElement(): HTMLElement | null {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (!visual) {
          return null;
        }

        for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
          const paragraph = control.closest('p');
          const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
          if (trimColon(labelParagraph?.textContent) === trimColon(args.title)) {
            return control;
          }
        }

        return null;
      }

      function dispatchClick(target: HTMLElement): void {
        const rect = target.getBoundingClientRect();
        const clientX = rect.left + Math.min(Math.max(rect.width / 2, 6), Math.max(rect.width - 2, 6));
        const clientY = rect.top + Math.min(Math.max(rect.height / 2, 6), Math.max(rect.height - 2, 6));

        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            ctrlKey: args.ctrlKey,
            button: 0,
            buttons: 1,
            clientX,
            clientY,
          }));
        }
      }

      const filterEl = resolveFilterElement();
      if (!filterEl) {
        return false;
      }

      const resolvedFilterEl = filterEl;

      const requested = nc(args.label);
      const sc = resolvedFilterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable')
        ?? resolvedFilterEl.querySelector<HTMLElement>('.ListContainer .sf-element-list-box')
        ?? resolvedFilterEl.querySelector<HTMLElement>('.StyledScrollbar.ListContainerScroll .sfc-scrollable')
        ?? resolvedFilterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable');

      const listItems = resolvedFilterEl.querySelector<HTMLElement>('.ListItems');
      const scrollArea = resolvedFilterEl.querySelector<HTMLElement>('.ScrollArea');

      function isElementVisibleInContainer(el: HTMLElement, container: HTMLElement | null): boolean {
        if (!container) return true;
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        return elRect.top >= containerRect.top - 5 && elRect.bottom <= containerRect.bottom + 5;
      }

      function findVisibleItemByTitle(): HTMLElement | null {
        const allItems = Array.from(resolvedFilterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
        for (const item of allItems) {
          const itemTitle = (item.getAttribute('title') ?? '').trim();
          if (itemTitle === args.label && isElementVisibleInContainer(item, sc)) {
            return item;
          }
        }
        return null;
      }

      if (sc) {
        // Reset scroll to top
        sc.scrollTop = 0;
        if (listItems) {
          listItems.style.top = '0px';
        }
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(100);

        // Full sweep through the scroll range
        const itemHeight = 15;
        const containerHeight = sc.clientHeight || 60;
        const scrollAreaHeight = scrollArea?.scrollHeight || sc.scrollHeight || 200;
        const maxScroll = Math.max(scrollAreaHeight - containerHeight, 0);
        const step = itemHeight;

        let item = findVisibleItemByTitle();
        
        for (let offset = 0; offset <= maxScroll + itemHeight && !item; offset += step) {
          sc.scrollTop = offset;
          if (listItems) {
            listItems.style.top = `-${offset}px`;
          }
          sc.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(80);
          item = findVisibleItemByTitle();
        }

        if (!item) {
          // Final attempt: scroll to very end
          sc.scrollTop = maxScroll;
          if (listItems) {
            listItems.style.top = `-${maxScroll}px`;
          }
          sc.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(100);
          item = findVisibleItemByTitle();
        }

        if (!item) {
          return false;
        }

        dispatchClick(item);
        return true;
      }

      // No scroll container - try to find item directly
      const item = findVisibleItemByTitle();
      if (!item) {
        return false;
      }

      dispatchClick(item);
      return true;
    }, { title: filterTitle, label: itemLabel, ctrlKey });
  }

  private async reconcileExactMonthSelection(page: Page, filterTitle: string, requestedMonths: string[]): Promise<boolean> {
    if (requestedMonths.length === 0) {
      return true;
    }

    const firstSelected = await this.scrollAndClickExactListItem(page, filterTitle, requestedMonths[0], false);
    if (!firstSelected) {
      return false;
    }

    await this.waitForSpotfireIdle(page, 8000);

    for (let index = 1; index < requestedMonths.length; index += 1) {
      const selected = await this.scrollAndClickExactListItem(page, filterTitle, requestedMonths[index], true);
      if (!selected) {
        return false;
      }

      await this.waitForSpotfireIdle(page, 8000);
    }

    return true;
  }

  private async applyRightPanelYearFilter(
    page: Page,
    filterTitle: string,
    selectedValues: string[],
    isAllSelect: boolean,
  ): Promise<{ applied: boolean; reason: string }> {
    const rightPanelRegion = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function resolveRightPanelRoot(): HTMLElement | null {
        return document.querySelector<HTMLElement>('.sfc-filter-panel')
          ?? document.querySelector<HTMLElement>('.FilterPanelScroll')
          ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll');
      }

      const wanted = nc(title);
      const panelRoot = resolveRightPanelRoot();
      const filterEl = Array.from((panelRoot ?? document).querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === wanted;
      }) ?? null;

      if (!panelRoot || !filterEl) {
        return {
          rootFound: Boolean(panelRoot),
          filterFound: Boolean(filterEl),
          visibleRows: [] as string[],
          rootRect: null as null | { left: number; top: number; right: number; bottom: number },
          filterRect: null as null | { left: number; top: number; right: number; bottom: number },
        };
      }

      const rootRect = panelRoot.getBoundingClientRect();
      const filterRect = filterEl.getBoundingClientRect();

      const visibleRows = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
        .map((item) => (item.getAttribute('title') ?? item.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((label) => label.length > 0 && label !== '...');

      return {
        rootFound: true,
        filterFound: true,
        visibleRows,
        rootRect: {
          left: Math.round(rootRect.left),
          top: Math.round(rootRect.top),
          right: Math.round(rootRect.right),
          bottom: Math.round(rootRect.bottom),
        },
        filterRect: {
          left: Math.round(filterRect.left),
          top: Math.round(filterRect.top),
          right: Math.round(filterRect.right),
          bottom: Math.round(filterRect.bottom),
        },
      };
    }, filterTitle);

    this.log('validated right-panel region for year filter', {
      filterTitle,
      rootFound: rightPanelRegion.rootFound,
      filterFound: rightPanelRegion.filterFound,
      visibleRows: rightPanelRegion.visibleRows,
      rootRect: rightPanelRegion.rootRect,
      filterRect: rightPanelRegion.filterRect,
    });

    if (!rightPanelRegion.rootFound || !rightPanelRegion.filterFound) {
      return { applied: false, reason: 'could not validate right-panel region for year filter' };
    }

    const visibleRows = rightPanelRegion.visibleRows;

    if (visibleRows.length < 3 || !visibleRows[0].toLowerCase().startsWith('(all)')) {
      return {
        applied: false,
        reason: `unexpected year row layout [${visibleRows.join(', ')}]`,
      };
    }

    const yearRows = visibleRows.filter((label) => /^\d{4}$/.test(label));
    const requestedYears = isAllSelect ? yearRows : selectedValues.filter((value) => /^\d{4}$/.test(value));

    if (!requestedYears.length) {
      return { applied: true, reason: 'no year values to select' };
    }

    const uniqueRequestedYears = Array.from(new Set(requestedYears));

    if (isAllSelect) {
      await this.clickListItemDomFallback(page, filterTitle, '(All)', false);
      await new Promise((r) => setTimeout(r, 250));
      await this.waitForSpotfireIdle(page, 8000);
    }

    for (let index = 0; index < uniqueRequestedYears.length; index += 1) {
      const year = uniqueRequestedYears[index];
      const rowIndex = visibleRows.findIndex((label) => label === year);

      if (rowIndex === -1) {
        return { applied: false, reason: `year row not found for ${year}` };
      }

      const clicked = await this.selectRightPanelYearBySearch(page, filterTitle, year, index > 0);
      if (!clicked) {
        return { applied: false, reason: `could not select year ${year} inside the validated right-panel region` };
      }

      await new Promise((r) => setTimeout(r, 250));
      await this.waitForSpotfireIdle(page, 8000);
    }

    const actualSelected = await this.getSelectedListItems(page, filterTitle);
    const expected = uniqueRequestedYears.map((value) => this.normalizeForCompare(value));
    const actual = actualSelected.map((value) => this.normalizeForCompare(value));
    const matches = expected.every((value) => actual.includes(value)) && actual.length === expected.length;

    this.logStep('list-filter', matches ? 'OK' : 'WARN', `year list verification for ${filterTitle}`, {
      expected,
      actual,
      rowOrder: yearRows,
    });

    return {
      applied: matches,
      reason: matches ? 'year filter applied by ordered rows' : `expected [${expected.join(', ')}] but found [${actual.join(', ')}]`,
    };
  }

  private async selectRightPanelYearBySearch(page: Page, filterTitle: string, year: string, ctrlKey: boolean): Promise<boolean> {
    const inputPrepared = await this.setRightPanelSearchInputValue(page, filterTitle, year);
    if (!inputPrepared) {
      return false;
    }

    await new Promise((r) => setTimeout(r, 220));

    const targetCoords = await this.getRightPanelListItemCoords(page, filterTitle, year);
    if (!targetCoords) {
      return false;
    }

    if (ctrlKey) {
      await page.keyboard.down('Control');
    }

    await page.mouse.click(targetCoords.x, targetCoords.y);

    if (ctrlKey) {
      await page.keyboard.up('Control');
    }

    await new Promise((r) => setTimeout(r, 180));

    const cleared = await this.setRightPanelSearchInputValue(page, filterTitle, '');
    if (!cleared) {
      return true;
    }

    await new Promise((r) => setTimeout(r, 80));

    return true;
  }

  private async setRightPanelSearchInputValue(page: Page, filterTitle: string, value: string): Promise<boolean> {
    return page.evaluate((args: { title: string; value: string }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll')
        ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll');

      if (!panelRoot) {
        return false;
      }

      const rootRect = panelRoot.getBoundingClientRect();
      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter'))
        .filter((candidate) => isVisible(candidate))
        .find((candidate) => {
          const titleEl = candidate.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          const rect = candidate.getBoundingClientRect();
          return nc(titleEl?.getAttribute('title') ?? titleEl?.textContent) === nc(args.title)
            && rect.bottom > rootRect.top
            && rect.top < rootRect.bottom;
        }) ?? null;

      const input = filterEl?.querySelector<HTMLInputElement>('input.SearchInput, input[placeholder*="Type to search in list"]');
      if (!input || !isVisible(input)) {
        return false;
      }

      input.scrollIntoView({ block: 'center' });
      input.focus();
      input.click();
      input.value = args.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: args.value ? args.value.slice(-1) : 'Backspace' }));
      return document.activeElement === input && input.value === args.value;
    }, { title: filterTitle, value });
  }

  private async getRightPanelSearchInputCoords(page: Page, filterTitle: string): Promise<{ x: number; y: number } | null> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll')
        ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll');

      if (!panelRoot) {
        return null;
      }

      const rootRect = panelRoot.getBoundingClientRect();
      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter'))
        .filter((candidate) => isVisible(candidate))
        .find((candidate) => {
          const titleEl = candidate.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          const rect = candidate.getBoundingClientRect();
          return nc(titleEl?.getAttribute('title') ?? titleEl?.textContent) === nc(title)
            && rect.bottom > rootRect.top
            && rect.top < rootRect.bottom;
        }) ?? null;

      const input = filterEl?.querySelector<HTMLInputElement>('input.SearchInput, input[placeholder*="Type to search in list"]');
      if (!input || !isVisible(input)) {
        return null;
      }

      const rect = input.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }, filterTitle);
  }

  private async getRightPanelListItemCoords(page: Page, filterTitle: string, itemLabel: string): Promise<{ x: number; y: number } | null> {
    return page.evaluate((args: { title: string; label: string }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll')
        ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll');

      if (!panelRoot) {
        return null;
      }

      const rootRect = panelRoot.getBoundingClientRect();
      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter'))
        .filter((candidate) => isVisible(candidate))
        .find((candidate) => {
          const titleEl = candidate.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          const rect = candidate.getBoundingClientRect();
          return nc(titleEl?.getAttribute('title') ?? titleEl?.textContent) === nc(args.title)
            && rect.bottom > rootRect.top
            && rect.top < rootRect.bottom;
        }) ?? null;

      if (!filterEl) {
        return null;
      }

      const safeTitle = args.label.replace(/"/g, '\\"');
      let target: HTMLElement | null = filterEl.querySelector<HTMLElement>(`[title="${safeTitle}"]`);

      if (!target || !isVisible(target)) {
        target = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
          .find((item) => (item.getAttribute('title') ?? item.textContent ?? '').replace(/\s+/g, ' ').trim() === args.label) ?? null;
      }

      if (!target || !isVisible(target)) {
        return null;
      }

      const rect = target.getBoundingClientRect();

      // Verify the item is within the scroll container's visible clip area.
      // Spotfire keeps off-screen virtualised items in the DOM but positions them
      // outside the container — clicking them does nothing.
      const sc = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable');
      if (sc) {
        const scRect = sc.getBoundingClientRect();
        if (scRect.width > 0 && scRect.height > 0) {
          // Allow 4px tolerance for sub-pixel rounding and thin borders.
          if (rect.top > scRect.bottom + 4 || rect.bottom < scRect.top - 4) {
            return null;
          }
        }
      }

      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }, { title: filterTitle, label: itemLabel });
  }

  private async clickRightPanelListItemByIndex(page: Page, filterTitle: string, rowIndex: number, ctrlKey: boolean): Promise<boolean> {
    return page.evaluate(async (args: { title: string; rowIndex: number; ctrlKey: boolean }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      async function wait(ms: number): Promise<void> {
        await new Promise((r) => window.setTimeout(r, ms));
      }

      function resolveRightPanelRoot(): HTMLElement | null {
        return document.querySelector<HTMLElement>('.sfc-filter-panel')
          ?? document.querySelector<HTMLElement>('.FilterPanelScroll')
          ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll');
      }

      const wanted = nc(args.title);
      const panelRoot = resolveRightPanelRoot();
      const filterEl = Array.from((panelRoot ?? document).querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === wanted;
      }) ?? null;

      if (!panelRoot || !filterEl) {
        return false;
      }

      const panelRect = panelRoot.getBoundingClientRect();
      const filterRect = filterEl.getBoundingClientRect();

      if (filterRect.left < panelRect.left || filterRect.right > panelRect.right + 2) {
        return false;
      }

      const rows = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
        .filter((item) => {
          const label = (item.getAttribute('title') ?? item.textContent ?? '').replace(/\s+/g, ' ').trim();
          return label.length > 0 && label !== '...';
        });

      const target = rows[args.rowIndex - 1];
      if (!target) {
        return false;
      }

      target.scrollIntoView({ block: 'center' });
      await wait(60);

      const targetRect = target.getBoundingClientRect();
      if (targetRect.left < filterRect.left || targetRect.right > filterRect.right + 2) {
        return false;
      }

      const clientX = targetRect.left + Math.min(Math.max(targetRect.width / 2, 8), Math.max(targetRect.width - 4, 8));
      const clientY = targetRect.top + Math.min(Math.max(targetRect.height / 2, 8), Math.max(targetRect.height - 4, 8));

      target.focus?.();

      if (!args.ctrlKey) {
        target.click();
        await wait(80);
        return true;
      }

      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          ctrlKey: args.ctrlKey,
          button: 0,
          buttons: 1,
          clientX,
          clientY,
        }));
      }

      return true;
    }, { title: filterTitle, rowIndex, ctrlKey });
  }

  private async clickListItemDomFallback(page: Page, filterTitle: string, itemLabel: string, ctrlKey: boolean): Promise<boolean> {
    return page.evaluate(async (args: { title: string; label: string; ctrlKey: boolean }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      async function wait(ms: number): Promise<void> {
        await new Promise((r) => window.setTimeout(r, ms));
      }

      function matchLabel(candidate: string, requested: string): boolean {
        if (requested === '(all)') {
          return candidate.startsWith('(all)');
        }

        if (candidate === requested) {
          return true;
        }

        return false;
      }

      function resolveFilterElement(): HTMLElement | null {
        const t = trimColon(args.title);
        const isReferenceFilter = t === 'data referencia';

        if (isReferenceFilter) {
          return Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
            const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
            return nc(el?.getAttribute('title') ?? el?.textContent) === t;
          }) ?? null;
        }

        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (visual) {
          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              return control;
            }
          }
        }

        return Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null;
      }

      function dispatchClick(target: HTMLElement): void {
        const rect = target.getBoundingClientRect();
        const clientX = rect.left + Math.min(Math.max(rect.width / 2, 6), Math.max(rect.width - 2, 6));
        const clientY = rect.top + Math.min(Math.max(rect.height / 2, 6), Math.max(rect.height - 2, 6));

        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            ctrlKey: args.ctrlKey,
            button: 0,
            buttons: 1,
            clientX,
            clientY,
          }));
        }
      }

      function nativeClick(target: HTMLElement): void {
        target.focus?.();
        target.click();
      }

      const filterEl = resolveFilterElement();
      if (!filterEl) {
        return false;
      }

      const requested = nc(args.label);
      const resolvedFilterElement = filterEl;
      const sc = resolvedFilterElement.querySelector<HTMLElement>('.ListContainer .sfc-scrollable')
        ?? resolvedFilterElement.querySelector<HTMLElement>('.ListContainer .sf-element-list-box')
        ?? resolvedFilterElement.querySelector<HTMLElement>('.StyledScrollbar.ListContainerScroll .sfc-scrollable')
        ?? resolvedFilterElement.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable');

      const listItems = resolvedFilterElement.querySelector<HTMLElement>('.ListItems');
      const scrollArea = resolvedFilterElement.querySelector<HTMLElement>('.ScrollArea');

      function isElementVisibleInContainer(el: HTMLElement, container: HTMLElement | null): boolean {
        if (!container) return true;
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        return elRect.top >= containerRect.top - 5 && elRect.bottom <= containerRect.bottom + 5;
      }

      function findVisibleItemByTitle(): HTMLElement | null {
        const allItems = Array.from(resolvedFilterElement.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
        for (const item of allItems) {
          const itemTitle = (item.getAttribute('title') ?? '').trim();
          const itemTitleNorm = nc(itemTitle);
          const matches = requested === '(all)' ? itemTitleNorm.startsWith('(all)') : itemTitle === args.label;
          if (matches && isElementVisibleInContainer(item, sc)) {
            return item;
          }
        }
        return null;
      }

      let item: HTMLElement | null = null;

      if (sc) {
        // Reset scroll to top
        sc.scrollTop = 0;
        if (listItems) {
          listItems.style.top = '0px';
        }
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(100);

        // Full sweep through the scroll range
        const itemHeight = 15;
        const containerHeight = sc.clientHeight || 60;
        const scrollAreaHeight = scrollArea?.scrollHeight || sc.scrollHeight || 200;
        const maxScroll = Math.max(scrollAreaHeight - containerHeight, 0);
        const step = itemHeight;

        item = findVisibleItemByTitle();
        
        for (let offset = 0; offset <= maxScroll + itemHeight && !item; offset += step) {
          sc.scrollTop = offset;
          if (listItems) {
            listItems.style.top = `-${offset}px`;
          }
          sc.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(80);
          item = findVisibleItemByTitle();
        }

        if (!item) {
          // Final attempt: scroll to very end
          sc.scrollTop = maxScroll;
          if (listItems) {
            listItems.style.top = `-${maxScroll}px`;
          }
          sc.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(100);
          item = findVisibleItemByTitle();
        }
      } else {
        item = findVisibleItemByTitle();
      }

      if (!item) {
        return false;
      }

      const target = item;

      if (!args.ctrlKey) {
        nativeClick(target);
        await wait(80);
        nativeClick(item.querySelector<HTMLElement>('.sf-element-text-box') ?? target);
        return true;
      }

      dispatchClick(target);
      return true;
    }, { title: filterTitle, label: itemLabel, ctrlKey });
  }

  private async getToggleOptions(page: Page, filterTitle: string): Promise<Array<{ label: string; checked: boolean; x: number; y: number }>> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const t = trimColon(title);
      const isReferenceFilter = t === 'data referencia';

      let filterEl = isReferenceFilter
        ? Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null
        : null;

      if (!filterEl && !isReferenceFilter) {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (visual) {
          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              filterEl = control;
              break;
            }
          }
        }
      }

      if (!filterEl) {
        return [];
      }

      filterEl.scrollIntoView({ block: 'center' });

      // IMPORTANT: do NOT call scrollIntoView on each item individually — that
      // moves the container so every item ends up at the same viewport position.
      // Instead, read all bounding rects now that the filter is centered.
      const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.ColumnFilter .sf-element-filter-item'));
      const results: Array<{ label: string; checked: boolean; x: number; y: number; visible: boolean }> = [];

      for (const option of items) {
        const labelEl = option.querySelector<HTMLElement>('.sf-element-text-box');
        const checkbox = option.querySelector<HTMLElement>('.sf-element-check-box');
        // Click target = the checkbox div (more precise than the whole row)
        const target = checkbox ?? option;
        const r = target.getBoundingClientRect();

        results.push({
          label: nc(labelEl?.getAttribute('title') ?? labelEl?.textContent),
          checked: checkbox?.classList.contains('sfpc-checked') ?? false,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          visible: r.width > 0 && r.height > 0,
        });
      }

      return results.filter((o) => o.label.length > 0 && o.visible);
    }, filterTitle);
  }

  private async applyToggleGroupPhysical(page: Page, filterTitle: string, selectedValues: string[]): Promise<{ applied: boolean; reason: string }> {
    const desired = new Set(selectedValues.map((v) => this.normalizeForCompare(v)));

    await this.locateFilterElement(page, filterTitle);
    await this.activateFilter(page, filterTitle);

    // Read initial state
    let options = await this.getToggleOptions(page, filterTitle);

    if (!options.length) {
      return { applied: false, reason: 'no toggle options found' };
    }

    this.logStep('toggle-filter', 'START', `${filterTitle}: initial state`, {
      desired: Array.from(desired),
      current: options.filter((o) => o.checked).map((o) => o.label),
      all: options.map((o) => `${o.label}=${o.checked}`),
    });

    // Click each option that needs toggling.
    // Waiting for full idle after each click can be extremely slow (progress indicators may linger).
    // Instead, do a short idle wait between clicks and a full idle wait once at the end.
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      const shouldBeChecked = desired.has(option.label);

      if (shouldBeChecked === option.checked) {
        continue;
      }

      this.logStep('toggle-filter', 'START', `${filterTitle}: clicking ${option.label} (checked=${option.checked}, want=${shouldBeChecked})`, {
        x: option.x, y: option.y,
      });

      await page.mouse.click(option.x, option.y);
      await new Promise((r) => setTimeout(r, 300));

      // Short idle wait: enough for click to register without stalling the whole run.
      await this.waitForSpotfireIdle(page, 8000);

      // Re-read options with fresh coordinates after each click (cheap + prevents stale coords)
      await this.locateFilterElement(page, filterTitle);
      options = await this.getToggleOptions(page, filterTitle);
    }

    await this.waitForSpotfireIdle(page);

    const finalChecked = options.filter((o) => o.checked).map((o) => o.label);
    const allMatched = desired.size === 0 || (Array.from(desired).every((d) => finalChecked.includes(d)) && finalChecked.length === desired.size);

    this.logStep('toggle-filter', allMatched ? 'OK' : 'WARN', `toggle verification for ${filterTitle}`, {
      expected: Array.from(desired),
      actual: finalChecked,
    });

    return {
      applied: allMatched,
      reason: allMatched ? 'toggle group applied' : `expected [${Array.from(desired).join(', ')}] got [${finalChecked.join(', ')}]`,
    };
  }

  private async applyRangeFilterPhysical(page: Page, filterTitle: string, range?: { selectedMin?: string; selectedMax?: string; min?: string; max?: string }): Promise<{ applied: boolean; reason: string }> {
    if (!range) {
      return { applied: false, reason: 'no range provided' };
    }

    const labels = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const t = trimColon(title);
      const isReferenceFilter = t === 'data referencia';

      let filterEl = isReferenceFilter
        ? Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null
        : null;

      if (!filterEl && !isReferenceFilter) {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (visual) {
          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              filterEl = control;
              break;
            }
          }
        }
      }

      if (!filterEl) {
        return [];
      }

      return Array.from(filterEl.querySelectorAll<HTMLElement>('.EditableLabel')).map((label) => {
        label.scrollIntoView({ block: 'center' });
        const r = label.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), visible: r.width > 0 && r.height > 0 };
      }).filter((l) => l.visible);
    }, filterTitle);

    if (labels.length < 2) {
      return { applied: false, reason: 'range editor labels not found' };
    }

    const rangeValues = [range.selectedMin?.trim(), range.selectedMax?.trim()];

    for (let i = 0; i < 2; i += 1) {
      if (!rangeValues[i]) {
        continue;
      }

      await page.mouse.click(labels[i].x, labels[i].y);
      await new Promise((r) => setTimeout(r, 150));
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.type(rangeValues[i]!, { delay: 20 });
      await page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, 200));
    }

    return { applied: true, reason: 'range filter applied' };
  }

  private async applyTextFilterPhysical(page: Page, filterTitle: string, textValue: string): Promise<{ applied: boolean; reason: string }> {
    const inputCoords = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }

      const t = trimColon(title);
      const isReferenceFilter = t === 'data referencia';

      let filterEl = isReferenceFilter
        ? Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null
        : null;

      if (!filterEl && !isReferenceFilter) {
        const visual = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual')).find((candidate) => {
          const visualTitle = candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title]')
            ?? candidate.querySelector<HTMLElement>('.sf-element-visual-title .sf-element-text-box');
          return trimColon(visualTitle?.getAttribute('title') ?? visualTitle?.textContent) === 'filtros';
        });

        if (visual) {
          for (const control of Array.from(visual.querySelectorAll<HTMLElement>('.HtmlTextAreaControl.sf-element-filter-content'))) {
            const paragraph = control.closest('p');
            const labelParagraph = paragraph?.previousElementSibling as HTMLElement | null;
            if (trimColon(labelParagraph?.textContent) === t) {
              filterEl = control;
              break;
            }
          }
        }
      }

      if (!filterEl) {
        return null;
      }

      const input = filterEl.querySelector<HTMLInputElement>('input[placeholder*="Type to filter by text"], input.SearchInput');

      if (!input) {
        return null;
      }

      input.scrollIntoView({ block: 'center' });
      const r = input.getBoundingClientRect();

      if (r.width === 0 || r.height === 0) {
        return null;
      }

      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, filterTitle);

    if (!inputCoords) {
      return { applied: false, reason: 'text input not found' };
    }

    await page.mouse.click(inputCoords.x, inputCoords.y, { clickCount: 3 });
    await page.keyboard.type(textValue, { delay: 20 });
    await page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 200));

    return { applied: true, reason: 'text filter applied' };
  }

  /**
   * Reads the current DOM state of a single filter and checks whether the
   * applied value matches what was requested.  Returns `{ match: true }` on
   * success or `{ match: false, reason }` with a human-readable mismatch
   * description so the caller can decide whether to retry.
   */
  private async verifyFilterApplied(
    page: Page,
    filter: SpotfireFilter,
  ): Promise<{ match: boolean; reason: string; actual?: string }> {
    try {
      const currentFilters = await this.readVisibleFilters(page);
      const found = currentFilters.find(
        (f) => this.normalizeForCompare(f.title) === this.normalizeForCompare(filter.title),
      );

      if (!found) {
        return { match: false, reason: 'filter not found after application' };
      }

      const nc = (v: string | null | undefined) => this.normalizeForCompare(v);

      if (filter.kind === 'text') {
        const expected = nc(filter.textValue);
        const actual   = nc(found.textValue);
        const match    = actual === expected || actual.includes(expected) || expected.includes(actual);
        return match
          ? { match: true, reason: 'text value matches' }
          : { match: false, reason: `text mismatch: expected="${filter.textValue}" actual="${found.textValue}"`, actual: found.textValue ?? '' };
      }

      if (filter.kind === 'range') {
        const expMin = nc(filter.range?.selectedMin);
        const expMax = nc(filter.range?.selectedMax);
        const actMin = nc(found.range?.selectedMin);
        const actMax = nc(found.range?.selectedMax);
        const match  = expMin === actMin && expMax === actMax;
        return match
          ? { match: true, reason: 'range matches' }
          : { match: false, reason: `range mismatch: expected=[${expMin}..${expMax}] actual=[${actMin}..${actMax}]` };
      }

      // list / toggle-group: every requested value must appear in selectedValues
      const requested = (filter.selectedValues ?? []).map(nc).filter(Boolean);
      const actual    = (found.selectedValues  ?? []).map(nc);

      if (requested.length === 0) {
        return { match: true, reason: 'no specific values required' };
      }

      const missing = requested.filter((v) => !actual.includes(v));
      if (missing.length === 0) {
        return { match: true, reason: 'all selected values present' };
      }

      return {
        match:  false,
        reason: `missing values: [${missing.join(', ')}] — actual: [${actual.join(', ')}]`,
        actual: actual.join(', '),
      };
    } catch (err) {
      return {
        match:  false,
        reason: `verification threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private hasRequestedFilterValue(filter: SpotfireFilter): boolean {
    if (filter.kind === 'text') {
      return Boolean(filter.textValue?.trim());
    }

    if (filter.kind === 'range') {
      return Boolean(filter.range?.selectedMin?.trim() || filter.range?.selectedMax?.trim());
    }

    return filter.selectedValues.some((value) => value.trim().length > 0);
  }

  private async getAutomationSession(): Promise<{ browser: Browser; page: Page; createdNewPage: boolean }> {
    let browser = this.persistentBrowser;

    if (!browser || !browser.connected) {
      browser = await this.launchBrowser();
      this.persistentBrowser = browser;
      this.persistentPage = undefined;
    }

    let page = this.persistentPage;
    let createdNewPage = false;

    if (!page || page.isClosed()) {
      // Try to find an existing tab with the Scanner analysis already open
      const existingPage = await this.findExistingAnalysisPage(browser);

      if (existingPage) {
        this.log('reusing existing browser tab with Scanner analysis', {
          url: existingPage.url(),
        });
        page = existingPage;
        this.persistentPage = page;
        createdNewPage = false;
      } else {
        page = await browser.newPage();
        this.persistentPage = page;
        createdNewPage = true;
      }
    }

    return { browser, page, createdNewPage };
  }

  private async findExistingAnalysisPage(browser: Browser): Promise<Page | undefined> {
    const expectedFileMatch = this.environment.spotfire.analysisUrl.match(/[?&]file=([^&]+)/);
    const expectedFile = expectedFileMatch ? decodeURIComponent(expectedFileMatch[1]) : '';

    if (!expectedFile) {
      return undefined;
    }

    const pages = await browser.pages();

    for (const candidate of pages) {
      try {
        const url = candidate.url();
        const fileMatch = url.match(/[?&]file=([^&]+)/);
        const file = fileMatch ? decodeURIComponent(fileMatch[1]) : '';

        if (url.includes('/analysis') && file === expectedFile) {
          return candidate;
        }
      } catch {
        // page may have been closed between listing and checking
      }
    }

    return undefined;
  }

  private usesExternalBrowserConnection(): boolean {
    return !this.environment.spotfire.headless
      && Boolean(this.environment.spotfire.browserUrl || this.environment.spotfire.browserWSEndpoint);
  }

  private async disposeAutomationSession(): Promise<void> {
    const browser = this.persistentBrowser;
    const page = this.persistentPage;

    this.persistentPage = undefined;
    this.persistentBrowser = undefined;

    if (browser && browser.connected) {
      if (this.usesExternalBrowserConnection()) {
        if (page && !page.isClosed()) {
          await page.close().catch(() => undefined);
        }
        browser.disconnect();
        return;
      }

      await browser.close();
    }
  }

  private isSupersededAbort(signal?: AbortSignal): boolean {
    if (!signal?.aborted) return false;
    const reason = signal.reason;
    // Handles both DOMException (internal runSerialized supersede) and plain Error
    // (external HTTP controller in create-server.ts) — both use the same message.
    return reason instanceof Error
      && reason.name === 'AbortError'
      && reason.message === 'data download superseded by a newer request';
  }

  private async runSerialized<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    // Abort whatever is currently running — latest request wins.
    this.activeTaskAbort?.abort(new DOMException('data download superseded by a newer request', 'AbortError'));

    const ownAbort = new AbortController();
    this.activeTaskAbort = ownAbort;

    // Combine the caller's external signal with the internal supersede signal.
    const combined = signal
      ? this.combineSignals(signal, ownAbort.signal)
      : ownAbort.signal;

    let release: (() => void) | undefined;
    const waiter = new Promise<void>((resolveWaiter) => {
      release = resolveWaiter;
    });

    const previous = this.activeQueue;
    this.activeQueue = previous.then(() => waiter);

    try {
      // Wait for previous task to settle (it will abort quickly thanks to the abort above).
      await previous.catch(() => undefined);
      this.throwIfAborted(combined);
      return await task(combined);
    } finally {
      release?.();
      // Clean up own controller reference only if we're still the active one.
      if (this.activeTaskAbort === ownAbort) {
        this.activeTaskAbort = undefined;
      }
    }
  }

  /** Merge two AbortSignals — aborts when either one fires. */
  private combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    const controller = new AbortController();
    const abort = (reason?: unknown) => controller.abort(reason);
    if (a.aborted) { controller.abort(a.reason); return controller.signal; }
    if (b.aborted) { controller.abort(b.reason); return controller.signal; }
    a.addEventListener('abort', () => abort(a.reason), { once: true });
    b.addEventListener('abort', () => abort(b.reason), { once: true });
    return controller.signal;
  }


  private async raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return promise;
    }

    this.throwIfAborted(signal);

    // Evita UnhandledPromiseRejectionWarning (que derruba o node) caso a promise original
    // falhe *depois* que a Promise.race já retornou via reject por causa do abort signal.
    // Ex: "ProtocolError: Execution context was destroyed" disparado minutos depois.
    promise.catch(() => {});

    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(this.toAbortError(signal.reason));
        }, { once: true });
      }),
    ]);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
      return;
    }

    throw this.toAbortError(signal.reason);
  }

  private toAbortError(reason: unknown): Error {
    if (reason instanceof Error) {
      if (reason.name === 'AbortError') {
        return reason;
      }

      const error = new Error(reason.message);
      error.name = 'AbortError';
      return error;
    }

    const error = new Error(
      typeof reason === 'string' && reason.trim().length > 0
        ? reason
        : 'spotfire extraction aborted',
    );
    error.name = 'AbortError';
    return error;
  }

  private async launchBrowser(): Promise<Browser> {
    this.log('launching browser', {
      headless: this.environment.spotfire.headless,
      browserPath: this.environment.spotfire.browserPath || null,
      browserUrl: this.environment.spotfire.browserUrl || null,
      browserWSEndpoint: this.environment.spotfire.browserWSEndpoint || null,
      userDataDir: this.environment.spotfire.userDataDir || null,
      profileDirectory: this.environment.spotfire.profileDirectory || null,
    });

    if (!this.environment.spotfire.headless && this.environment.spotfire.browserWSEndpoint) {
      this.log('connecting to existing browser by websocket endpoint', {
        browserWSEndpoint: this.environment.spotfire.browserWSEndpoint,
      });

      try {
        return await puppeteer.connect({
          browserWSEndpoint: this.environment.spotfire.browserWSEndpoint,
          defaultViewport: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not connect to the existing Edge browser via websocket endpoint. `
          + `Start Edge in remote-debugging mode first, then retry. Details: ${message}`,
        );
      }
    }

    if (!this.environment.spotfire.headless && this.environment.spotfire.browserUrl) {
      this.log('connecting to existing browser by remote debugging URL', {
        browserUrl: this.environment.spotfire.browserUrl,
      });

      try {
        return await puppeteer.connect({
          browserURL: this.environment.spotfire.browserUrl,
          defaultViewport: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not connect to the existing Edge browser at ${this.environment.spotfire.browserUrl}. `
          + `Open Edge with remote debugging enabled on port 9222 and retry. `
          + `You can run 'npm run edge:debug' in src/backend first. Details: ${message}`,
        );
      }
    }

    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,1000', '--start-maximized'];

    if (this.environment.spotfire.profileDirectory) {
      launchArgs.push(`--profile-directory=${this.environment.spotfire.profileDirectory}`);
    }

    const userDataDir = this.environment.spotfire.userDataDir?.trim();
    const resolvedUserDataDir = userDataDir && existsSync(userDataDir) ? userDataDir : undefined;

    return puppeteer.launch({
      headless: this.environment.spotfire.headless,
      executablePath: this.environment.spotfire.browserPath || undefined,
      userDataDir: resolvedUserDataDir,
      defaultViewport: { width: 1600, height: 1000 },
      args: launchArgs,
    });
  }

  private async openAnalysis(page: Page, reportTitle: string): Promise<void> {
    if (!page.isClosed()) {
      await this.waitForSpotfireIdle(page).catch(function () { return undefined; });

      const currentUrl = page.url();
      const expectedReportPath = this.environment.spotfire.analysisUrl;
      
      // Extract the report file path from both URLs to compare
      const currentFileMatch = currentUrl.match(/[?&]file=([^&]+)/);
      const expectedFileMatch = expectedReportPath.match(/[?&]file=([^&]+)/);
      const currentFile = currentFileMatch ? decodeURIComponent(currentFileMatch[1]) : '';
      const expectedFile = expectedFileMatch ? decodeURIComponent(expectedFileMatch[1]) : '';
      
      const isCorrectReport = currentFile && expectedFile && currentFile === expectedFile;

      if (currentUrl.includes('/analysis') && isCorrectReport && await this.isAnalysisReady(page)) {
        // Em vez de recarregar a aba inteira (o que destrói contextos de execução pendentes e
        // pode causar ProtocolError / Crash do Node), apenas resetamos os filtros visíveis
        // conforme solicitado pelo usuário.
        this.info('Página existente do Spotfire detectada. Limpando filtros visíveis...');
        this.log('resetting existing Spotfire analysis page filters instead of reloading', {
          reportTitle,
          currentUrl,
          currentFile,
          expectedFile,
        });
        await this.resetVisibleFilters(page);
        await this.waitForSpotfireIdle(page);
        return;
      }

      if (currentUrl.includes('/analysis') && !isCorrectReport) {
        this.log('current page is a different report, navigating to correct report', {
          reportTitle,
          currentUrl,
          currentFile,
          expectedFile,
        });
      }
    }

    this.info(`Abrindo análise: ${reportTitle}`);
    this.log('opening Spotfire analysis URL', {
      reportTitle,
      analysisUrl: this.environment.spotfire.analysisUrl,
    });

    await page.goto(this.environment.spotfire.analysisUrl, {
      waitUntil: 'networkidle2',
      timeout: 120000,
    });

    this.log('analysis URL loaded', {
      currentUrl: page.url(),
    });

    await this.completeLoginIfRequired(page);

    if (await this.isLoginPage(page)) {
      throw new Error(`login did not complete when opening Spotfire analysis: ${this.environment.spotfire.analysisUrl}`);
    }

    if (!page.url().includes('/analysis')) {
      this.log('current URL is not an analysis page, reloading configured analysis URL', {
        currentUrl: page.url(),
      });

      await page.goto(this.environment.spotfire.analysisUrl, {
        waitUntil: 'networkidle2',
        timeout: 120000,
      });
      await this.completeLoginIfRequired(page);
    }

    await this.waitForSpotfireIdle(page);

    if (await this.isAnalysisReady(page)) {
      this.log('analysis is ready without needing report-title click', {
        currentUrl: page.url(),
      });
      return;
    }

    const clicked = await this.tryClickByText(page, reportTitle, false);
    this.log('attempted to click report title by text', {
      reportTitle,
      clicked,
    });

    if (clicked) {
      await this.waitForSpotfireIdle(page);
    }

    if (!await this.isAnalysisReady(page)) {
      throw new Error(`could not load Spotfire analysis from URL: ${this.environment.spotfire.analysisUrl}`);
    }
  }

  private async completeLoginIfRequired(page: Page): Promise<void> {
    if (!await this.isLoginPage(page)) {
      this.log('login step skipped because page is already authenticated', {
        currentUrl: page.url(),
      });
      return;
    }

    this.info('Login detectado, autenticando...');
    this.log('login page detected, filling credentials', {
      currentUrl: page.url(),
      loginUrl: this.environment.spotfire.loginUrl,
    });

    await page.locator("input[type='text']").fill(this.environment.spotfire.username);
    await page.locator("input[type='password']").fill(this.environment.spotfire.password);

    await this.submitLogin(page);

    this.info('Login concluído');
    this.log('login submit completed, checking resulting page', {
      currentUrl: page.url(),
    });

    if (await this.isLoginPage(page)) {
      this.log('still on login page after submit, retrying by navigating back to analysis URL', {
        currentUrl: page.url(),
      });

      await page.goto(this.environment.spotfire.analysisUrl, {
        waitUntil: 'networkidle2',
        timeout: 120000,
      });

      if (await this.isLoginPage(page)) {
        throw new Error(`Spotfire stayed on login page after submit. Current URL: ${page.url()}`);
      }
    }
  }

  private async submitLogin(page: Page): Promise<void> {
    const submitSelectors = [
      "button[type='submit']",
      "input[type='submit']",
      "button[name='login']",
      "button[id*='login']",
      "input[value*='Log']",
      "button[title*='Log']",
    ];

    for (const selector of submitSelectors) {
      const element = await page.$(selector);

      if (!element) {
        continue;
      }

      this.log('submitting login using selector', {
        selector,
      });

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 }).catch(function () { return undefined; }),
        element.click(),
      ]);

      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 120000 }).catch(function () { return undefined; });
      return;
    }

    const passwordInput = await page.$("input[type='password']");

    if (passwordInput) {
      this.log('submitting login by pressing Enter on password field');

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 }).catch(function () { return undefined; }),
        passwordInput.press('Enter'),
      ]);

      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 120000 }).catch(function () { return undefined; });
      return;
    }

    this.log('submitting login by pressing Enter on page');
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 }).catch(function () { return undefined; });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 120000 }).catch(function () { return undefined; });
  }

  private async isLoginPage(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();

    if (url.includes('/login')) {
      return true;
    }

    try {
      return await page.evaluate(function () {
        return document.querySelector("input[type='password']") !== null
          && document.querySelector("input[type='text']") !== null;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.toLowerCase().includes('execution context was destroyed')) {
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(function () { return undefined; });
        return page.url().toLowerCase().includes('/login');
      }

      throw error;
    }
  }

  private async openAnalysisTab(page: Page, tabLabel: string): Promise<void> {
    this.info(`Acessando aba: "${tabLabel}"`);
    this.log('opening analysis tab by text', { tabLabel });

    const tabInfo = await page.evaluate(
      function ({ requestedTab }) {
        function normalize(value: string | null | undefined): string {
          return (value ?? '').replace(/\s+/g, ' ').trim();
        }

        const requested = normalize(requestedTab);
        const tabElements = Array.from(
          document.querySelectorAll<HTMLElement>('.sf-element-page-tab, .sfx_page-tab_204'),
        );

        const allTabLabels = tabElements.map(function (tab) {
          return normalize(tab.getAttribute('title') ?? tab.textContent);
        });

        const matchingTab = tabElements.find(function (tab) {
          const title = normalize(tab.getAttribute('title') ?? tab.textContent);
          return title === requested;
        });

        if (!matchingTab) {
          return { found: false as const, allTabLabels, requested, rect: null };
        }

        matchingTab.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = matchingTab.getBoundingClientRect();
        return { found: true as const, allTabLabels, requested, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      },
      { requestedTab: tabLabel },
    );

    this.log('analysis tab lookup result', tabInfo);

    if (!tabInfo.found || !tabInfo.rect) {
      throw new Error(`tab "${tabLabel}" not found in tab bar. Available tabs: ${tabInfo.allTabLabels?.join(', ')}`);
    }

    // Physical mouse click on tab center — more reliable than DOM .click() after restoring from maximized views
    const { x, y, width, height } = tabInfo.rect;
    await page.mouse.click(x + width / 2, y + height / 2);

    this.log('analysis tab clicked (mouse), waiting for Spotfire to refresh dependent tables', { tabLabel });
    await this.waitForSpotfireIdle(page);
  }

  private async ensureNoMaximizedVisualization(page: Page): Promise<void> {
    this.log('checking whether any visualization is maximized before reading tabs or filters');

    const restoredAnyVisualization = await page.evaluate(async function () {
      function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      }

      async function wait(milliseconds: number): Promise<void> {
        await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, milliseconds); });
      }

      let restoredAny = false;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const restoreButton = document.querySelector<HTMLElement>('.sfc-maximize-visual-button[title="Restore visualization layout"]')
          ?? Array.from(document.querySelectorAll<HTMLElement>('[title], button, div'))
            .filter(function (element) { return isVisible(element); })
            .find(function (element) {
              const title = normalize(element.getAttribute('title'));
              const text = normalize(element.textContent);

              return title === 'restore visualization layout'
                || title === 'minimize visualization'
                || title === 'restore visualization'
                || text === 'restore visualization layout'
                || text === 'minimize visualization'
                || text === 'restore visualization';
            })
          ?? null;

        if (!restoreButton) {
          break;
        }

        restoreButton.click();
        restoredAny = true;
        await wait(250);
      }

      return restoredAny;
    });

    if (restoredAnyVisualization) {
      this.log('a maximized visualization was restored before continuing');
      await this.waitForSpotfireIdle(page);
      return;
    }

    this.log('no maximized visualization detected');
  }

  private async loadAvailableTabs(page: Page): Promise<string[]> {
    await page.waitForSelector('.sf-element-page-tab, .sfx_page-tab_204', {
      timeout: 60000,
    }).catch(() => undefined);

    return page.evaluate(function () {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      return Array.from(document.querySelectorAll<HTMLElement>('.sf-element-page-tab, .sfx_page-tab_204'))
        .map(function (element) { return normalize(element.getAttribute('title')) || normalize(element.textContent); })
        .filter(function (title) { return title.length > 0; })
        .filter(function (title, index, list) { return list.indexOf(title) === index; });
    });
  }

  private async ensureFiltersPanel(page: Page): Promise<void> {
    this.logStep('filters-panel', 'START', 'checking whether the Spotfire filters panel is already visible', {
      expectedLabel: this.environment.spotfire.filterPanelLabel,
    });

    const panelIsOpen = await page.evaluate(function (panelLabel) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      }

      function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      const requestedLabel = normalize(panelLabel);

      return Array.from(document.querySelectorAll<HTMLElement>('.sfc-filter-panel, .FilterPanelScroll, .sf-element-panel-header, .ResetButton, [title="Reset Visible Filters"]'))
        .filter(function (element) { return isVisible(element); })
        .some(function (element) {
          const values = [
            normalize(element.getAttribute('title')),
            normalize(element.getAttribute('aria-label')),
            normalize(element.textContent),
          ].filter(function (value) { return value.length > 0; });

          return element.classList.contains('sfc-filter-panel')
            || element.classList.contains('FilterPanelScroll')
            || element.classList.contains('ResetButton')
            || values.some(function (value) {
              return value.includes(requestedLabel) || value === 'reset visible filters';
            });
        });
    }, this.environment.spotfire.filterPanelLabel);

    if (panelIsOpen) {
      this.logStep('filters-panel', 'OK', 'filters panel is already open on the right side', {
        panelLabel: this.environment.spotfire.filterPanelLabel,
      });
      return;
    }

    const opened = await page.evaluate(function (panelLabel) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      }

      function isVisible(element: HTMLElement): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      const requestedLabel = normalize(panelLabel);
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('[title], [alt], [aria-label], button, div, span'))
        .filter(function (element) { return isVisible(element); })
        .find(function (element) {
          const values = [
            normalize(element.getAttribute('title')),
            normalize(element.getAttribute('alt')),
            normalize(element.getAttribute('aria-label')),
            normalize(element.textContent),
          ].filter(function (value) { return value.length > 0; });

          return values.some(function (value) { return value === requestedLabel; });
        });

      if (!candidates) {
        return false;
      }

      candidates.click();
      return true;
    }, this.environment.spotfire.filterPanelLabel);

    this.logStep('filters-panel', 'START', 'attempted to open filters panel by visible text/title', {
      panelLabel: this.environment.spotfire.filterPanelLabel,
      openedFromToolbar: opened,
    });

    if (!opened) {
      await this.clickByText(page, this.environment.spotfire.filterPanelLabel, true);
      this.logStep('filters-panel', 'WARN', 'opened filters panel using generic text click fallback', {
        panelLabel: this.environment.spotfire.filterPanelLabel,
      });
    }

    await this.waitForSpotfireIdle(page);
    this.logStep('filters-panel', 'OK', 'filters panel open flow finished');
  }

  private async resetVisibleFilters(page: Page): Promise<void> {
    this.logStep('filters-reset', 'START', 'opening Edit menu to reset visible filters', {
      menuTitle: 'Edit',
      itemTitle: 'Reset visible filters',
    });

    const resolveMenuCoords = async (label: string): Promise<{ x: number; y: number; text: string } | null> => {
      return page.evaluate((requestedLabel: string) => {
        function normalize(value: string | null | undefined): string {
          return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        }

        function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
          if (!element) {
            return false;
          }

          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }

        const wanted = normalize(requestedLabel);
        const element = Array.from(document.querySelectorAll<HTMLElement>('[title], .contextMenuItemLabel, .sfx_menu-item_497, button, div, span, label'))
          .filter((candidate) => isVisible(candidate))
          .find((candidate) => {
            const title = normalize(candidate.getAttribute('title'));
            const text = normalize(candidate.textContent);
            return title === wanted || text === wanted;
          });

        if (!element) {
          return null;
        }

        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + (rect.width / 2),
          y: rect.top + (rect.height / 2),
          text: element.textContent?.trim() ?? element.getAttribute('title') ?? '',
        };
      }, label);
    };

    const editMenu = await resolveMenuCoords('Edit');
    if (!editMenu) {
      this.logStep('filters-reset', 'FAIL', 'could not find Edit menu entry');
      throw new Error('Edit menu entry not found');
    }

    await page.mouse.click(editMenu.x, editMenu.y);
    await new Promise((r) => setTimeout(r, 250));

    const resetItem = await resolveMenuCoords('Reset visible filters');
    if (!resetItem) {
      this.logStep('filters-reset', 'FAIL', 'could not find Reset visible filters menu item');
      throw new Error('Reset visible filters menu item not found');
    }

    await page.mouse.click(resetItem.x, resetItem.y);
    this.logStep('filters-reset', 'OK', 'clicked Edit > Reset visible filters', {
      editMenu,
      resetItem,
    });
    await this.waitForSpotfireIdle(page);
    this.info('Filtros resetados ✓');
    this.logStep('filters-reset', 'OK', 'Spotfire became idle after reset action');
  }

  private async ensureAllFiltersVisible(page: Page): Promise<void> {
    const expandedHiddenFilters = await page.evaluate(async function () {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      }

      function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      async function wait(milliseconds: number): Promise<void> {
        await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, milliseconds); });
      }

      let clickedShowAll = false;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const button = Array.from(document.querySelectorAll<HTMLElement>('.MessageButton, button, div[title], span[title]'))
          .filter(function (element) { return isVisible(element); })
          .find(function (element) {
            const title = normalize(element.getAttribute('title'));
            const text = normalize(element.textContent);
            return title === 'show all' || text === 'show all';
          });

        if (!button) {
          break;
        }

        button.click();
        clickedShowAll = true;
        await wait(250);
      }

      return clickedShowAll;
    });

    if (expandedHiddenFilters) {
      this.log('clicked Show all to expand hidden Spotfire filters');
      await this.waitForSpotfireIdle(page);
    }
  }

  /**
   * Scroll the Spotfire filter panel to the very bottom ONCE and wait for idle.
   * This forces the virtualized list to render bottom filters
   * (AtuaçãoHD, Ano, Mês, etc.) so the subsequent `loadAllFilters` scan can
   * find them.  Filters are then applied bottom-to-top without re-scrolling.
   */
  private async scrollFilterPanelToBottom(page: Page): Promise<void> {
    this.logStep('filters-panel', 'START', 'scrolling filter bar to the bottom (single pass)');

    const scrolled = await page.evaluate(async function () {
      function getScrollContainer(): HTMLElement | null {
        return document.querySelector<HTMLElement>('.FilterPanelScroll .Container')
          ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll .Container')
          ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll')
          ?? document.querySelector<HTMLElement>('.FilterPanelScroll')
          ?? document.querySelector<HTMLElement>('.sfc-filter-panel .Container')
          ?? document.querySelector<HTMLElement>('.sfc-filter-panel');
      }

      async function wait(ms: number): Promise<void> {
        await new Promise(function (r) { return window.setTimeout(r, ms); });
      }

      const sc = getScrollContainer();
      if (!sc) return false;

      const max = Math.max(sc.scrollHeight - sc.clientHeight, 0);
      const step = Math.max(Math.floor(sc.clientHeight * 0.5), 120);

      // Scroll down step-by-step to let Spotfire progressively render
      for (let offset = 0; offset <= max; offset += step) {
        sc.scrollTop = offset;
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(120);
      }

      // Park at the very bottom
      sc.scrollTop = max;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      await wait(400);
      return true;
    });

    if (!scrolled) {
      this.logStep('filters-panel', 'WARN', 'could not find filter bar scroll container');
      return;
    }

    await this.waitForSpotfireIdle(page);
    this.logStep('filters-panel', 'OK', 'filter bar scrolled to the bottom and idle');
  }

  /**
   * Build date strings (DD/MM/YYYY) for the right-panel Data Referência filter
   * from the periodSelection. Generates one date per day in the dayRange.
   */
  private generateReferenceDates(periodSelection: NonNullable<ScannerRunRequest['periodSelection']>): string[] {
    const years = this.normalizePeriodSelectionValues(periodSelection.year);
    const months = this.normalizePeriodSelectionValues(periodSelection.month);

    if (years.length === 0 || months.length === 0) {
      return [];
    }

    const dates: string[] = [];

    for (const yearStr of years) {
      const year = parseInt(yearStr, 10);
      if (Number.isNaN(year)) continue;

      for (const monthStr of months) {
        const monthKey = monthStr.toLowerCase();
        const monthIndex = MONTH_OPTIONS.indexOf(monthKey);
        if (monthIndex === -1) continue;

        // Per-month range takes precedence over the global dayRange
        const range = periodSelection.monthDayRanges?.[monthKey] ?? periodSelection.dayRange;
        const minDay = range?.min ?? 1;
        const maxDay = range?.max ?? 31;

        for (let day = minDay; day <= maxDay; day += 1) {
          const d = new Date(year, monthIndex, day);
          // Stop if the date rolls into the next month (e.g. Feb 30 → Mar 2)
          if (d.getMonth() !== monthIndex) break;
          // Spotfire shows dates as DD/MM/YYYY (leading zeros, Brazilian format)
          const dd = String(day).padStart(2, '0');
          const mm = String(monthIndex + 1).padStart(2, '0');
          dates.push(`${dd}/${mm}/${year}`);
        }
      }
    }

    this.log('generated Data Referência date strings', { count: dates.length, sample: dates.slice(0, 5) });
    return dates;
  }

  private async loadAllFilters(page: Page): Promise<SpotfireFilter[]> {
    this.log('waiting for filter titles in the right panel', {
      selector: 'span.sf-element-filter-content.sf-element-filter-title[title]',
    });

    await page.waitForSelector('span.sf-element-filter-content.sf-element-filter-title[title]', {
      timeout: 60000,
    });

    this.log('scrolling filter panel and extracting virtualized filters incrementally');

    const filters = await page.evaluate(async function () {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      function getPanelScrollContainer(): HTMLElement | null {
        return document.querySelector<HTMLElement>('.FilterPanelScroll .Container')
          ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll .Container')
          ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll')
          ?? document.querySelector<HTMLElement>('.FilterPanelScroll')
          ?? document.querySelector<HTMLElement>('.sfc-filter-panel .Container')
          ?? document.querySelector<HTMLElement>('.sfc-filter-panel')
          ?? null;
      }

      function getListScrollContainer(filterElement: HTMLElement): HTMLElement | null {
        return filterElement.querySelector<HTMLElement>('.ListContainer .sfc-scrollable')
          ?? filterElement.querySelector<HTMLElement>('.ListContainer .sf-element-list-box')
          ?? filterElement.querySelector<HTMLElement>('.StyledScrollbar.ListContainerScroll .sfc-scrollable')
          ?? null;
      }

      async function wait(milliseconds: number): Promise<void> {
        await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, milliseconds); });
      }

      function mergeFilterOptionMaps(target: Map<string, boolean>, options: Array<{ label: string; selected: boolean }>): void {
        for (const option of options) {
          if (!option.label) {
            continue;
          }

          const existingSelected = target.get(option.label) ?? false;
          target.set(option.label, existingSelected || option.selected);
        }
      }

      async function collectListOptions(filterElement: HTMLElement): Promise<Array<{ label: string; selected: boolean }>> {
        const collectedOptions = new Map<string, boolean>();

        function collectVisibleOptions(): void {
          const visibleOptions = Array.from(filterElement.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
            .map(function (option) {
              return {
                label: normalize(option.getAttribute('title') ?? option.textContent),
                selected: option.classList.contains('sfpc-selected'),
              };
            })
            .filter(function (option) { return option.label.length > 0; });

          mergeFilterOptionMaps(collectedOptions, visibleOptions);
        }

        collectVisibleOptions();

        const scrollContainer = getListScrollContainer(filterElement);

        if (!scrollContainer) {
          return Array.from(collectedOptions.entries()).map(function ([label, selected]) {
            return { label, selected };
          });
        }

        const maxScrollTop = Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 0);
        const step = Math.max(Math.floor(scrollContainer.clientHeight * 0.75), 30);

        for (let offset = 0; offset <= maxScrollTop; offset += step) {
          scrollContainer.scrollTop = offset;
          scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(70);
          collectVisibleOptions();
        }

        scrollContainer.scrollTop = maxScrollTop;
        scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(100);
        collectVisibleOptions();

        return Array.from(collectedOptions.entries()).map(function ([label, selected]) {
          return { label, selected };
        });
      }

      async function extractFilter(filterElement: HTMLElement): Promise<SpotfireFilter | null> {
        const titleElement = filterElement.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        const title = normalize(titleElement?.getAttribute('title') ?? titleElement?.textContent);

        if (!title) {
          return null;
        }

        const rangeLabels = Array.from(filterElement.querySelectorAll<HTMLElement>('.ValueLabel'))
          .map(function (label) { return normalize(label.getAttribute('title') ?? label.textContent); })
          .filter(function (value) { return value.length > 0; });

        if (rangeLabels.length >= 2) {
          return {
            title,
            kind: 'range',
            selectedValues: rangeLabels.slice(0, 2),
            range: {
              min: rangeLabels[0],
              max: rangeLabels[1],
              selectedMin: rangeLabels[0],
              selectedMax: rangeLabels[1],
            },
          };
        }

        const toggleOptions = Array.from(filterElement.querySelectorAll<HTMLElement>('.ColumnFilter .sf-element-filter-item'))
          .map(function (option) {
            const labelElement = option.querySelector<HTMLElement>('.sf-element-text-box');
            const checkbox = option.querySelector<HTMLElement>('.sf-element-check-box');

            return {
              label: normalize(labelElement?.getAttribute('title') ?? labelElement?.textContent),
              selected: checkbox?.classList.contains('sfpc-checked') ?? false,
            };
          })
          .filter(function (option) { return option.label.length > 0; });

        if (toggleOptions.length > 0) {
          return {
            title,
            kind: 'toggle-group',
            selectedValues: toggleOptions.filter(function (option) { return option.selected; }).map(function (option) { return option.label; }),
            options: toggleOptions,
          };
        }

        const listRootExists = filterElement.querySelector('.VirtualListBox, .ListContainer, .sf-element-list-box-item') !== null;

        if (listRootExists) {
          const listOptions = await collectListOptions(filterElement);

          return {
            title,
            kind: 'list',
            selectedValues: listOptions.filter(function (option) { return option.selected; }).map(function (option) { return option.label; }),
            options: listOptions,
          };
        }

        const textInput = filterElement.querySelector<HTMLInputElement>('input[placeholder*="Type to filter by text"]');
        if (textInput) {
          const textValue = normalize(textInput.value);
          return {
            title,
            kind: 'text',
            selectedValues: textValue ? [textValue] : [],
            textValue,
          };
        }

        return {
          title,
          kind: 'unknown',
          selectedValues: [],
        };
      }

      function mergeFilters(target: Map<string, SpotfireFilter>, nextFilter: SpotfireFilter): void {
        const existing = target.get(nextFilter.title);

        if (!existing) {
          target.set(nextFilter.title, nextFilter);
          return;
        }

        if ((existing.kind === 'list' || existing.kind === 'toggle-group') && nextFilter.options) {
          const mergedOptions = new Map<string, boolean>();

          for (const option of existing.options ?? []) {
            mergedOptions.set(option.label, option.selected);
          }

          for (const option of nextFilter.options) {
            const currentSelected = mergedOptions.get(option.label) ?? false;
            mergedOptions.set(option.label, currentSelected || option.selected);
          }

          const normalizedOptions = Array.from(mergedOptions.entries()).map(function ([label, selected]) {
            return { label, selected };
          });

          target.set(nextFilter.title, {
            ...existing,
            ...nextFilter,
            options: normalizedOptions,
            selectedValues: normalizedOptions.filter(function (option) { return option.selected; }).map(function (option) { return option.label; }),
          });
          return;
        }

        target.set(nextFilter.title, {
          ...existing,
          ...nextFilter,
        });
      }

      const collectedFilters = new Map<string, SpotfireFilter>();
      const panelScrollContainer = getPanelScrollContainer();

      async function collectVisibleFilters(): Promise<void> {
        const visibleFilters = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter'));

        for (const filterElement of visibleFilters) {
          const extractedFilter = await extractFilter(filterElement);

          if (extractedFilter) {
            mergeFilters(collectedFilters, extractedFilter);
          }
        }
      }

      await collectVisibleFilters();

      if (panelScrollContainer) {
        const maxScrollTop = Math.max(panelScrollContainer.scrollHeight - panelScrollContainer.clientHeight, 0);
        const step = Math.max(Math.floor(panelScrollContainer.clientHeight * 0.75), 180);

        for (let offset = 0; offset <= maxScrollTop; offset += step) {
          panelScrollContainer.scrollTop = offset;
          panelScrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(120);
          await collectVisibleFilters();
        }

        panelScrollContainer.scrollTop = maxScrollTop;
        panelScrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(160);
        await collectVisibleFilters();

        for (let offset = maxScrollTop; offset >= 0; offset -= step) {
          panelScrollContainer.scrollTop = offset;
          panelScrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(100);
          await collectVisibleFilters();
        }
      }

      return Array.from(collectedFilters.values());
    });

    this.log('filter extraction from DOM finished', {
      count: filters.length,
    });

    return filters;
  }

  private async loadAvailableTables(page: Page): Promise<string[]> {
    const tables = await page.evaluate(function () {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      return Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual-title .sf-element-text-box[title], .sf-element-visual-title .sf-single-line-text[title]'))
        .map(function (element) { return normalize(element.getAttribute('title') ?? element.textContent); })
        .filter(function (title) { return title.length > 0; })
        .filter(function (title, index, list) { return list.indexOf(title) === index; });
    });

      return tables;
  }

  /**
   * Self-contained export of a single table: navigate to tab, maximize, trigger export, wait for download, minimize.
   * Works independently of what tab/table is currently active.
   */
  private async exportSingleTableFromTab(
    page: Page,
    outputDirectory: string,
    request: ScannerRunRequest,
    tab: string,
    tableTitle: string,
    label: string,
  ): Promise<string | undefined> {
    this.emitProgress(request, `${label} Navegando para aba "${tab}"...`);

    const { existingFiles } = await this.withSpotfireRecovery(page, async () => {
      await this.raceAbort(this.ensureNoMaximizedVisualization(page), request.signal);

      this.log(`navigating to tab: ${tab}`);
      await this.raceAbort(this.openAnalysisTab(page, tab), request.signal);
      await this.raceAbort(this.ensureNoMaximizedVisualization(page), request.signal);

      // Verify the tab actually switched by checking if the target table is visible
      const MAX_TAB_VERIFY = 2;
      for (let tabRetry = 0; tabRetry <= MAX_TAB_VERIFY; tabRetry++) {
        const available = await this.loadAvailableTables(page);
        if (available.some(function (t) { return t === tableTitle; })) break;

        if (tabRetry === MAX_TAB_VERIFY) {
          throw new Error(
            `tab switch to "${tab}" failed: "${tableTitle}" not visible after ${MAX_TAB_VERIFY + 1} attempts. Available: ${available.join(', ')}`,
          );
        }

        this.info(`Aba "${tab}" — tabela "${tableTitle}" não encontrada, retentando troca (${tabRetry + 1}/${MAX_TAB_VERIFY})...`);
        await new Promise(function (r) { return setTimeout(r, 1500); });
        await this.raceAbort(this.openAnalysisTab(page, tab), request.signal);
        await this.raceAbort(this.ensureNoMaximizedVisualization(page), request.signal);
      }

      this.info(`${label} Maximizando tabela: "${tableTitle}"`);
      this.emitProgress(request, `${label} Maximizando tabela "${tableTitle}"...`);
      this.log(`maximizing table: ${tableTitle}`);
      await this.raceAbort(this.maximizeTable(page, tableTitle), request.signal);

      this.emitProgress(request, `${label} Exportando tabela "${tableTitle}"...`);

      const tableRequest = { ...request, analysisTab: tab, tableTitle };
      const { existingFiles } = await this.raceAbort(
        this.triggerExport(page, outputDirectory, tableRequest),
        request.signal,
      );
      return { existingFiles };
    }, request);

    this.emitProgress(request, `${label} Aguardando download de "${tableTitle}"...`);
    const tableRequest = { ...request, analysisTab: tab, tableTitle };
    const exportedFile = await this.raceAbort(
      this.awaitExportDownload(outputDirectory, existingFiles, tableRequest),
      request.signal,
    );

    // Page.setDownloadBehavior é browser-wide (não por aba) nesta versão do CDP.
    // Resetar imediatamente após o download evita que outros tabs (ex: frontend Angular)
    // também salvem arquivos no outputDirectory em vez de ~/Downloads.
    try {
      const resetSession = await page.createCDPSession();
      await resetSession.send('Page.setDownloadBehavior', { behavior: 'default' });
      await resetSession.detach();
    } catch {
      // Não-crítico: session pode já estar encerrada
    }

    this.log(`minimizing table "${tableTitle}" after download`);
    await this.raceAbort(this.ensureNoMaximizedVisualization(page), request.signal);

    if (exportedFile) {
      this.info(`${label} Download "${tableTitle}" concluído ✓`);
      this.emitProgress(request, `${label} Tabela "${tableTitle}" baixada ✓`);
    } else {
      this.info(`${label} Download "${tableTitle}" — nenhum arquivo gerado`);
    }

    return exportedFile;
  }

  private async maximizeTable(page: Page, tableTitle: string): Promise<void> {
    this.log(`attempting to maximize table: "${tableTitle}"`);
    
    // First, find the matching title element and hover over it to reveal the maximize button
    const findResult = await page.evaluate(function (requestedTableTitle) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      const requested = normalize(requestedTableTitle);
      const requestedLower = requested.toLowerCase();
      
      const titles = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual-title'));
      const allTitles = titles.map(function (titleElement) {
        const textElement = titleElement.querySelector<HTMLElement>('.sf-element-text-box[title], .sf-single-line-text[title]');
        return normalize(textElement?.getAttribute('title') ?? textElement?.textContent);
      });

      // Try exact match first, then includes, then case-insensitive includes
      const matchIndex = titles.findIndex(function (titleElement) {
        const textElement = titleElement.querySelector<HTMLElement>('.sf-element-text-box[title], .sf-single-line-text[title]');
        const title = normalize(textElement?.getAttribute('title') ?? textElement?.textContent);
        return title === requested;
      });

      const includesIndex = matchIndex >= 0 ? matchIndex : titles.findIndex(function (titleElement) {
        const textElement = titleElement.querySelector<HTMLElement>('.sf-element-text-box[title], .sf-single-line-text[title]');
        const title = normalize(textElement?.getAttribute('title') ?? textElement?.textContent);
        return title.includes(requested) || title.toLowerCase().includes(requestedLower);
      });

      const finalIndex = includesIndex >= 0 ? includesIndex : -1;

      if (finalIndex < 0) {
        return { found: false, allTitles, requested };
      }

      // Get bounding rect for hover
      const titleElement = titles[finalIndex];
      const rect = titleElement.getBoundingClientRect();
      return {
        found: true,
        allTitles,
        requested,
        matchedTitle: allTitles[finalIndex],
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }, tableTitle);

    this.log(`find result for "${tableTitle}":`, findResult);

    if (!findResult.found) {
      throw new Error(`could not maximize table: ${tableTitle} - no matching title found. Available titles: ${findResult.allTitles?.join(', ')}`);
    }

    // Hover over the title element to reveal the maximize button
    await page.mouse.move(findResult.x!, findResult.y!);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Now try to click the maximize button
    const clickResult = await page.evaluate(function (requestedTableTitle) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      const requested = normalize(requestedTableTitle);
      const requestedLower = requested.toLowerCase();

      const titles = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual-title'));

      const matchingTitle = titles.find(function (titleElement) {
        const textElement = titleElement.querySelector<HTMLElement>('.sf-element-text-box[title], .sf-single-line-text[title]');
        const title = normalize(textElement?.getAttribute('title') ?? textElement?.textContent);
        return title === requested || title.includes(requested) || title.toLowerCase().includes(requestedLower);
      });

      if (!matchingTitle) {
        return { success: false, reason: 'title not found after hover' };
      }

      // Look for maximize button in the title bar or its parent visual container
      const visual = matchingTitle.closest<HTMLElement>('.sfpc-visual, .sf-element-visual, [class*="visual-content"]') ?? matchingTitle.parentElement;
      const searchRoot = visual ?? matchingTitle;

      const maximizeButton = searchRoot.querySelector<HTMLElement>('[title="Maximize visualization"], .sfc-maximize-visual-button')
        ?? matchingTitle.querySelector<HTMLElement>('[title="Maximize visualization"], .sfc-maximize-visual-button');

      if (!maximizeButton) {
        return { success: false, reason: 'no maximize button found after hover' };
      }

      maximizeButton.click();
      return { success: true };
    }, tableTitle);

    this.log(`maximize click result for "${tableTitle}":`, clickResult);

    if (!clickResult.success) {
      throw new Error(`could not maximize table: ${tableTitle} - ${clickResult.reason}`);
    }

    await this.waitForSpotfireIdle(page);
    this.log(`table "${tableTitle}" maximized successfully`);
  }

  private async exportTable(page: Page, outputDirectory: string, request: ScannerRunRequest): Promise<string | undefined> {
    this.log(`starting export for table: "${request.tableTitle}" to directory: ${outputDirectory}`);
    
    const cdpSession = await page.createCDPSession();
    await cdpSession.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: outputDirectory,
    });

    const existingFiles = new Set(await readdir(outputDirectory));
    this.log(`existing files in output directory: ${Array.from(existingFiles).join(', ') || '(none)'}`);
    
    this.log(`opening export menu for table: "${request.tableTitle}"`);
    await this.openExportMenu(page, request.tableTitle);
    
    this.log('clicking export menu action...');
    await this.clickExportMenuAction(page);

    this.log('waiting for download to complete...');
    const downloadedFile = await this.waitForDownloadedFile(outputDirectory, existingFiles);
    this.log(`download result: ${downloadedFile ?? '(no file downloaded)'}`);

    try {
      await cdpSession.send('Page.setDownloadBehavior', { behavior: 'default' });
      await cdpSession.detach();
    } catch { /* não-crítico */ }

    return this.finalizeDownloadedFile(outputDirectory, downloadedFile, request);
  }

  private async triggerExport(page: Page, outputDirectory: string, request: ScannerRunRequest): Promise<{ existingFiles: Set<string> }> {
    this.log(`triggering export for table: "${request.tableTitle}" to directory: ${outputDirectory}`);

    const cdpSession = await page.createCDPSession();
    await cdpSession.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: outputDirectory,
    });

    const existingFiles = new Set(await readdir(outputDirectory));
    this.log(`existing files in output directory before export: ${Array.from(existingFiles).join(', ') || '(none)'}`);

    this.log(`opening export menu for table: "${request.tableTitle}"`);
    await this.openExportMenu(page, request.tableTitle);

    this.log('clicking export menu action...');
    await this.clickExportMenuAction(page);

    this.log(`export triggered for "${request.tableTitle}", not waiting for download`);
    return { existingFiles };
  }

  private async awaitExportDownload(outputDirectory: string, existingFiles: Set<string>, request: ScannerRunRequest): Promise<string | undefined> {
    this.log(`waiting for download of "${request.tableTitle}"...`);
    const downloadedFile = await this.waitForDownloadedFile(outputDirectory, existingFiles);
    this.log(`download result for "${request.tableTitle}": ${downloadedFile ?? '(no file downloaded)'}`);
    return this.finalizeDownloadedFile(outputDirectory, downloadedFile, request);
  }

  private async detectAndDismissErrorPopup(page: Page): Promise<string | null> {
    try {
      return await page.evaluate(() => {
        function isVisible(el: HTMLElement): boolean {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }

      // Spotfire error/notification popups: look for modal dialogs, message boxes, notification bars
      const selectors = [
        '.sf-element-modal-dialog',
        '.sfpc-modal-dialog',
        '.sfc-notification-dialog',
        '.sf-element-notification',
        '.MessageDialog',
        '.sf-element-dialog',
        '[class*="modal-dialog"]',
        '[class*="error-dialog"]',
        '[class*="notification-dialog"]',
        '[role="alertdialog"]',
        '[role="dialog"]',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll<HTMLElement>(selector);
        for (const el of elements) {
          if (!isVisible(el)) continue;

          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          // Only treat as error if it has meaningful content (not just filter/settings dialogs)
          const lowerText = text.toLowerCase();
          if (
            lowerText.includes('error') ||
            lowerText.includes('erro') ||
            lowerText.includes('fail') ||
            lowerText.includes('exception') ||
            lowerText.includes('unable') ||
            lowerText.includes('cannot') ||
            lowerText.includes('could not') ||
            lowerText.includes('não foi possível')
          ) {
            // Try to dismiss it
            const closeButtons = el.querySelectorAll<HTMLElement>(
              'button, [role="button"], .sf-element-modal-dialog-close, [title="Close"], [title="OK"], [title="Fechar"]'
            );
            for (const btn of closeButtons) {
              if (isVisible(btn)) {
                const btnText = (btn.textContent ?? '').trim().toLowerCase();
                const btnTitle = (btn.getAttribute('title') ?? '').toLowerCase();
                if (
                  btnText === 'ok' || btnText === 'close' || btnText === 'fechar' ||
                  btnTitle === 'close' || btnTitle === 'ok' || btnTitle === 'fechar' ||
                  btn.classList.contains('sf-element-modal-dialog-close')
                ) {
                  btn.click();
                  break;
                }
              }
            }

            // Extract just the message content (truncate long texts)
            const message = text.length > 200 ? text.slice(0, 200) + '...' : text;
            return message;
          }
        }
      }

      return null;
    });
    } catch {
      // Ignore errors from popup detection (e.g. page navigating, session closed)
      return null;
    }
  }

  private startErrorPopupMonitor(
    page: Page,
    request: ScannerRunRequest,
  ): { stop: () => void; getLastError: () => string | null } {
    let lastError: string | null = null;
    let running = true;

    const poll = async () => {
      while (running) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!running) break;

        const errorMessage = await this.detectAndDismissErrorPopup(page);
        if (errorMessage) {
          lastError = errorMessage;
          this.logStep('popup-monitor', 'WARN', `Spotfire error popup detected: ${errorMessage}`);
          this.emitProgress(request, `Erro no Spotfire: ${errorMessage}`);
        }
      }
    };

    // Fire-and-forget — runs concurrently
    void poll();

    return {
      stop: () => { running = false; },
      getLastError: () => lastError,
    };
  }

  private async clickExportMenuAction(page: Page): Promise<void> {
    const result = await page.evaluate(async () => {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      }

      function isVisible(element: HTMLElement): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      function menuEntries(): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>('.contextMenuItemLabel, .contextMenuItem, [title]'))
          .filter((element) => isVisible(element));
      }

      function getMenuInfo(): Array<{ title: string; text: string }> {
        return menuEntries().map((el) => ({
          title: el.getAttribute('title') ?? '',
          text: (el.textContent ?? '').trim(),
        }));
      }

      function findMenuItem(label: string): HTMLElement | null {
        const normalizedLabel = normalize(label);
        return menuEntries().find((element) => {
          const title = normalize(element.getAttribute('title'));
          const text = normalize(element.textContent);
          return title === normalizedLabel || text === normalizedLabel;
        }) ?? null;
      }

      const menuInfo = getMenuInfo();

      // Step 1: Try to click "Export table" directly
      const exportTableDirect = findMenuItem('Export table');
      if (exportTableDirect) {
        exportTableDirect.click();
        return { clicked: true, step: 'direct Export table', menuInfo };
      }

      // Step 2: Look for "Export" parent menu (has submenu arrow)
      const exportParent = findMenuItem('Export');
      if (exportParent) {
        // Hover to open submenu
        exportParent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        exportParent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        
        await new Promise((resolveWait) => window.setTimeout(resolveWait, 300));

        // Now look for "Export table" in the submenu
        const exportTableInSubmenu = findMenuItem('Export table');
        if (exportTableInSubmenu) {
          exportTableInSubmenu.click();
          return { clicked: true, step: 'Export -> Export table', menuInfo };
        }

        // Click the parent anyway if submenu didn't open properly
        exportParent.click();
        await new Promise((resolveWait) => window.setTimeout(resolveWait, 300));

        const exportTableAfterClick = findMenuItem('Export table');
        if (exportTableAfterClick) {
          exportTableAfterClick.click();
          return { clicked: true, step: 'Export click -> Export table', menuInfo };
        }

        return { clicked: false, step: 'Export parent found but no Export table in submenu', menuInfo: getMenuInfo() };
      }

      // Step 3: Fallback - try other common export labels
      const fallbacks = ['Data to file', 'Data to file...', 'Export data', 'CSV'];
      for (const label of fallbacks) {
        const item = findMenuItem(label);
        if (item) {
          item.click();
          return { clicked: true, step: `fallback: ${label}`, menuInfo };
        }
      }

      return { clicked: false, step: 'no export option found', menuInfo };
    });

    this.log('clickExportMenuAction result:', result);

    if (!result.clicked) {
      throw new Error(`could not find export action after opening the context menu for ${this.environment.spotfire.exportMenuLabel}. Available menu items: ${JSON.stringify(result.menuInfo)}`);
    }
  }

  private async openExportMenu(page: Page, tableTitle?: string): Promise<void> {
    const exportAlreadyVisible = await this.isExportMenuVisible(page);

    if (exportAlreadyVisible) {
      return;
    }

    const openedFromContextButton = await page.evaluate(async function ({ exportMenuLabel, exportParentMenuLabel, requestedTableTitle }) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      function isVisible(element: HTMLElement): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      function hasExportAction(): boolean {
        return Array.from(document.querySelectorAll<HTMLElement>('[title], .contextMenuItemLabel, .contextMenuItem'))
          .filter(function (element) { return isVisible(element); })
          .some(function (element) {
            const values = [
              normalize(element.getAttribute('title')),
              normalize(element.textContent),
            ].filter(function (value) { return value.length > 0; });

            return values.some(function (value) { return value.includes(exportMenuLabel) || value.includes(exportParentMenuLabel); });
          });
      }

      async function dispatchContextMenu(target: HTMLElement): Promise<boolean> {
        const rect = target.getBoundingClientRect();

        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: 2,
          clientX: rect.left + Math.min(rect.width / 2, 20),
          clientY: rect.top + Math.min(rect.height / 2, 20),
        }));

        await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, 300); });
        return hasExportAction();
      }

      // PRIORITY 1: If there is a maximized visualization, export from it directly
      const restoreButton = document.querySelector<HTMLElement>('.sfc-maximize-visual-button[title="Restore visualization layout"]');
      if (restoreButton && isVisible(restoreButton)) {
        // Find the maximized visualization container
        const maximizedVisual = restoreButton.closest<HTMLElement>('.sf-element-visual-title, .sfpc-visual, [class*="visual"]');
        if (maximizedVisual) {
          const contextButton = maximizedVisual.querySelector<HTMLElement>('.ContextButton');
          if (contextButton && isVisible(contextButton)) {
            contextButton.click();
            await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, 250); });

            if (hasExportAction()) {
              return true;
            }
          }

          // Try context menu on the maximized visual itself
          if (await dispatchContextMenu(maximizedVisual)) {
            return true;
          }
        }

        // Try finding the visual container via parent traversal
        let parent: HTMLElement | null = restoreButton.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const contextButton = parent.querySelector<HTMLElement>('.ContextButton');
          if (contextButton && isVisible(contextButton)) {
            contextButton.click();
            await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, 250); });

            if (hasExportAction()) {
              return true;
            }
          }

          if (await dispatchContextMenu(parent)) {
            return true;
          }

          parent = parent.parentElement;
        }
      }

      // PRIORITY 2: Find by requested table title
      if (requestedTableTitle) {
        const requested = normalize(requestedTableTitle);
        const titleContainers = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual-title'));
        const matchingContainer = titleContainers.find(function (titleElement) {
          const labelElement = titleElement.querySelector<HTMLElement>('.sf-element-text-box[title], .sf-single-line-text[title]');
          const title = normalize(labelElement?.getAttribute('title') ?? labelElement?.textContent);
          return title === requested || title.includes(requested);
        });

        if (matchingContainer) {
          const contextButton = matchingContainer.querySelector<HTMLElement>('.ContextButton');
          if (contextButton && isVisible(contextButton)) {
            contextButton.click();
            await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, 250); });

            if (hasExportAction()) {
              return true;
            }
          }

          const visualizationRoot = matchingContainer.parentElement?.parentElement as HTMLElement | null;
          if (visualizationRoot && isVisible(visualizationRoot) && await dispatchContextMenu(visualizationRoot)) {
            return true;
          }
        }
      }

      // PRIORITY 3: Fallback to any visible context button (excluding filters)
      const contextButtons = Array.from(document.querySelectorAll<HTMLElement>('.ContextButton'))
        .filter(function (element) { return isVisible(element); })
        .filter(function (element) { return !element.closest('.sfc-filter-panel') && !element.closest('.FilterPanelScroll'); });

      for (const button of contextButtons) {
        button.click();
        await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, 250); });

        if (hasExportAction()) {
          return true;
        }
      }

      const visualizationCandidates = Array.from(document.querySelectorAll<HTMLElement>('[class*="visual"], [class*="table"], canvas, svg'))
        .filter(function (element) { return isVisible(element); })
        .filter(function (element) { return !element.closest('.sfc-filter-panel') && !element.closest('.FilterPanelScroll'); })
        .sort(function (left, right) {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
        });

      for (const candidate of visualizationCandidates.slice(0, 8)) {
        if (await dispatchContextMenu(candidate)) {
          return true;
        }
      }

      return false;
    }, {
      exportMenuLabel: this.environment.spotfire.exportMenuLabel,
      exportParentMenuLabel: this.environment.spotfire.exportParentMenuLabel,
      requestedTableTitle: tableTitle,
    });

    if (openedFromContextButton) {
      return;
    }

    throw new Error(`could not open export menu for action: ${this.environment.spotfire.exportMenuLabel}`);
  }

  private async isExportMenuVisible(page: Page): Promise<boolean> {
    return page.evaluate(function (exportMenuLabel) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      function isVisible(element: HTMLElement): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      return Array.from(document.querySelectorAll<HTMLElement>('[title], .contextMenuItemLabel, .contextMenuItem'))
        .filter(function (element) { return isVisible(element); })
        .some(function (element) {
          const values = [
            normalize(element.getAttribute('title')),
            normalize(element.textContent),
          ].filter(function (value) { return value.length > 0; });

          return values.some(function (value) { return value.includes(exportMenuLabel); });
        });
    }, this.environment.spotfire.exportMenuLabel);
  }

  private async waitForDownloadedFile(outputDirectory: string, existingFiles: Set<string>): Promise<string> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < DOWNLOAD_TIMEOUT_MS) {
      const files = await readdir(outputDirectory);
      const freshFile = files.find((fileName) => !existingFiles.has(fileName));

      if (freshFile && !freshFile.endsWith('.crdownload')) {
        const filePath = join(outputDirectory, freshFile);
        const fileStats = await stat(filePath);

        if (fileStats.isFile()) {
          return freshFile;
        }
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, DOWNLOAD_POLL_INTERVAL_MS));
    }

    throw new Error('timed out waiting for Spotfire export download');
  }

  private async finalizeDownloadedFile(
    outputDirectory: string,
    downloadedFileName: string,
    request: ScannerRunRequest,
  ): Promise<string> {
    const sourcePath = join(outputDirectory, downloadedFileName);
    const extension = extname(downloadedFileName).toLowerCase() || '.csv';
    const normalizedExtension = DOWNLOAD_EXTENSIONS.has(extension) ? extension : '.csv';
    const safeReportTitle = this.slugify(request.reportTitle ?? this.environment.spotfire.defaultReportTitle);
    const safeTab = this.slugify(request.analysisTab ?? 'active-tab');
    const safeTable = this.slugify(request.tableTitle ?? 'export');
    const finalFileName = `${safeReportTitle}-${safeTab}-${safeTable}-${randomUUID()}${normalizedExtension}`;
    const finalPath = join(outputDirectory, finalFileName);

    await rename(sourcePath, finalPath);
    return finalPath;
  }

  private async prepareOutputDirectory(): Promise<string> {
    const baseOutputDirectory = resolve(process.cwd(), this.environment.spotfire.outputDirectory);
    const runDirectory = join(baseOutputDirectory, new Date().toISOString().replace(/[.:]/g, '-'));
    await mkdir(runDirectory, { recursive: true });
    return runDirectory;
  }

  private slugify(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'scanner-export';
  }

  private buildYearMonthFilters(filters: SpotfireFilter[], periodSelection: NonNullable<ScannerRunRequest['periodSelection']>): SpotfireFilter[] {
    const yearValues = this.normalizePeriodSelectionValues(periodSelection.year);
    const monthValues = this.normalizePeriodSelectionValues(periodSelection.month);
    const builtFilters: SpotfireFilter[] = [];
    const resolvedYearTitle = this.resolveActualFilterTitle(filters, 'Ano');
    const resolvedMonthTitle = this.resolveActualFilterTitle(filters, 'Mês');

    if (yearValues.length > 0 && resolvedYearTitle) {
      const yearFilter = filters.find((filter) => this.normalizeFilterName(filter.title) === this.normalizeFilterName(resolvedYearTitle));
      const yearSelectedValues = yearValues.includes(ALL_OPTION)
        ? (yearFilter?.options ?? [])
          .map((option) => option.label)
          .filter((option) => /^\d{4}$/.test(option.trim()))
        : Array.from(new Set(yearValues));

      builtFilters.push({
        title: resolvedYearTitle,
        kind: yearFilter?.kind ?? 'list',
        selectedValues: yearSelectedValues,
      });
    }

    if (monthValues.length > 0 && resolvedMonthTitle) {
      const monthFilter = filters.find((filter) => this.normalizeFilterName(filter.title) === this.normalizeFilterName(resolvedMonthTitle));
      const monthSelectedValues = monthValues.includes(ALL_OPTION)
        ? (monthFilter?.options ?? [])
          .map((option) => option.label)
          .filter((option) => option !== ALL_OPTION && option !== '...')
        : Array.from(new Set(monthValues.filter((value) => value !== ALL_OPTION)));

      builtFilters.push({
        title: resolvedMonthTitle,
        kind: monthFilter?.kind ?? 'list',
        selectedValues: monthSelectedValues,
      });
    }

    return builtFilters;
  }

  private buildFiltersToApply(availableFilters: SpotfireFilter[], request: ScannerRunRequest): SpotfireFilter[] {
    const requestedFilters = this.resolveRequestedFilters(availableFilters, request.selectedFilters ?? []);
    const filtersToApply = [...requestedFilters];

    if (!request.periodSelection) {
      return this.orderFiltersForApplication(filtersToApply);
    }

    filtersToApply.push(...this.buildYearMonthFilters(availableFilters, request.periodSelection));

    this.log('period selection resolved — Data Referência will be applied in right panel after left-panel filters', {
      year: this.normalizePeriodSelectionValues(request.periodSelection.year),
      month: this.normalizePeriodSelectionValues(request.periodSelection.month),
      dayRange: request.periodSelection.dayRange ?? null,
    });

    return this.orderFiltersForApplication(filtersToApply);
  }

  private orderFiltersForApplication(filters: SpotfireFilter[]): SpotfireFilter[] {
    const orderedTitles = ['ano', 'mes', 'atuacao', 'base'];

    return [...filters]
      .map((filter, index) => ({ filter, index }))
      .sort((left, right) => {
        const leftPriority = this.filterApplicationPriority(left.filter.title, orderedTitles);
        const rightPriority = this.filterApplicationPriority(right.filter.title, orderedTitles);

        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }

        return left.index - right.index;
      })
      .map((entry) => entry.filter);
  }

  private filterApplicationPriority(filterTitle: string, orderedTitles: string[]): number {
    const normalized = this.normalizeFilterName(filterTitle);
    const matchedIndex = orderedTitles.findIndex((title) => {
      if (title === 'atuacao') {
        return normalized === 'atuacao' || normalized === 'atuacaohd';
      }

      return normalized === title;
    });

    return matchedIndex === -1 ? orderedTitles.length : matchedIndex;
  }

  private buildReferenceDateFilter(filters: SpotfireFilter[], periodSelection: NonNullable<ScannerRunRequest['periodSelection']>): SpotfireFilter | undefined {
    const resolvedReferenceTitle = this.resolveActualFilterTitle(filters, 'Data Referência');
    const referenceDateFilter = resolvedReferenceTitle
      ? filters.find((filter) => this.normalizeFilterName(filter.title) === this.normalizeFilterName(resolvedReferenceTitle))
      : undefined;

    if (!referenceDateFilter?.options?.length) {
      this.log('could not derive Data Referência filter because options are unavailable');
      return undefined;
    }

    const normalizedYears = this.normalizePeriodSelectionValues(periodSelection.year).filter((value) => value !== ALL_OPTION);
    const normalizedMonths = this.normalizePeriodSelectionValues(periodSelection.month).filter((value) => value !== ALL_OPTION);
    const selectedMonthIndexes = normalizedMonths.map((value) => MONTH_OPTIONS.indexOf(value.toLowerCase())).filter((value) => value !== -1);
    const minDay = periodSelection.dayRange?.min ?? 1;
    const maxDay = periodSelection.dayRange?.max ?? 31;

    const selectedValues = referenceDateFilter.options
      .map((option) => option.label)
      .filter((label) => !label.startsWith('(All)') && label !== '...')
      .filter((label) => {
        const parsedDate = this.parseReferenceDate(label);

        if (!parsedDate) {
          return false;
        }

        if (normalizedYears.length > 0 && !normalizedYears.includes(String(parsedDate.getFullYear()))) {
          return false;
        }

        if (selectedMonthIndexes.length > 0 && !selectedMonthIndexes.includes(parsedDate.getMonth())) {
          return false;
        }

        const day = parsedDate.getDate();
        return day >= minDay && day <= maxDay;
      });

    if (!selectedValues.length) {
      this.log('period selection did not resolve any Data Referência values', {
        year: normalizedYears,
        month: normalizedMonths,
        minDay,
        maxDay,
      });
      return undefined;
    }

    return {
      title: referenceDateFilter.title,
      kind: 'list',
      selectedValues,
    };
  }

  private normalizePeriodSelectionValues(value: string | string[] | undefined): string[] {
    if (Array.isArray(value)) {
      return Array.from(new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)));
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return [value.trim()];
    }

    return [];
  }

  private resolveRequestedFilters(availableFilters: SpotfireFilter[], requestedFilters: SpotfireFilter[]): SpotfireFilter[] {
    const resolvedFilters: SpotfireFilter[] = [];

    for (const requestedFilter of requestedFilters) {
      const resolvedTitle = this.resolveActualFilterTitle(availableFilters, requestedFilter.title);

      if (!resolvedTitle) {
        this.logStep('filters', 'WARN', 'requested frontend filter was not found in Spotfire filter bar', {
          requestedTitle: requestedFilter.title,
          availableTitlesSample: availableFilters.slice(0, 12).map((filter) => filter.title),
        });

        // Keep the original title so `locateFilterElement` can still find it by scrolling.
        // The initial scan is intentionally shallow (to avoid slow sweeps), so some filters
        // won't be in `availableFilters` but still exist above in the panel.
        resolvedFilters.push(requestedFilter);
        continue;
      }

      resolvedFilters.push({
        ...requestedFilter,
        title: resolvedTitle,
      });
    }

    return resolvedFilters;
  }

  private resolveActualFilterTitle(availableFilters: SpotfireFilter[], requestedTitle: string): string | undefined {
    const requestedAliases = this.filterTitleAliases(requestedTitle).map((alias) => this.normalizeFilterName(alias));

    const match = availableFilters.find((filter) => requestedAliases.includes(this.normalizeFilterName(filter.title)));
    return match?.title;
  }

  private filterTitleAliases(requestedTitle: string): string[] {
    const normalized = this.normalizeFilterName(requestedTitle);

    if (normalized === 'atuacaohd' || normalized === 'atuacao') {
      return ['Atuação', 'Atuacao', 'AtuaçãoHD', 'AtuacaoHD'];
    }

    if (normalized === 'base') {
      return ['Base'];
    }

    if (normalized === 'ano' || normalized === 'year') {
      return ['Ano', 'Year'];
    }

    if (normalized === 'mes' || normalized === 'mês' || normalized === 'month') {
      return ['Mês', 'Mes', 'Month'];
    }

    if (normalized === 'data referencia' || normalized === 'data referência') {
      return ['Data Referência', 'Data Referencia'];
    }

    return [requestedTitle];
  }

  private normalizeFilterName(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private parseReferenceDate(label: string): Date | undefined {
    const normalizedLabel = label.trim();
    const usParts = normalizedLabel.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

    if (usParts) {
      const month = Number(usParts[1]) - 1;
      const day = Number(usParts[2]);
      const year = Number(usParts[3]);
      const parsedDate = new Date(year, month, day);

      return Number.isNaN(parsedDate.getTime()) ? undefined : parsedDate;
    }

    const directDate = new Date(normalizedLabel);

    if (!Number.isNaN(directDate.getTime())) {
      return directDate;
    }

    const parts = normalizedLabel.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!parts) {
      return undefined;
    }

    const day = Number(parts[1]);
    const month = Number(parts[2]) - 1;
    const year = Number(parts[3]);
    const parsedDate = new Date(year, month, day);

    return Number.isNaN(parsedDate.getTime()) ? undefined : parsedDate;
  }

  private async clickByText(page: Page, text: string, exact = true): Promise<void> {
    const clicked = await this.tryClickByText(page, text, exact);

    if (!clicked) {
      throw new Error(`could not find clickable text: ${text}`);
    }
  }

  private async tryClickByText(page: Page, text: string, exact = true): Promise<boolean> {
    return page.evaluate(
      function ({ requestedText, exactMatch }) {
        function normalize(value: string | null | undefined): string {
          return (value ?? '').replace(/\s+/g, ' ').trim();
        }

        const requested = normalize(requestedText);
        const clickableElements = Array.from(
          document.querySelectorAll<HTMLElement>('button, a, span, div, label'),
        );

        const element = clickableElements.find(function (candidate) {
          const title = normalize(candidate.getAttribute('title'));
          const alt = normalize(candidate.getAttribute('alt'));
          const textContent = normalize(candidate.textContent);
          const candidates = [title, alt, textContent].filter(function (value) { return value.length > 0; });

          if (exactMatch) {
            return candidates.some(function (value) { return value === requested; });
          }

          return candidates.some(function (value) { return value.includes(requested); });
        });

        if (!element) {
          return false;
        }

        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return true;
      },
      { requestedText: text, exactMatch: exact },
    );
  }

  private async isAnalysisReady(page: Page): Promise<boolean> {
    const ready = await page.evaluate(function () {
      const selectors = [
        '.sf-element-page-tab',
        '.sfx_page-tab_204',
        '.sf-element-visual-title',
        '.sf-element-filter',
        '.FilterPanelScroll',
        '[title="Reset Visible Filters"]',
      ];

      return selectors.some(function (selector) {
        return document.querySelector(selector) !== null;
      });
    });

    if (ready) {
      return true;
    }

    await page.waitForSelector(
      '.sf-element-page-tab, .sfx_page-tab_204, .sf-element-visual-title, .sf-element-filter, .FilterPanelScroll, [title="Reset Visible Filters"]',
      { timeout: 30000 },
    ).catch(function () { return undefined; });

    return page.evaluate(function () {
      const selectors = [
        '.sf-element-page-tab',
        '.sfx_page-tab_204',
        '.sf-element-visual-title',
        '.sf-element-filter',
        '.FilterPanelScroll',
        '[title="Reset Visible Filters"]',
      ];

      return selectors.some(function (selector) {
        return document.querySelector(selector) !== null;
      });
    });
  }

  private async waitForSpotfireIdle(page: Page, timeoutMs: number = 120000): Promise<void> {
    await page.waitForFunction(
      function () {
        const activeBusyElement = document.querySelector('.sf-busy, [sf-busy="true"]');
        const activeProgress = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-progress-animation'))
          .some(function (element) {
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });

        return !activeBusyElement && !activeProgress;
      },
      { timeout: timeoutMs },
    ).catch(() => undefined);
  }

  // ── Right-panel "Data Referência" filter ──────────────────────────────

  /**
   * Opens the right-side Filters panel via View > Filters menu if not already open.
   * Checks for the panel header `.sf-element-panel-header` with text "Filters".
   */
  private async ensureRightFiltersPanelOpen(page: Page): Promise<void> {
    this.logStep('right-panel', 'START', 'checking if Filters panel is already open');

    const alreadyOpen = await page.evaluate(function () {
      function isVisible(el: HTMLElement | null | undefined): el is HTMLElement {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
      }

      // Check for filter panel header with "Filters" text
      const headers = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-panel-header'));
      for (const header of headers) {
        const span = header.querySelector<HTMLElement>('span.sf-element-text-box');
        if (span && (span.textContent ?? '').trim().toLowerCase() === 'filters' && isVisible(header)) {
          return true;
        }
      }

      // Also check for sfc-filter-panel or FilterPanelScroll
      const panel = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
      return panel !== null && isVisible(panel);
    });

    if (alreadyOpen) {
      this.logStep('right-panel', 'OK', 'Filters panel is already open');
      return;
    }

    // Open via View > Filters menu
    this.logStep('right-panel', 'START', 'opening Filters panel via View > Filters menu');

    const resolveMenuCoords = async (label: string): Promise<{ x: number; y: number } | null> => {
      return page.evaluate((requestedLabel: string) => {
        function normalize(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        }

        function isVisible(el: HTMLElement | null | undefined): el is HTMLElement {
          if (!el) return false;
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
        }

        const wanted = normalize(requestedLabel);
        const el = Array.from(document.querySelectorAll<HTMLElement>('[title], .contextMenuItemLabel, .sfx_menu-item_497, button, div, span, label'))
          .filter((c) => isVisible(c))
          .find((c) => {
            const title = normalize(c.getAttribute('title'));
            const text = normalize(c.textContent);
            return title === wanted || text === wanted;
          });

        if (!el) return null;

        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) };
      }, label);
    };

    const viewMenu = await resolveMenuCoords('View');
    if (!viewMenu) {
      this.logStep('right-panel', 'FAIL', 'could not find View menu');
      throw new Error('View menu entry not found for opening Filters panel');
    }

    await page.mouse.click(viewMenu.x, viewMenu.y);
    await new Promise((r) => setTimeout(r, 300));

    const filtersItem = await resolveMenuCoords('Filters');
    if (!filtersItem) {
      // Close menu by pressing Escape
      await page.keyboard.press('Escape');
      this.logStep('right-panel', 'FAIL', 'could not find Filters menu item');
      throw new Error('Filters menu item not found under View menu');
    }

    await page.mouse.click(filtersItem.x, filtersItem.y);
    await new Promise((r) => setTimeout(r, 500));
    await this.waitForSpotfireIdle(page);
    this.logStep('right-panel', 'OK', 'Filters panel opened via View > Filters');
  }

  /**
   * Scrolls to an item in the right-panel Data Referência filter using scroll buttons.
   * Returns true if the item was found and scrolled into view.
   */
  /**
   * Scrolls the list inside a right-panel filter back to the very top by
   * clicking its "up" scroll button repeatedly until the first real item is visible.
   */
  private async scrollRightPanelFilterToTop(page: Page, filterTitle: string): Promise<void> {
    const scrollButtons = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');

      if (!panelRoot) return null;

      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });

      if (!filterEl) return null;

      const upButton = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-top');
      if (!upButton) return null;

      const rect = upButton.getBoundingClientRect();
      let totalItems = 300;
      for (const item of filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item')) {
        const match = (item.getAttribute('title') ?? '').match(/\(All\)\s+(\d+)/i);
        if (match) { totalItems = parseInt(match[1], 10); break; }
      }

      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), totalItems };
    }, filterTitle);

    if (!scrollButtons) {
      this.log('scrollRightPanelFilterToTop: scroll button not found, skipping', { filterTitle });
      return;
    }

    // Click the "up" button enough times to guarantee we reach position 0.
    const clicks = scrollButtons.totalItems + 5;
    for (let i = 0; i < clicks; i++) {
      await page.mouse.click(scrollButtons.x, scrollButtons.y);
      await new Promise((r) => setTimeout(r, 40));
    }

    this.log('scrollRightPanelFilterToTop: scrolled to top', { filterTitle, clicks });
  }

  /**
   * Returns the number of calendar days (= scroll clicks) between two dates
   * in DD/MM/YYYY format. Always positive (from < to assumed).
   */
  /** Returns true if the down-scroll button of the filter appears to be at the bottom (disabled). */
  private async isRightPanelScrollAtBottom(page: Page, filterTitle: string): Promise<boolean> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
      if (!panelRoot) return false;
      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });
      if (!filterEl) return false;
      const downBtn = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-bottom');
      if (!downBtn) return false;
      // Spotfire marks the button as disabled via class or attribute when at bottom edge.
      if (downBtn.classList.contains('sfpc-disabled') || downBtn.classList.contains('disabled')) return true;
      if (downBtn.hasAttribute('disabled') || downBtn.getAttribute('aria-disabled') === 'true') return true;
      // Fallback: check the scroll container's scrollTop vs scrollHeight.
      const sc = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable');
      if (sc) return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      return false;
    }, filterTitle);
  }

  private datesScrollDistance(fromDMY: string, toDMY: string): number {
    const parse = (dmy: string) => {
      const [d, m, y] = dmy.split('/').map(Number);
      return new Date(y, m - 1, d).getTime();
    };
    return Math.round((parse(toDMY) - parse(fromDMY)) / 86_400_000);
  }

  /**
   * Clicks the "down" scroll button of a right-panel filter up to `maxClicks` times.
   * Stops early as soon as `stopWhenLabel` becomes visible in the list, so the
   * scroll never overshoots the first date of the next batch.
   * `delayMs` controls how long to wait between each click (default 80ms);
   * pass a smaller value for fast bulk pre-scrolls.
   */
  private async scrollRightPanelDownN(
    page: Page,
    filterTitle: string,
    maxClicks: number,
    stopWhenLabel?: string,
    delayMs = 80,
  ): Promise<boolean> {
    const downCoords = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');

      if (!panelRoot) return null;

      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });

      if (!filterEl) return null;

      const downButton = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-bottom');
      if (!downButton) return null;

      const rect = downButton.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, filterTitle);

    if (!downCoords) {
      this.log('scrollRightPanelDownN: down button not found, skipping', { filterTitle, maxClicks });
      return false;
    }

    const isLabelVisible = async (label: string): Promise<boolean> => {
      return page.evaluate((args: { title: string; label: string }) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }

        const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
          ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
        if (!panelRoot) return false;

        const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === nc(args.title);
        });
        if (!filterEl) return false;

        const sc = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
          ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable');
        const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
        for (const item of items) {
          const t = (item.getAttribute('title') ?? '').trim();
          if (t !== args.label) continue;
          if (!sc) return true;
          const itemRect = item.getBoundingClientRect();
          const scRect = sc.getBoundingClientRect();
          return itemRect.top >= scRect.top - 5 && itemRect.bottom <= scRect.bottom + 5;
        }
        return false;
      }, { title: filterTitle, label });
    };

    let clicked = 0;
    for (let i = 0; i < maxClicks; i++) {
      await page.mouse.click(downCoords.x, downCoords.y);
      clicked++;
      await new Promise((r) => setTimeout(r, delayMs));

      if (stopWhenLabel && await isLabelVisible(stopWhenLabel)) {
        this.log('scrollRightPanelDownN: target label visible, stopping early', { filterTitle, stopWhenLabel, clicked });
        return true;
      }
    }

    this.log('scrollRightPanelDownN: scrolled down', { filterTitle, clicked });
    return false;
  }

  /** Clicks the UP scroll button of a right-panel filter N times. */
  private async scrollRightPanelUpN(page: Page, filterTitle: string, n: number, delayMs = 40): Promise<void> {
    if (n <= 0) return;
    const upCoords = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
      if (!panelRoot) return null;
      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });
      if (!filterEl) return null;
      const btn = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-top');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, filterTitle);

    if (!upCoords) return;
    for (let i = 0; i < n; i++) {
      await page.mouse.click(upCoords.x, upCoords.y);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  private async scrollRightPanelItemIntoView(
    page: Page,
    filterTitle: string,
    itemLabel: string,
  ): Promise<boolean> {
    // Check if item is already visible
    const checkVisible = async (): Promise<boolean> => {
      return page.evaluate((args: { title: string; label: string }) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }

        const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
          ?? document.querySelector<HTMLElement>('.FilterPanelScroll');

        if (!panelRoot) return false;

        const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === nc(args.title);
        });

        if (!filterEl) return false;

        const sc = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
          ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable');

        const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
        for (const item of items) {
          // Match by title attribute first, fall back to textContent (same as getRightPanelListItemCoords)
          const t = (item.getAttribute('title') ?? item.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (t === '...' || t === '') continue;
          if (t === args.label) {
            // In a virtualised list, off-screen items are removed from the DOM.
            // If the element is in the DOM and has non-zero dimensions it IS visible.
            const rect = item.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }
        }
        return false;
      }, { title: filterTitle, label: itemLabel });
    };

    // Capture visible items before we start scrolling — helps diagnose month-boundary issues.
    const preScrollSnapshot = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
      if (!panelRoot) return { items: [] as string[], totalItems: 0 };
      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });
      if (!filterEl) return { items: [] as string[], totalItems: 0 };
      let totalItems = 0;
      const allItems = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
      for (const it of allItems) {
        const m = (it.getAttribute('title') ?? '').match(/All.*?(\d+)\s*values?/i);
        if (m) { totalItems = parseInt(m[1], 10); }
      }
      const sc = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable');
      const vis: string[] = [];
      for (const item of allItems) {
        const t = (item.getAttribute('title') ?? item.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!t || /All/i.test(t)) continue;
        const ir = item.getBoundingClientRect();
        if (ir.width > 0 && ir.height > 0) vis.push(t);
      }
      return { items: vis, totalItems };
    }, filterTitle);
    this.logStep('scroll', 'OK',
      `scrollRightPanelItemIntoView: buscando "${itemLabel}" (totalItems=${preScrollSnapshot.totalItems})`,
      { target: itemLabel, visibleNow: preScrollSnapshot.items });

    if (await checkVisible()) return true;

    // Get scroll button coordinates from right panel
    const scrollButtons = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');

      if (!panelRoot) return null;

      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });

      if (!filterEl) return null;

      const upButton = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-top');
      const downButton = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-bottom');

      if (!upButton || !downButton) return null;

      const upRect = upButton.getBoundingClientRect();
      const downRect = downButton.getBoundingClientRect();

      // Also get total items from "(All) X values"
      let totalItems = 20;
      const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
      for (const item of items) {
        const match = (item.getAttribute('title') ?? '').match(/\(All\)\s*(\d+)\s*values?/i);
        if (match) {
          totalItems = parseInt(match[1], 10);
          break;
        }
      }

      return {
        up: { x: Math.round(upRect.left + upRect.width / 2), y: Math.round(upRect.top + upRect.height / 2) },
        down: { x: Math.round(downRect.left + downRect.width / 2), y: Math.round(downRect.top + downRect.height / 2) },
        totalItems,
      };
    }, filterTitle);

    if (!scrollButtons) {
      this.logStep('scroll', 'WARN', 'could not find scroll buttons in right panel', { filterTitle, itemLabel });
      return false;
    }

    // Only scroll DOWN — dates are applied in ascending order and scroll
    // already starts at the top after the initial filter reset.
    if (await checkVisible()) return true;

    // Scroll down step by step — check after EVERY click so we stop the
    // instant the item enters the visible window and never overshoot.
    // Use totalItems+10 but minimum 200 to handle cases where (All) item isn't found.
    const maxClicks = Math.max(scrollButtons.totalItems + 10, 200);

    // Helper: read visible item labels from the DOM (for diagnostic logs).
    const getVisibleLabels = (): Promise<{ items: string[]; atBottom: boolean }> => page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
      if (!panelRoot) return { items: [] as string[], atBottom: false };
      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });
      if (!filterEl) return { items: [] as string[], atBottom: false };
      const downBtn = filterEl.querySelector<HTMLElement>('.ScrollbarButton.sfpc-bottom');
      const atBottom = !!(downBtn && (
        downBtn.classList.contains('sfpc-disabled') || downBtn.classList.contains('disabled') ||
        downBtn.hasAttribute('disabled') || downBtn.getAttribute('aria-disabled') === 'true'
      ));
      const sc = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable');
      const vis: string[] = [];
      for (const item of Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))) {
        const t = (item.getAttribute('title') ?? item.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!t || /All/i.test(t) || t === '...') continue;
        // Virtualised list: items not in viewport are removed from DOM entirely.
        // Any item present in the DOM with non-zero dimensions is visible.
        const ir = item.getBoundingClientRect();
        if (ir.width > 0 && ir.height > 0) vis.push(t);
      }
      return { items: vis, atBottom };
    }, filterTitle);

    for (let i = 0; i < maxClicks; i++) {
      await page.mouse.click(scrollButtons.down.x, scrollButtons.down.y);
      await new Promise((r) => setTimeout(r, 80));

      if (await checkVisible()) {
        await new Promise((r) => setTimeout(r, 40));
        return true;
      }

      // Every 15 clicks: log what's visible and check if scroll hit the bottom.
      if ((i + 1) % 15 === 0) {
        const snap = await getVisibleLabels();
        this.logStep('scroll', 'WARN',
          `scroll: ${i + 1}/${maxClicks} cliques — buscando "${itemLabel}" — visíveis: [${snap.items.join(', ')}]${snap.atBottom ? ' — FUNDO DA LISTA' : ''}`,
          { visibleNow: snap.items, atBottom: snap.atBottom });
        if (snap.atBottom) {
          this.logStep('scroll', 'WARN',
            `scroll chegou ao FUNDO sem encontrar "${itemLabel}" — data ausente na lista filtrada`,
            { itemLabel, visibleNow: snap.items });
          return false;
        }
      }
    }

    this.logStep('scroll', 'WARN', 'right-panel item not found after scrolling', { filterTitle, itemLabel });
    // Capture what IS visible in the list to diagnose why target was not found.
    const snapshot = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
      if (!panelRoot) return { filterFound: false, items: [] as string[], totalItems: 0 };
      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });
      if (!filterEl) return { filterFound: false, items: [] as string[], totalItems: 0 };
      let totalItems = 0;
      const allItems = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));
      for (const it of allItems) {
        const m = (it.getAttribute('title') ?? '').match(/(All)\s*(\d+)\s*values?/i);
        if (m) { totalItems = parseInt(m[2], 10); }
      }
      const sc = filterEl.querySelector<HTMLElement>('.sf-element-list-box.sfc-scrollable')
        ?? filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable');
      const visibleItems: string[] = [];
      for (const item of allItems) {
        const t = (item.getAttribute('title') ?? item.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!t || t.match(/(All)/i)) continue;
        const ir = item.getBoundingClientRect();
        if (ir.width > 0 && ir.height > 0) visibleItems.push(t);
      }
      return { filterFound: true, items: visibleItems, totalItems };
    }, filterTitle);
    this.logStep('scroll', 'WARN',
      `DIAGNÓSTICO: lista visível ao falhar (totalItems=${snapshot.totalItems}) — alvo="${itemLabel}"`,
      { visibleNow: snapshot.items, totalItems: snapshot.totalItems, filterFound: snapshot.filterFound });
    return false;
  }

  /**
   * Clicks a list item inside the right-panel Data Referência filter via DOM dispatch.
   */
  private async clickRightPanelDateItem(page: Page, filterTitle: string, itemLabel: string, ctrlKey: boolean): Promise<boolean> {
    return page.evaluate((args: { title: string; label: string; ctrlKey: boolean }) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');

      if (!panelRoot) return false;

      const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(args.title);
      });

      if (!filterEl) return false;

      const target = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
        .find((item) => (item.getAttribute('title') ?? item.textContent ?? '').trim() === args.label);

      if (!target) return false;

      const rect = target.getBoundingClientRect();
      const clientX = rect.left + Math.min(Math.max(rect.width / 2, 6), rect.width - 2);
      const clientY = rect.top + Math.min(Math.max(rect.height / 2, 6), rect.height - 2);

      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          ctrlKey: args.ctrlKey,
          button: 0,
          buttons: 1,
          clientX,
          clientY,
        }));
      }

      return true;
    }, { title: filterTitle, label: itemLabel, ctrlKey });
  }

  /**
   * Applies the "Data Referência" filter inside the right-side Filters panel.
   * Opens the panel, generates dates from periodSelection, and selects them
   * using scroll buttons + click (same approach as left-panel filters).
   * This is the LAST filter to be applied.
   */
  private async applyDataReferenciaFilter(
    page: Page,
    periodSelection: NonNullable<ScannerRunRequest['periodSelection']>,
    request: ScannerRunRequest,
  ): Promise<void> {
    const dates = this.generateReferenceDates(periodSelection);
    if (dates.length === 0) {
      this.log('no Data Referência dates to apply (empty dayRange or invalid period)');
      return;
    }

    this.emitProgress(request, 'Abrindo painel de filtros do Spotfire...');
    await this.ensureRightFiltersPanelOpen(page);

    const filterTitle = 'Data Referência';

    // Build the complete ordered list of dates that Spotfire shows in the
    // Data Referência filter panel. Spotfire shows ALL calendar days for each
    // selected month (not just the dayRange subset), in month-ascending order.
    // This gives us the EXACT scroll-position (0-based index) of every target
    // date so we can jump straight to it with scrollRightPanelDownN.
    const selectedYears = this.normalizePeriodSelectionValues(periodSelection.year);
    const selectedMonthNames = this.normalizePeriodSelectionValues(periodSelection.month);
    const filterYear = parseInt(selectedYears[0] ?? '0', 10);
    const fullDateList: string[] = [];
    for (const monthName of selectedMonthNames) {
      const monthIndex = MONTH_OPTIONS.indexOf(monthName.toLowerCase()); // 0-based (jan=0)
      if (monthIndex === -1) continue;
      const mm = String(monthIndex + 1).padStart(2, '0');
      const daysInMonth = new Date(filterYear, monthIndex + 1, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        fullDateList.push(`${String(d).padStart(2, '0')}/${mm}/${filterYear}`);
      }
    }
    // Map each date string to its 0-based index in the Spotfire list.
    const listPositions = new Map<string, number>();
    fullDateList.forEach((d, i) => listPositions.set(d, i));
    this.log('Data Referência full list built', {
      totalDays: fullDateList.length,
      sample: fullDateList.slice(0, 5),
    });

    // Wait for Spotfire to finish recalculating the Data Referência list after
    // left-panel filters (Mês, Atuação, Base) were applied.
    await this.waitForSpotfireIdle(page, 10000);

    // Scroll Data Referência list to the top before starting.
    await this.scrollRightPanelFilterToTop(page, filterTitle);
    await new Promise((r) => setTimeout(r, 300)); // settle after top-scroll

    this.logStep('data-referencia', 'START', `applying ${dates.length} date(s) in right panel`, {
      dates,
      fullListSize: fullDateList.length,
    });

    this.emitProgress(request, `Aplicando filtro Data Referência (${dates.length} dia(s))...`);

    // Strategy — one-directional forward scroll with per-date confirm-before-advance:
    //   • currentScrollPos tracks scroll state (0 = top).
    //   • For each date: scroll DOWN to targetScrollPos, click, verify via title attr.
    //   • On failure: read which dates are currently visible, compute the exact
    //     correction (up or +1 down), adjust, retry — WITHOUT going back to top.
    //   • Ctrl held from 2nd date. waitForSpotfireIdle ONLY after the first click.
    const monthKey = (d: string) => d.substring(3); // "MM/YYYY"
    const maxRetries = 6;
    let ctrlHeld = false;
    const failedDates: string[] = [];
    let currentMonthKey = '';
    let currentScrollPos = 0;

    // Per-month tracking for progress logs.
    const datesByMonth = new Map<string, string[]>();
    for (const d of dates) {
      const mk = monthKey(d);
      if (!datesByMonth.has(mk)) datesByMonth.set(mk, []);
      datesByMonth.get(mk)!.push(d);
    }
    const selectedByMonth = new Map<string, string[]>();
    const failedByMonth = new Map<string, string[]>();

    const logMonthSummary = (mk: string) => {
      const expected = datesByMonth.get(mk) ?? [];
      const selected = selectedByMonth.get(mk) ?? [];
      const failed = failedByMonth.get(mk) ?? [];
      const pending = expected.filter((d) => !selected.includes(d) && !failed.includes(d));
      const level = failed.length > 0 || pending.length > 0 ? 'WARN' : 'OK';
      this.logStep('data-referencia', level,
        `[MÊS ${mk}] ${selected.length}/${expected.length} selecionadas — ${failed.length} falhas — ${pending.length} pendentes`,
        { selected, failed, pending });
    };

    // Verify selection specifically via title="DD/MM/YYYY" + sfpc-selected class.
    // Returns 'selected' | 'not_selected' | 'not_in_dom' so callers know WHY.
    const verifySelected = async (label: string): Promise<'selected' | 'not_selected' | 'not_in_dom'> =>
      page.evaluate((args: { ft: string; label: string }) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }
        const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
          ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
        if (!panelRoot) return 'not_in_dom' as const;
        const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === nc(args.ft);
        });
        if (!filterEl) return 'not_in_dom' as const;
        // Primary: exact title attribute match (as the user requires).
        const safeTitle = args.label.replace(/"/g, '\\"');
        let item: HTMLElement | null = filterEl.querySelector<HTMLElement>(`[title="${safeTitle}"]`);
        // Fallback: textContent match in case Spotfire omits the title attr.
        if (!item) {
          item = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
            .find((it) => (it.getAttribute('title') ?? it.textContent ?? '').replace(/\s+/g, ' ').trim() === args.label) ?? null;
        }
        if (!item) return 'not_in_dom' as const;
        return item.classList.contains('sfpc-selected') ? 'selected' as const : 'not_selected' as const;
      }, { ft: filterTitle, label });

    // Poll verifySelected up to maxWaitMs, stopping early on 'selected'.
    // Returns the final status.
    const pollSelected = async (label: string, maxWaitMs: number): Promise<'selected' | 'not_selected' | 'not_in_dom'> => {
      const interval = 100;
      const rounds = Math.ceil(maxWaitMs / interval);
      let status: 'selected' | 'not_selected' | 'not_in_dom' = 'not_selected';
      for (let t = 0; t < rounds; t++) {
        await new Promise((r) => setTimeout(r, interval));
        status = await verifySelected(label);
        if (status === 'selected') break;
      }
      return status;
    };

    // Get the date labels currently visible in the filter list (title="DD/MM/YYYY" items).
    // Returns them in DOM order (top → bottom), along with an isLoading flag if '...' is present.
    const getVisibleDatesState = (): Promise<{ dates: string[], allDatesInDom: string[], isLoading: boolean }> =>
      page.evaluate((ft: string) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }
        const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
          ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
        if (!panelRoot) return { dates: [], allDatesInDom: [], isLoading: false };
        const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === nc(ft);
        });
        if (!filterEl) return { dates: [], allDatesInDom: [], isLoading: false };
        const dates: string[] = [];
        const allDatesInDom: string[] = [];
        let isLoading = false;
        for (const item of filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item')) {
          const title = item.getAttribute('title') ?? '';
          const text = item.textContent ?? '';
          const t = (title || text).replace(/\s+/g, ' ').trim();
          if (t === '...') {
            const rect = item.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              isLoading = true;
            }
            continue;
          }
          if (!/^\d{2}\/\d{2}\/\d{4}$/.test(t)) continue;
          allDatesInDom.push(t);
          const rect = item.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) dates.push(t);
        }
        return { dates, allDatesInDom, isLoading };
      }, filterTitle);

    try {
      for (let index = 0; index < dates.length; index += 1) {
        const dateValue = dates[index];
        const useCtrl = index > 0;
        let itemSelected = false;

        await this.assertDataReferenciaFilterVisible(page, filterTitle);

        const dateMonth = monthKey(dateValue);
        const isNewMonth = dateMonth !== currentMonthKey;

        if (isNewMonth) {
          if (currentMonthKey !== '') {
            logMonthSummary(currentMonthKey);
          }
          currentMonthKey = dateMonth;
          selectedByMonth.set(currentMonthKey, []);
          failedByMonth.set(currentMonthKey, []);
          this.logStep('data-referencia', 'OK',
            `[MÊS ${currentMonthKey}] iniciando — ${datesByMonth.get(currentMonthKey)?.length ?? 0} data(s) esperadas`,
            { expected: datesByMonth.get(currentMonthKey) });
        }

        if (useCtrl && !ctrlHeld) {
          await page.keyboard.down('Control');
          ctrlHeld = true;
        }

        // ── Step 1: check if in DOM already, otherwise scroll DOWN ─────────────
        const isTargetInDom = await page.evaluate((args) => {
          function nc(v: string | null | undefined): string {
            return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          }
          const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
            ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
          if (!panelRoot) return false;
          const filterEl = Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
            const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
            return nc(el?.getAttribute('title') ?? el?.textContent) === nc(args.title);
          });
          if (!filterEl) return false;
          const safeLabel = args.label.replace(/"/g, '\\"');
          let target = filterEl.querySelector<HTMLElement>(`[title="${safeLabel}"]`);
          if (!target) {
            target = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
              .find((item) => (item.getAttribute('title') ?? item.textContent ?? '').trim() === args.label) ?? null;
          }
          return !!target;
        }, { title: filterTitle, label: dateValue });

        const listPos = listPositions.get(dateValue) ?? index;
        if (!isTargetInDom) {
          const targetScrollPos = Math.max(0, listPos - 1);
          const delta = Math.max(0, targetScrollPos - currentScrollPos);

          if (delta > 0) {
            if (ctrlHeld) { await page.keyboard.up('Control'); ctrlHeld = false; }
            if (delta > 1) {
              this.logAlways(`[data-referencia] ↓ +${delta} para "${dateValue}" (pos ${currentScrollPos}→${targetScrollPos})`);
            }
            await this.scrollRightPanelDownN(page, filterTitle, delta, undefined, 40);
            currentScrollPos = targetScrollPos;
            if (useCtrl && !ctrlHeld) { await page.keyboard.down('Control'); ctrlHeld = true; }
            await new Promise((r) => setTimeout(r, 80)); // settle
          }
        } else {
          this.logAlways(`[data-referencia] "${dateValue}" já está no DOM. Pulando rolagem inicial.`);
        }

        // ── Step 2: click + verify — retry with scroll correction on failure ───
        // RULE: never click again if item is already selected (toggle danger).
        // On each failure: inspect visible dates → compute exact correction →
        //   scroll UP or +1 DOWN → retry. Never reset to top.
        let loadingWaits = 0;
        for (let attempt = 0; attempt < maxRetries && !itemSelected; attempt++) {
          // Pre-check before every attempt (including attempt 0 — belt and braces).
          const preStatus = await verifySelected(dateValue);
          if (preStatus === 'selected') {
            itemSelected = true;
            selectedByMonth.get(currentMonthKey)?.push(dateValue);
            this.logStep('data-referencia', 'OK', `selected ${index + 1}/${dates.length}: ${dateValue} (pre-check)`, { attempt });
            break;
          }

          // Scroll correction on retries.
          if (attempt > 0) {
            if (ctrlHeld) { await page.keyboard.up('Control'); ctrlHeld = false; }

            // Inspect which dates are currently visible to know exactly where we are.
            const visibleState = await getVisibleDatesState();
            const targetAvailable = visibleState.allDatesInDom.includes(dateValue);

            if (visibleState.isLoading && !targetAvailable && loadingWaits < 15) {
              this.logAlways(`[data-referencia] "..." detectado! Alvo "${dateValue}" ainda não carregou. Aguardando...`);
              await new Promise((r) => setTimeout(r, 1000));
              loadingWaits++;
              attempt--; // Do not burn a retry while loading
              if (useCtrl && !ctrlHeld) { await page.keyboard.down('Control'); ctrlHeld = true; }
              continue;
            }
            
            if (visibleState.isLoading && targetAvailable) {
              this.logAlways(`[data-referencia] "..." detectado, mas alvo "${dateValue}" já está disponível na lista. Ignorando espera.`);
            } else if (visibleState.isLoading) {
              this.logAlways(`[data-referencia] "..." persistindo tempo demais. Prosseguindo assim mesmo.`);
            }

            const visible = visibleState.dates;
            this.logAlways(`[data-referencia] retry ${attempt} — visíveis: [${visible.join(', ')}] — alvo: "${dateValue}"`);

            if (visible.length > 0) {
              const firstVisPos = listPositions.get(visible[0]) ?? 0;
              const lastVisPos = listPositions.get(visible[visible.length - 1]) ?? 0;

              if (listPos < firstVisPos) {
                // Target is ABOVE the visible window — scroll UP to bring it in.
                const upClicks = Math.min(firstVisPos - listPos + 1, 8);
                this.logAlways(`[data-referencia] ↑ ${upClicks} para trazer "${dateValue}" para cima`);
                await this.scrollRightPanelUpN(page, filterTitle, upClicks, 40);
                currentScrollPos = Math.max(0, currentScrollPos - upClicks);
              } else if (listPos > lastVisPos) {
                // Target is BELOW the visible window — scroll DOWN 1 more.
                this.logAlways(`[data-referencia] ↓ +1 para trazer "${dateValue}" para baixo`);
                await this.scrollRightPanelDownN(page, filterTitle, 1, undefined, 40);
                currentScrollPos++;
              } else {
                // Target should be in window — maybe clipped at edge, scroll +1.
                await this.scrollRightPanelDownN(page, filterTitle, 1, undefined, 40);
                currentScrollPos++;
              }
            } else {
              // No visible dates — just nudge down 1.
              await this.scrollRightPanelDownN(page, filterTitle, 1, undefined, 40);
              currentScrollPos++;
            }

            if (useCtrl && !ctrlHeld) { await page.keyboard.down('Control'); ctrlHeld = true; }
            await new Promise((r) => setTimeout(r, 80)); // settle after correction
          }

          let clicked = false;
          const coords = await this.getRightPanelListItemCoords(page, filterTitle, dateValue);
          if (coords) {
            await page.mouse.click(coords.x, coords.y);
            clicked = true;
          } else {
            const dispatched = await this.clickRightPanelDateItem(page, filterTitle, dateValue, ctrlHeld);
            if (dispatched) {
              clicked = true;
              this.logAlways(`[data-referencia] alvo "${dateValue}" clicado via dispatchEvent (off-screen).`);
            }
          }

          if (!clicked) {
            this.logStep('data-referencia', 'WARN', 'could not get item coords', { dateValue, attempt, currentScrollPos });
            continue; // next retry will inspect visible and correct
          }

          // Poll up to 1 s — Spotfire updates sfpc-selected asynchronously.
          const status = await pollSelected(dateValue, 1000);

          if (status === 'selected') {
            itemSelected = true;
            selectedByMonth.get(currentMonthKey)?.push(dateValue);
            this.logStep('data-referencia', 'OK', `selected ${index + 1}/${dates.length}: ${dateValue}`, { attempt: attempt + 1 });
          } else {
            this.logStep('data-referencia', 'WARN',
              status === 'not_in_dom' ? 'item left DOM after click (virtualised list moved)' : 'click did not select',
              { dateValue, attempt });
          }
        }

        if (!itemSelected) {
          failedDates.push(dateValue);
          failedByMonth.get(currentMonthKey)?.push(dateValue);
          this.logStep('data-referencia', 'WARN', `could not select date "${dateValue}" after ${maxRetries} attempts`);
        }

        // Only wait for Spotfire to re-render after the very first (Ctrl-less) click.
        if (index === 0) {
          await this.waitForSpotfireIdle(page, 8000);
          await this.assertDataReferenciaFilterVisible(page, filterTitle);
        }
      }
    } finally {
      if (ctrlHeld) {
        await page.keyboard.up('Control');
        this.logStep('data-referencia', 'OK', 'released Ctrl after multi-select');
      }
      if (currentMonthKey !== '') logMonthSummary(currentMonthKey);
    }

    await this.waitForSpotfireIdle(page);

    const selectedCount = dates.length - failedDates.length;
    if (selectedCount === 0) {
      this.info(`Data Referência: nenhuma das ${dates.length} data(s) selecionada ✗`);
      this.logStep('data-referencia', 'FAIL', `none of the ${dates.length} date(s) could be selected — aborting`, { failedDates });
      throw new Error(`Data Referência: nenhuma das ${dates.length} data(s) pôde ser selecionada. Verifique se o filtro está visível no painel direito.`);
    }

    if (failedDates.length > 0) {
      this.info(`Data Referência: ${selectedCount}/${dates.length} data(s) selecionada(s), ${failedDates.length} falharam`);
      this.logStep('data-referencia', 'WARN', `${selectedCount}/${dates.length} date(s) selected, ${failedDates.length} failed`, { failedDates });
    } else {
      this.info(`Data Referência: ${selectedCount} data(s) selecionada(s) ✓`);
    }

    this.logStep('data-referencia', 'OK', `Data Referência filter applied: ${selectedCount}/${dates.length} date(s) selected`);
    this.emitProgress(request, 'Filtro Data Referência aplicado');
  }

  /**
   * Checks that the right-panel filter named `filterTitle` is still present in
   * the DOM. If it is gone (because Spotfire silently reloaded the page without
   * throwing a Puppeteer error), throws an error whose message matches
   * `isSpotfireReloadError` so that `withSpotfireRecovery` triggers a full retry.
   */
  private async assertDataReferenciaFilterVisible(page: Page, filterTitle: string): Promise<void> {
    const found = await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      const panelRoot = document.querySelector<HTMLElement>('.sfc-filter-panel')
        ?? document.querySelector<HTMLElement>('.FilterPanelScroll');
      if (!panelRoot) return false;
      return Array.from(panelRoot.querySelectorAll<HTMLElement>('.sf-element-filter')).some((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === nc(title);
      });
    }, filterTitle).catch(() => false);

    if (!found) {
      throw new Error(
        `execution context was destroyed: filter panel for "${filterTitle}" is no longer in the DOM — ` +
        `Spotfire likely reloaded silently`,
      );
    }
  }

  private isSpotfireReloadError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return (
      lower.includes('execution context was destroyed') ||
      lower.includes('navigating') ||
      lower.includes('detached') ||
      lower.includes('session closed') ||
      lower.includes('target closed') ||
      lower.includes('frame was detached') ||
      lower.includes('cannot find context') ||
      lower.includes('protocol error')
    );
  }

  private async waitForSpotfireReload(page: Page, request?: ScannerRunRequest): Promise<void> {
    this.logStep('recovery', 'START', 'Spotfire reloaded — waiting for page to stabilize');
    if (request) {
      this.emitProgress(request, 'Spotfire recarregou, aguardando estabilização...');
    }

    // Wait a moment for the page to start reloading
    await new Promise((r) => setTimeout(r, 3000));

    // If a navigation is in progress, wait for it to finish (short timeout — don't block if already done)
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => undefined);

    // Wait for Spotfire analysis elements to appear (proves the page loaded fully)
    const analysisReady = await this.isAnalysisReady(page);
    if (!analysisReady) {
      this.log('analysis not ready after reload, waiting longer...');
      await page.waitForSelector(
        '.sf-element-page-tab, .sfx_page-tab_204, .sf-element-visual-title, .sf-element-filter, .FilterPanelScroll, [title="Reset Visible Filters"]',
        { timeout: 120000 },
      ).catch(() => undefined);
    }

    // Now wait for Spotfire UI to be idle (no spinners / busy indicators)
    await this.waitForSpotfireIdle(page, 120000);

    // Final check — if analysis still isn't loaded, re-open it
    if (!await this.isAnalysisReady(page)) {
      this.log('analysis not ready after reload, re-opening...');
      await this.openAnalysis(page, this.environment.spotfire.defaultReportTitle);
    }

    this.logStep('recovery', 'OK', 'Spotfire stabilized after reload');
    if (request) {
      this.emitProgress(request, 'Spotfire estabilizou, retomando automação...');
    }
  }

  private async withSpotfireRecovery<T>(
    page: Page,
    operation: () => Promise<T>,
    request?: ScannerRunRequest,
    maxRetries: number = 2,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (this.isSpotfireReloadError(error) && attempt < maxRetries && !page.isClosed()) {
          this.logStep('recovery', 'WARN', `Spotfire reload detected (attempt ${attempt + 1}/${maxRetries}), recovering...`, {
            error: error instanceof Error ? error.message : String(error),
          });
          await this.waitForSpotfireReload(page, request);
          continue;
        }
        throw error;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('withSpotfireRecovery exhausted retries');
  }
}