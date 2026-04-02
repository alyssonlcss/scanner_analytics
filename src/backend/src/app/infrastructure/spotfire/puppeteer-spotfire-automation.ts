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
  private activeQueue: Promise<void> = Promise.resolve();
  private persistentBrowser?: Browser;
  private persistentPage?: Page;

  public constructor(private readonly environment: Environment) {}

  private log(message: string, details?: Record<string, unknown>): void {
    const prefix = '[spotfire]';
    const ts = new Date().toISOString();

    if (details) {
      console.info(prefix, ts, message, details);
      return;
    }

    console.info(prefix, ts, message);
  }

  private stepTimers = new Map<string, number>();

  private logStep(step: string, status: 'START' | 'OK' | 'WARN' | 'FAIL', message: string, details?: Record<string, unknown>): void {
    if (status === 'START') {
      this.stepTimers.set(step, Date.now());
    }

    const started = this.stepTimers.get(step);
    const elapsed = started ? `${((Date.now() - started) / 1000).toFixed(1)}s` : '';

    if (status !== 'START' && started) {
      this.stepTimers.delete(step);
    }

    const suffix = elapsed && status !== 'START' ? ` (${elapsed})` : '';
    this.log(`[${status}] ${step} :: ${message}${suffix}`, details);
  }

  public async prepareSession(reportTitle: string): Promise<void> {
    await this.runSerialized(async () => {
      const { page, createdNewPage } = await this.getAutomationSession();

      this.logStep('warmup', 'START', 'preparing authenticated Spotfire session', {
        reportTitle,
        keepOpen: this.environment.spotfire.keepOpen,
        createdNewPage,
      });

      try {
        if (createdNewPage) {
          await page.setViewport({ width: 1600, height: 1000 });
          this.logStep('warmup', 'OK', 'created new browser page and applied viewport', {
            width: 1600,
            height: 1000,
          });
        }

        await this.openAnalysis(page, reportTitle);
        await this.ensureNoMaximizedVisualization(page);
        await this.ensureFiltersPanel(page);
        this.logStep('warmup', 'OK', 'spotfire session is ready and waiting for data-download', {
          reportTitle,
          currentUrl: page.url(),
        });
      } finally {
        if (!this.environment.spotfire.keepOpen) {
          this.logStep('warmup', 'WARN', 'closing browser because keepOpen=false');
          await this.disposeAutomationSession();
        } else {
          this.logStep('warmup', 'OK', 'keeping browser and page open because keepOpen=true');
        }
      }
    });
  }

  public async runExtraction(request: ScannerRunRequest): Promise<ScannerAutomationResult> {
    return this.runSerialized(async () => {
      const outputDirectory = await this.prepareOutputDirectory();
      this.logStep('data-download', 'START', 'starting extraction run', {
        reportTitle: request.reportTitle ?? this.environment.spotfire.defaultReportTitle,
        analysisTab: request.analysisTab ?? null,
        tableTitle: request.tableTitle ?? null,
        headless: this.environment.spotfire.headless,
        keepOpen: this.environment.spotfire.keepOpen,
        outputDirectory,
      });

      const { browser, page, createdNewPage } = await this.getAutomationSession();

      try {
        if (createdNewPage) {
          await page.setViewport({ width: 1600, height: 1000 });
          this.logStep('browser', 'OK', 'created new browser page for extraction run', {
            width: 1600,
            height: 1000,
          });
        }

        await this.openAnalysis(page, request.reportTitle ?? this.environment.spotfire.defaultReportTitle);
        await this.ensureNoMaximizedVisualization(page);
        const availableTabs = await this.loadAvailableTabs(page);
        this.logStep('analysis', 'OK', 'loaded available tabs from current analysis', {
          count: availableTabs.length,
          tabs: availableTabs,
        });

        if (request.analysisTab) {
          this.logStep('analysis-tab', 'START', 'opening requested analysis tab', {
            analysisTab: request.analysisTab,
          });
          await this.openAnalysisTab(page, request.analysisTab);
          await this.ensureNoMaximizedVisualization(page);
          this.logStep('analysis-tab', 'OK', 'requested analysis tab is active', {
            analysisTab: request.analysisTab,
          });
        }

        await this.ensureFiltersPanel(page);
        await this.ensureAllFiltersVisible(page);
        await this.resetVisibleFilters(page);

        // Scroll filter panel to the very bottom ONCE — then read only currently rendered filters.
        // Avoid the heavy full-panel scan (slow + changes scroll position, breaking virtualization).
        await this.scrollFilterPanelToBottom(page);
        let initialFilters = await this.readVisibleFilters(page);

        this.logStep('filters', 'OK', 'initial filter scan complete', {
          count: initialFilters.length,
          titles: initialFilters.map((f) => f.title),
        });

        const selectedFilters = request.selectedFilters ?? [];

        // Build the strict bottom-to-top application order:
        // 1) Atuação  2) Ano  3) Mês  4) Base
        // 5) Data Referência (always last, handled separately)
        const orderedFiltersToApply: SpotfireFilter[] = [];
        const usedTitles = new Set<string>();

        // Helper: find filter from selectedFilters or periodSelection by normalized key
        const findSelectedFilter = (key: string): SpotfireFilter | undefined => {
          return selectedFilters.find((f) => this.normalizeFilterName(f.title) === key);
        };

        // 1) Atuação
        const atuacaoFilter = selectedFilters.find((f) => ['atuacaohd', 'atuacao'].includes(this.normalizeFilterName(f.title)));
        if (atuacaoFilter) {
          orderedFiltersToApply.push(atuacaoFilter);
          usedTitles.add(atuacaoFilter.title);
        }

        // 2) Ano — from selectedFilters or periodSelection
        const anoFromSelected = findSelectedFilter('ano');
        if (anoFromSelected) {
          orderedFiltersToApply.push(anoFromSelected);
          usedTitles.add(anoFromSelected.title);
        } else if (request.periodSelection?.year && request.periodSelection.year !== ALL_OPTION) {
          const resolvedTitle = this.resolveActualFilterTitle(initialFilters, 'Ano');
          if (resolvedTitle) {
            const existing = initialFilters.find((f) => this.normalizeFilterName(f.title) === this.normalizeFilterName(resolvedTitle));
            orderedFiltersToApply.push({ title: resolvedTitle, kind: existing?.kind ?? 'list', selectedValues: [request.periodSelection.year] });
            usedTitles.add(resolvedTitle);
          }
        }

        // 3) Mês — from selectedFilters or periodSelection
        const mesFromSelected = findSelectedFilter('mes');
        if (mesFromSelected) {
          orderedFiltersToApply.push(mesFromSelected);
          usedTitles.add(mesFromSelected.title);
        } else if (request.periodSelection?.month && request.periodSelection.month !== ALL_OPTION) {
          const resolvedTitle = this.resolveActualFilterTitle(initialFilters, 'Mês');
          if (resolvedTitle) {
            const existing = initialFilters.find((f) => this.normalizeFilterName(f.title) === this.normalizeFilterName(resolvedTitle));
            orderedFiltersToApply.push({ title: resolvedTitle, kind: existing?.kind ?? 'list', selectedValues: [request.periodSelection.month] });
            usedTitles.add(resolvedTitle);
          }
        }

        // 4) Base
        const baseFilter = findSelectedFilter('base');
        if (baseFilter) {
          orderedFiltersToApply.push(baseFilter);
          usedTitles.add(baseFilter.title);
        }

        // Append any remaining non-period filters not explicitly ordered
        for (const f of selectedFilters) {
          if (usedTitles.has(f.title)) continue;
          if (f.title.trim().toLowerCase() === 'data referência') continue;
          orderedFiltersToApply.push(f);
          usedTitles.add(f.title);
        }

        // Resolve all titles against actual Spotfire DOM titles
        const resolvedOrderedFilters = this.resolveRequestedFilters(initialFilters, orderedFiltersToApply);

        const appliedByTitle = new Map<string, boolean>();

        if (resolvedOrderedFilters.length) {
          this.logStep('filters', 'START', 'applying filters in bottom-to-top order', {
            count: resolvedOrderedFilters.length,
            order: resolvedOrderedFilters.map((f) => `${f.title} (${f.kind})`),
          });

          for (const singleFilter of resolvedOrderedFilters) {
            this.logStep('filter', 'START', `applying: ${singleFilter.title}`, {
              kind: singleFilter.kind,
              values: singleFilter.selectedValues,
            });

            await this.locateFilterElement(page, singleFilter.title);
            const applyResult = await this.applySingleFilterWithRetry(page, singleFilter);
            appliedByTitle.set(this.normalizeFilterName(singleFilter.title), applyResult.applied);
            await this.waitForSpotfireIdle(page);

            if (!applyResult.applied) {
              this.logStep('filters', 'FAIL', 'stopping filter pipeline because a filter failed to apply', {
                failedTitle: singleFilter.title,
                kind: singleFilter.kind,
                values: singleFilter.selectedValues,
              });
              throw new Error(`filter not applied: ${singleFilter.title}`);
            }

            this.logStep('filter', 'OK', `finished: ${singleFilter.title}`);
          }

          this.logStep('filters', 'OK', 'finished applying ordered filters');
        }

        // 6) Data Referência — ALWAYS LAST
        //    Generate date strings directly (M/D/YYYY) instead of scanning 455 virtualized options
        if (request.periodSelection) {
          this.logStep('period', 'START', 'applying Data Referência (last filter)', {
            periodSelection: request.periodSelection,
          });

          // Day-range can only be applied AFTER Ano and Mês are applied.
          const needsYear = Boolean(request.periodSelection.year && request.periodSelection.year !== ALL_OPTION);
          const needsMonth = Boolean(request.periodSelection.month && request.periodSelection.month !== ALL_OPTION);

          const anoTitle = this.resolveActualFilterTitle(initialFilters, 'Ano') ?? 'Ano';
          const mesTitle = this.resolveActualFilterTitle(initialFilters, 'Mês') ?? 'Mês';

          const anoApplied = !needsYear || (appliedByTitle.get(this.normalizeFilterName(anoTitle)) ?? false);
          const mesApplied = !needsMonth || (appliedByTitle.get(this.normalizeFilterName(mesTitle)) ?? false);

          if (!anoApplied || !mesApplied) {
            this.logStep('period', 'WARN', 'skipping Data Referência because Ano/Mês were not applied', {
              needsYear,
              needsMonth,
              anoApplied,
              mesApplied,
            });
          } else {

          const referenceDates = this.generateReferenceDates(request.periodSelection);
          const resolvedRefTitle = this.resolveActualFilterTitle(initialFilters, 'Data Referência');

          if (referenceDates.length && resolvedRefTitle) {
            const dataRefFilter: SpotfireFilter = {
              title: resolvedRefTitle,
              kind: 'list',
              selectedValues: referenceDates,
            };
            await this.locateFilterElement(page, dataRefFilter.title);
            await this.applySingleFilterWithRetry(page, dataRefFilter);
            await this.waitForSpotfireIdle(page);
            this.logStep('period', 'OK', 'applied Data Referência filter', {
              selectedValueCount: referenceDates.length,
              dates: referenceDates,
            });
          } else {
            this.logStep('period', 'WARN', 'period selection produced no Data Referência values', {
              dates: referenceDates,
              resolvedTitle: resolvedRefTitle ?? null,
            });
          }
          }
        }

        const explicitReferenceDateFilters = selectedFilters.filter((filter) => filter.title.trim().toLowerCase() === 'data referência');
        if (explicitReferenceDateFilters.length) {
          this.logStep('filters', 'START', 'applying explicit Data Referência filters from request', {
            count: explicitReferenceDateFilters.length,
          });
          await this.locateFilterElement(page, explicitReferenceDateFilters[0].title);
          await this.applySelectedFilters(page, explicitReferenceDateFilters);
          this.logStep('filters', 'OK', 'finished applying explicit Data Referência filters');
        }

        // Keep this lightweight (do not rescan/scroll the full filter panel).
        const filters = await this.readVisibleFilters(page);
        this.logFiltersSummary(filters);
        const availableTables = await this.loadAvailableTables(page);
        this.logStep('analysis', 'OK', 'loaded available tables from current analysis tab', {
          count: availableTables.length,
          tables: availableTables,
        });

        let exportFilePath: string | undefined;
        if (request.tableTitle) {
          this.logStep('export', 'START', 'preparing table export', {
            tableTitle: request.tableTitle,
            outputDirectory,
          });
          await this.maximizeTable(page, request.tableTitle);
          exportFilePath = await this.exportTable(page, outputDirectory, request);
          this.logStep('export', 'OK', 'table export finished', {
            tableTitle: request.tableTitle,
            exportFilePath: exportFilePath ?? null,
          });
        }

        return {
          filters,
          availableTabs,
          availableTables,
          exportFilePath,
        };
      } finally {
        if (!this.environment.spotfire.keepOpen) {
          this.logStep('browser', 'WARN', 'closing browser because keepOpen=false');
          await this.disposeAutomationSession();
        } else {
          this.logStep('browser', 'OK', 'keeping browser and page open because keepOpen=true');
        }
      }
    });
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

  private async applySelectedFilters(page: Page, filters: SpotfireFilter[]): Promise<void> {
    this.log('applying selected filters from request', {
      count: filters.length,
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

    for (const filter of filters) {
      if (!this.hasRequestedFilterValue(filter)) {
        continue;
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
          break;
        }

        await this.waitForSpotfireIdle(page);
      }
    }

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
    const found = await this.locateFilterElement(page, filter.title);

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

      function findPanelFilter(): HTMLElement | null {
        const t = nc(title);
        return Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
          const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
          return nc(el?.getAttribute('title') ?? el?.textContent) === t;
        }) ?? null;
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
        if (trimColon(title) === 'data referencia') {
          return findPanelFilter();
        }

        return findTextAreaFilter();
      }

      let el = find();
      if (el) {
        el.scrollIntoView({ block: 'center' });
        return true;
      }

      const sc = document.querySelector<HTMLElement>('.FilterPanelScroll .Container')
        ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll .Container')
        ?? document.querySelector<HTMLElement>('.sfc-filter-panel .Container');

      if (!sc) {
        return false;
      }

      const max = Math.max(sc.scrollHeight - sc.clientHeight, 0);
      const step = Math.max(Math.floor(sc.clientHeight * 0.6), 160);

      // Respect the current scroll position (typically bottom) and search upwards first,
      // then downwards as a fallback. This avoids always sweeping from the top.
      const start = Math.max(Math.min(sc.scrollTop, max), 0);

      for (let o = start; o >= 0; o -= step) {
        sc.scrollTop = o;
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(140);
        el = find();
        if (el) {
          el.scrollIntoView({ block: 'center' });
          return true;
        }
      }

      for (let o = start; o <= max; o += step) {
        sc.scrollTop = o;
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(140);
        el = find();
        if (el) {
          el.scrollIntoView({ block: 'center' });
          return true;
        }
      }

      sc.scrollTop = start;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
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

      for (const filterElement of Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter'))) {
        const extracted = extractFilter(filterElement);
        if (!extracted) continue;
        if (normalizeTitle(extracted.title) !== 'Data Referência') continue;
        if (seen.has(extracted.title)) continue;
        seen.add(extracted.title);
        collected.push(extracted);
      }

      return collected;
    });
  }

  private async getFilterSearchInputCoords(page: Page, filterTitle: string): Promise<{ x: number; y: number } | null> {
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
        return null;
      }

      const input = filterEl.querySelector<HTMLInputElement>('input.SearchInput, input[placeholder*="Type to search in list"]');

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
        })
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

      if (!filterEl) {
        return null;
      }

      if (!titleEl) {
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
    const bodyCoords = await this.getFilterBodyActivationCoords(page, filterTitle);
    if (bodyCoords) {
      await page.mouse.click(bodyCoords.x, bodyCoords.y, { clickCount: 2 });
      await new Promise((r) => setTimeout(r, 120));
      await page.mouse.click(bodyCoords.x, bodyCoords.y);
      await new Promise((r) => setTimeout(r, 150));
      return;
    }

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
        if (candidate === requested) {
          return true;
        }
        if (candidate.includes(requested) || requested.includes(candidate)) {
          return true;
        }
        if (requested === '(all)') {
          return candidate.startsWith('(all)');
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

      function findItem(): HTMLElement | null {
        return Array.from(filterEl!.querySelectorAll<HTMLElement>('.sf-element-list-box-item')).find((item) => {
          return matchLabel(nc(item.getAttribute('title') ?? item.textContent), reqLabel);
        }) ?? null;
      }

      let item = findItem();

      if (!item) {
        const sc = filterEl.querySelector<HTMLElement>('.ListContainer .sfc-scrollable')
          ?? filterEl.querySelector<HTMLElement>('.ListContainer .sf-element-list-box')
          ?? filterEl.querySelector<HTMLElement>('.StyledScrollbar.ListContainerScroll .sfc-scrollable');

        if (sc) {
          const max = Math.max(sc.scrollHeight - sc.clientHeight, 0);
          const step = Math.max(Math.floor(sc.clientHeight * 0.75), 30);

          for (let o = 0; o <= max && !item; o += step) {
            sc.scrollTop = o;
            sc.dispatchEvent(new Event('scroll', { bubbles: true }));
            await wait(80);
            item = findItem();
          }
        }
      }

      if (!item) {
        return null;
      }

      item.scrollIntoView({ block: 'center' });
      await wait(50);

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
    const isYearFilter = ['ano', 'year'].includes(this.normalizeFilterName(filterTitle));

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
          const panelFilter = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
            const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
            return nc(el?.getAttribute('title') ?? el?.textContent) === t;
          });

          if (panelFilter) {
            return panelFilter;
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

    const findLastVisibleListItemCoords = async (searchTerm: string): Promise<{ x: number; y: number; label: string } | null> => {
      return page.evaluate((args: { title: string; searchTerm: string }) => {
        function nc(v: string | null | undefined): string {
          return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }

        function trimColon(v: string | null | undefined): string {
          return nc(v).replace(/:$/, '');
        }

        function resolveFilterElement(): HTMLElement | null {
          const t = trimColon(args.title);
          const panelFilter = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
            const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
            return nc(el?.getAttribute('title') ?? el?.textContent) === t;
          });

          if (panelFilter) {
            return panelFilter;
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

        const s = nc(args.searchTerm);
        const filterEl = resolveFilterElement();

        if (!filterEl) {
          return null;
        }

        const items = Array.from(filterEl.querySelectorAll<HTMLElement>('.sf-element-list-box-item'))
          .map((item) => ({
            element: item,
            label: nc(item.getAttribute('title') ?? item.textContent),
            rect: item.getBoundingClientRect(),
          }))
          .filter((item) => item.rect.width > 0 && item.rect.height > 0)
          .filter((item) => item.label.length > 0 && !item.label.startsWith('(all)') && item.label !== '...');

        const matching = items.filter((item) => item.label.includes(s) || s.includes(item.label));
        const chosen = (matching.length > 0 ? matching : items).at(-1);

        if (!chosen) {
          return null;
        }

        return {
          x: Math.round(chosen.rect.left + Math.min(24, Math.max(8, chosen.rect.width * 0.25))),
          y: Math.round(chosen.rect.top + Math.min(chosen.rect.height - 2, Math.max(chosen.rect.height * 0.78, chosen.rect.height / 2 + 3))),
          label: chosen.label,
        };
      }, { title: filterTitle, searchTerm });
    };

    const selectBySearchAndLastVisibleOption = async (searchTerm: string, useCtrl: boolean): Promise<boolean> => {
      await this.locateFilterElement(page, filterTitle);
      await this.activateListFilter(page, filterTitle);
      await this.clearFilterSearchInput(page, filterTitle);

      const searchCoords = await this.getFilterSearchInputCoords(page, filterTitle);
      if (!searchCoords) {
        return false;
      }

      await page.mouse.click(searchCoords.x, searchCoords.y, { clickCount: 3 });
      await new Promise((r) => setTimeout(r, 80));
      await page.keyboard.type(searchTerm, { delay: 30 });
      await page.keyboard.press('Enter').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 350));

      const lastVisible = await findLastVisibleListItemCoords(searchTerm);
      if (!lastVisible) {
        await this.clearFilterSearchInput(page, filterTitle);
        return false;
      }

      if (useCtrl) {
        await page.keyboard.down('Control');
      }

      await page.mouse.click(lastVisible.x, lastVisible.y);

      if (useCtrl) {
        await page.keyboard.up('Control');
      }

      await new Promise((r) => setTimeout(r, 250));
      await this.waitForSpotfireIdle(page, 8000);

      const summary = await readListFilterSummary();
      await this.clearFilterSearchInput(page, filterTitle);

      return summary.filteredCount === null || summary.filteredCount >= (useCtrl ? 2 : 1);
    };

    const clickValueWithFallbacks = async (searchTerm: string, allowCtrlFallback: boolean): Promise<boolean> => {
      // Re-locate the filter to ensure it's in the viewport
      await this.locateFilterElement(page, filterTitle);
      // For Spotfire list filters like Ano, activation is more reliable one line below the title.
      await this.activateListFilter(page, filterTitle);
      await new Promise((r) => setTimeout(r, 180));

      // Try to resolve item directly (no search)
      let item = await this.findListItemCoords(page, filterTitle, searchTerm);

      // If not found, use SearchInput to filter list then find item
      if (!item) {
        await this.clearFilterSearchInput(page, filterTitle);
        const searchCoords = await this.getFilterSearchInputCoords(page, filterTitle);
        if (searchCoords) {
          await page.mouse.click(searchCoords.x, searchCoords.y, { clickCount: 3 });
          await new Promise((r) => setTimeout(r, 80));
          await page.keyboard.type(searchTerm, { delay: 30 });
          await page.keyboard.press('Enter').catch(() => undefined);
          await new Promise((r) => setTimeout(r, 320));
        }

        item = await this.findListItemCoords(page, filterTitle, searchTerm);
      }

      if (!item) {
        this.logStep('list-filter', 'WARN', 'list item not found', { filterTitle, searchTerm });
        await this.clearFilterSearchInput(page, filterTitle);
        return false;
      }

      // Click near the left side (on top of the text) – this matches the user's manual interaction.
      const primaryX = item.labelX ?? item.clickX;
      const primaryY = item.labelY ?? item.clickY;

      await this.activateFilter(page, filterTitle);
      await page.mouse.click(primaryX, primaryY);
      await new Promise((r) => setTimeout(r, 200));

      if (isSingleExplicitSelection) {
        const summary = await readListFilterSummary();
        if (summary.filteredCount === 1) {
          await this.clearFilterSearchInput(page, filterTitle);
          return true;
        }
      }

      let after = await this.findListItemCoords(page, filterTitle, searchTerm);
      if (after?.selected) {
        await this.clearFilterSearchInput(page, filterTitle);
        return true;
      }

      // Retry a second click (Spotfire sometimes ignores the first click when focus shifts)
      await page.mouse.click(primaryX, primaryY);
      await new Promise((r) => setTimeout(r, 200));

      if (isSingleExplicitSelection) {
        const summary = await readListFilterSummary();
        if (summary.filteredCount === 1) {
          await this.clearFilterSearchInput(page, filterTitle);
          return true;
        }
      }
      after = await this.findListItemCoords(page, filterTitle, searchTerm);
      if (after?.selected) {
        await this.clearFilterSearchInput(page, filterTitle);
        return true;
      }

      // Ctrl+click fallback (multi-select listboxes)
      if (allowCtrlFallback) {
        await page.keyboard.down('Control');
        await page.mouse.click(primaryX, primaryY);
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 250));

        if (isSingleExplicitSelection) {
          const summary = await readListFilterSummary();
          if (summary.filteredCount === 1) {
            await this.clearFilterSearchInput(page, filterTitle);
            return true;
          }
        }
        after = await this.findListItemCoords(page, filterTitle, searchTerm);
        if (after?.selected) {
          await this.clearFilterSearchInput(page, filterTitle);
          return true;
        }
      }

      await this.clearFilterSearchInput(page, filterTitle);
      return false;
    };

    for (let i = 0; i < clickValues.length; i += 1) {
      const searchTerm = clickValues[i];

      if (isYearFilter && !isAllSelect) {
        const ok = await selectBySearchAndLastVisibleOption(searchTerm, i > 0);

        if (!ok) {
          this.logStep('list-filter', 'WARN', 'year selection via search/last-visible option failed', {
            filterTitle,
            value: searchTerm,
          });
        }

        await this.waitForSpotfireIdle(page, 8000);
        await this.locateFilterElement(page, filterTitle);
        continue;
      }

      const ok = await clickValueWithFallbacks(searchTerm, i === 0);

      if (!ok) {
        this.logStep('list-filter', 'WARN', 'value click did not immediately verify as selected', {
          filterTitle,
          value: searchTerm,
        });
      }

      // For subsequent values, use Ctrl+click to add selections
      if (i > 0) {
        await this.locateFilterElement(page, filterTitle);
        const item = await this.findListItemCoords(page, filterTitle, searchTerm);
        if (item && !item.selected) {
          await page.keyboard.down('Control');
          await page.mouse.click(item.labelX ?? item.clickX, item.labelY ?? item.clickY);
          await page.keyboard.up('Control');
          await new Promise((r) => setTimeout(r, 250));
          await this.waitForSpotfireIdle(page, 8000);
        }
      }

      await this.waitForSpotfireIdle(page, 8000);
      await this.locateFilterElement(page, filterTitle);
    }

    await this.waitForSpotfireIdle(page);

    // NOTE: Spotfire listboxes are virtualized. Selected items may not be rendered,
    // so verifying by scanning only visible `.sf-element-list-box-item` can produce false negatives.
    // To verify reliably, we search each expected value and check its selected state.
    const expectedNorm = clickValues.map((v) => this.normalizeForCompare(v));
    const verifiedSelected: string[] = [];

    if (!isAllSelect) {
      for (const verifyValue of clickValues) {
        await this.locateFilterElement(page, filterTitle);
        await this.activateFilter(page, filterTitle);

        // Try to find item without search first
        let item = await this.findListItemCoords(page, filterTitle, verifyValue);

        // If not visible, use SearchInput (when present) and try again
        if (!item) {
          await this.clearFilterSearchInput(page, filterTitle);
          const searchCoords = await this.getFilterSearchInputCoords(page, filterTitle);
          if (searchCoords) {
            await page.mouse.click(searchCoords.x, searchCoords.y, { clickCount: 3 });
            await new Promise((r) => setTimeout(r, 80));
            await page.keyboard.type(verifyValue, { delay: 30 });
            await page.keyboard.press('Enter').catch(() => undefined);
            await new Promise((r) => setTimeout(r, 350));
            item = await this.findListItemCoords(page, filterTitle, verifyValue);
          }
        }

        if (item?.selected) {
          verifiedSelected.push(item.label);
        }

        await this.clearFilterSearchInput(page, filterTitle);
      }
    }

    // For debugging only: capture any currently-visible selected items too
    const visibleSelected = await this.getSelectedListItems(page, filterTitle);
    const actualSelected = Array.from(new Set([...verifiedSelected, ...visibleSelected]));

    const summary = await readListFilterSummary();
    const expectedCount = isAllSelect ? null : clickValues.length;
    const countMatches = expectedCount !== null && summary.filteredCount !== null && summary.filteredCount === expectedCount;

    const allFound = isAllSelect
      || expectedNorm.every((exp) => actualSelected.some((act) => act.includes(exp) || exp.includes(act)))
      || countMatches;

    this.logStep('list-filter', allFound ? 'OK' : 'WARN', `list verification for ${filterTitle}`, {
      expected: expectedNorm,
      actual: actualSelected,
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

  private async getToggleOptions(page: Page, filterTitle: string): Promise<Array<{ label: string; checked: boolean; x: number; y: number }>> {
    return page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }

      const t = nc(title);
      const filterEl = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === t;
      });

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

      const t = nc(title);
      const filterEl = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === t;
      });

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

      const t = nc(title);
      const filterEl = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === t;
      });

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
      page = await browser.newPage();
      this.persistentPage = page;
      createdNewPage = true;
    }

    return { browser, page, createdNewPage };
  }

  private usesExternalBrowserConnection(): boolean {
    return Boolean(this.environment.spotfire.browserUrl || this.environment.spotfire.browserWSEndpoint);
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

  private async runSerialized<T>(task: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const waiter = new Promise<void>((resolveWaiter) => {
      release = resolveWaiter;
    });

    const previous = this.activeQueue;
    this.activeQueue = previous.then(() => waiter);

    await previous;

    try {
      return await task();
    } finally {
      release?.();
    }
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

    if (this.environment.spotfire.browserWSEndpoint) {
      this.log('connecting to existing browser by websocket endpoint', {
        browserWSEndpoint: this.environment.spotfire.browserWSEndpoint,
      });

      try {
        return await puppeteer.connect({
          browserWSEndpoint: this.environment.spotfire.browserWSEndpoint,
          defaultViewport: { width: 1600, height: 1000 },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not connect to the existing Edge browser via websocket endpoint. `
          + `Start Edge in remote-debugging mode first, then retry. Details: ${message}`,
        );
      }
    }

    if (this.environment.spotfire.browserUrl) {
      this.log('connecting to existing browser by remote debugging URL', {
        browserUrl: this.environment.spotfire.browserUrl,
      });

      try {
        return await puppeteer.connect({
          browserURL: this.environment.spotfire.browserUrl,
          defaultViewport: { width: 1600, height: 1000 },
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

      if (page.url().includes('/analysis') && await this.isAnalysisReady(page)) {
        this.log('reusing existing Spotfire analysis page', {
          reportTitle,
          currentUrl: page.url(),
        });
        return;
      }
    }

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

    this.log('login page detected, filling credentials', {
      currentUrl: page.url(),
      loginUrl: this.environment.spotfire.loginUrl,
    });

    await page.locator("input[type='text']").fill(this.environment.spotfire.username);
    await page.locator("input[type='password']").fill(this.environment.spotfire.password);

    await this.submitLogin(page);

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
    this.log('opening analysis tab by text', {
      tabLabel,
    });

    await this.clickByText(page, tabLabel, true);
    this.log('analysis tab clicked, waiting for Spotfire to refresh dependent tables', {
      tabLabel,
    });
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
   * Clear any text currently in the SearchInput of the given filter.
   * Uses evaluate to find the input and reset it, avoiding coordinate issues.
   */
  private async clearFilterSearchInput(page: Page, filterTitle: string): Promise<void> {
    await page.evaluate((title: string) => {
      function nc(v: string | null | undefined): string {
        return (v ?? '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      }
      function trimColon(v: string | null | undefined): string {
        return nc(v).replace(/:$/, '');
      }
      const t = trimColon(title);
      let filterEl = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter')).find((f) => {
        const el = f.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
        return nc(el?.getAttribute('title') ?? el?.textContent) === t;
      }) ?? null;
      if (!filterEl) {
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
      if (!filterEl) return;
      const input = filterEl.querySelector<HTMLInputElement>('input.SearchInput');
      if (input && input.value.length > 0) {
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, filterTitle);
    await new Promise((r) => setTimeout(r, 200));
  }

  /**
   * Build date strings (M/D/YYYY) for Data Referência directly from the
   * periodSelection, avoiding the need to scan the virtualized list.
   */
  private generateReferenceDates(periodSelection: NonNullable<ScannerRunRequest['periodSelection']>): string[] {
    const year = parseInt(periodSelection.year ?? '', 10);
    const monthIndex = MONTH_OPTIONS.indexOf((periodSelection.month ?? '').toLowerCase());

    if (Number.isNaN(year) || monthIndex === -1) {
      return [];
    }

    const minDay = periodSelection.dayRange?.min ?? 1;
    const maxDay = periodSelection.dayRange?.max ?? 31;
    const dates: string[] = [];

    for (let day = minDay; day <= maxDay; day += 1) {
      const d = new Date(year, monthIndex, day);
      // Stop if the date rolls into the next month (e.g. Feb 30 → Mar 2)
      if (d.getMonth() !== monthIndex) break;
      // Spotfire shows dates as M/D/YYYY (no leading zeros)
      dates.push(`${monthIndex + 1}/${day}/${year}`);
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

  private async maximizeTable(page: Page, tableTitle: string): Promise<void> {
    const maximized = await page.evaluate(function (requestedTableTitle) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      const requested = normalize(requestedTableTitle);

      const titles = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-visual-title'));
      const matchingTitle = titles.find(function (titleElement) {
        const textElement = titleElement.querySelector<HTMLElement>('.sf-element-text-box[title], .sf-single-line-text[title]');
        const title = normalize(textElement?.getAttribute('title') ?? textElement?.textContent);
        return title === requested || title.includes(requested);
      });

      if (!matchingTitle) {
        return false;
      }

      const maximizeButton = matchingTitle.querySelector<HTMLElement>('[title="Maximize visualization"], .sfc-maximize-visual-button');
      if (!maximizeButton) {
        return false;
      }

      maximizeButton.click();
      return true;
    }, tableTitle);

    if (!maximized) {
      throw new Error(`could not maximize table: ${tableTitle}`);
    }

    await this.waitForSpotfireIdle(page);
  }

  private async exportTable(page: Page, outputDirectory: string, request: ScannerRunRequest): Promise<string | undefined> {
    const cdpSession = await page.createCDPSession();
    await cdpSession.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: outputDirectory,
    });

    const existingFiles = new Set(await readdir(outputDirectory));
    await this.openExportMenu(page, request.tableTitle);
    await this.clickByText(page, this.environment.spotfire.exportMenuLabel, false);

    const downloadedFile = await this.waitForDownloadedFile(outputDirectory, existingFiles);
    return this.finalizeDownloadedFile(outputDirectory, downloadedFile, request);
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
    const yearValue = periodSelection.year && periodSelection.year !== ALL_OPTION ? periodSelection.year : '';
    const monthValue = periodSelection.month && periodSelection.month !== ALL_OPTION ? periodSelection.month : '';
    const builtFilters: SpotfireFilter[] = [];
    const resolvedYearTitle = this.resolveActualFilterTitle(filters, 'Ano');
    const resolvedMonthTitle = this.resolveActualFilterTitle(filters, 'Mês');

    if (yearValue && resolvedYearTitle) {
      const yearFilter = filters.find((filter) => this.normalizeFilterName(filter.title) === this.normalizeFilterName(resolvedYearTitle));
      builtFilters.push({
        title: resolvedYearTitle,
        kind: yearFilter?.kind ?? 'list',
        selectedValues: [yearValue],
      });
    }

    if (monthValue && resolvedMonthTitle) {
      const monthFilter = filters.find((filter) => this.normalizeFilterName(filter.title) === this.normalizeFilterName(resolvedMonthTitle));
      builtFilters.push({
        title: resolvedMonthTitle,
        kind: monthFilter?.kind ?? 'list',
        selectedValues: [monthValue],
      });
    }

    return builtFilters;
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

    const normalizedYear = periodSelection.year && periodSelection.year !== ALL_OPTION ? periodSelection.year : '';
    const normalizedMonth = periodSelection.month && periodSelection.month !== ALL_OPTION ? periodSelection.month : '';
    const selectedMonthIndex = MONTH_OPTIONS.indexOf(normalizedMonth.toLowerCase());
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

        if (normalizedYear && String(parsedDate.getFullYear()) !== normalizedYear) {
          return false;
        }

        if (selectedMonthIndex !== -1 && parsedDate.getMonth() !== selectedMonthIndex) {
          return false;
        }

        const day = parsedDate.getDate();
        return day >= minDay && day <= maxDay;
      });

    if (!selectedValues.length) {
      this.log('period selection did not resolve any Data Referência values', {
        year: periodSelection.year ?? null,
        month: periodSelection.month ?? null,
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
}