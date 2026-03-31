import { randomUUID } from 'node:crypto';
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

    if (details) {
      console.info(prefix, message, details);
      return;
    }

    console.info(prefix, message);
  }

  private logStep(step: string, status: 'START' | 'OK' | 'WARN' | 'FAIL', message: string, details?: Record<string, unknown>): void {
    this.log(`[${status}] ${step} :: ${message}`, details);
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
        await this.ensureAllFiltersVisible(page);
        await this.resetVisibleFilters(page);
        await this.waitForSpotfireIdle(page);
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

        const selectedFilters = request.selectedFilters ?? [];
        const directFilters = selectedFilters.filter((filter) => filter.title.trim().toLowerCase() !== 'data referência');

        if (directFilters.length) {
          this.logStep('filters', 'START', 'applying direct non-period filters', {
            count: directFilters.length,
            titles: directFilters.map((filter) => filter.title),
          });
          await this.ensureAllFiltersVisible(page);
          await this.applySelectedFilters(page, directFilters);
          this.logStep('filters', 'OK', 'finished applying direct non-period filters');
        }

        if (request.periodSelection) {
          this.logStep('period', 'START', 'resolving Ano/Mes/Dia selection to Data Referencia values', {
            periodSelection: request.periodSelection,
          });
          await this.ensureAllFiltersVisible(page);
          const currentFilters = await this.loadAllFilters(page);
          const referenceDateFilter = this.buildReferenceDateFilter(currentFilters, request.periodSelection);

          if (referenceDateFilter) {
            await this.applySelectedFilters(page, [referenceDateFilter]);
            this.logStep('period', 'OK', 'applied derived Data Referencia filter', {
              selectedValueCount: referenceDateFilter.selectedValues.length,
            });
          } else {
            this.logStep('period', 'WARN', 'period selection produced no Data Referencia values');
          }
        }

        const explicitReferenceDateFilters = selectedFilters.filter((filter) => filter.title.trim().toLowerCase() === 'data referência');
        if (explicitReferenceDateFilters.length) {
          this.logStep('filters', 'START', 'applying explicit Data Referencia filters from request', {
            count: explicitReferenceDateFilters.length,
          });
          await this.ensureAllFiltersVisible(page);
          await this.applySelectedFilters(page, explicitReferenceDateFilters);
          this.logStep('filters', 'OK', 'finished applying explicit Data Referencia filters');
        }

        await this.ensureAllFiltersVisible(page);
        const filters = await this.loadAllFilters(page);
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
          ? {
            selectedMin: filter.range.selectedMin,
            selectedMax: filter.range.selectedMax,
          }
          : null,
      })),
    });

    for (const filter of filters) {
      if (!this.hasRequestedFilterValue(filter)) {
        continue;
      }

      let applied: unknown = { applied: false, reason: 'not attempted' };

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await this.ensureFiltersPanel(page);
        await this.ensureAllFiltersVisible(page);

        applied = await page.evaluate(async function (selection) {
        function normalize(value: string | null | undefined): string {
          return (value ?? '').replace(/\s+/g, ' ').trim();
        }

        function normalizedLower(value: string | null | undefined): string {
          return normalize(value).toLowerCase();
        }

        function isVisible(element: HTMLElement | null | undefined): element is HTMLElement {
          if (!element) {
            return false;
          }

          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }

        function dispatchClick(target: HTMLElement, ctrlKey = false): void {
          target.scrollIntoView({ block: 'center', inline: 'center' });

          for (const eventName of ['mousedown', 'mouseup', 'click']) {
            target.dispatchEvent(new MouseEvent(eventName, {
              bubbles: true,
              cancelable: true,
              view: window,
              ctrlKey,
              metaKey: ctrlKey,
            }));
          }
        }

        async function wait(milliseconds: number): Promise<void> {
          await new Promise(function (resolveWait) { return window.setTimeout(resolveWait, milliseconds); });
        }

        function getFilterPanelScrollContainer(): HTMLElement | null {
          return document.querySelector<HTMLElement>('.FilterPanelScroll .Container')
            ?? document.querySelector<HTMLElement>('.StyledScrollbar.FilterPanelScroll .Container')
            ?? document.querySelector<HTMLElement>('.sfc-filter-panel .Container')
            ?? null;
        }

        function findFilterElement(filterTitle: string): HTMLElement | null {
          const requestedTitle = normalizedLower(filterTitle);
          const filters = Array.from(document.querySelectorAll<HTMLElement>('.sf-element-filter'));

          return filters.find(function (filterElement) {
            const titleElement = filterElement.querySelector<HTMLElement>('span.sf-element-filter-content.sf-element-filter-title[title]');
            const title = normalizedLower(titleElement?.getAttribute('title') ?? titleElement?.textContent);
            return title === requestedTitle;
          }) ?? null;
        }

        async function findFilterElementByScrolling(filterTitle: string): Promise<HTMLElement | null> {
          const existing = findFilterElement(filterTitle);

          if (existing) {
            return existing;
          }

          const scrollContainer = getFilterPanelScrollContainer();

          if (!scrollContainer) {
            return null;
          }

          const maxScrollTop = Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 0);
          const step = Math.max(Math.floor(scrollContainer.clientHeight * 0.75), 180);

          for (let offset = 0; offset <= maxScrollTop; offset += step) {
            scrollContainer.scrollTop = offset;
            scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            await wait(140);

            const candidate = findFilterElement(filterTitle);
            if (candidate) {
              return candidate;
            }
          }

          scrollContainer.scrollTop = maxScrollTop;
          scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(180);

          return findFilterElement(filterTitle);
        }

        function getFilterOptionScrollContainer(filterElement: HTMLElement): HTMLElement | null {
          return filterElement.querySelector<HTMLElement>('.ListContainer .sfc-scrollable')
            ?? filterElement.querySelector<HTMLElement>('.ListContainer .sf-element-list-box')
            ?? filterElement.querySelector<HTMLElement>('.StyledScrollbar.ListContainerScroll .sfc-scrollable')
            ?? null;
        }

        function matchesOptionLabel(candidateLabel: string, requestedLabel: string): boolean {
          if (candidateLabel === requestedLabel) {
            return true;
          }

          if (requestedLabel === '(all)') {
            return candidateLabel.startsWith('(all)');
          }

          return false;
        }

        function findVisibleListItem(filterElement: HTMLElement, itemLabel: string): HTMLElement | null {
          const requested = normalizedLower(itemLabel);
          const items = Array.from(filterElement.querySelectorAll<HTMLElement>('.sf-element-list-box-item'));

          return items.find(function (candidate) {
            const label = normalizedLower(candidate.getAttribute('title') ?? candidate.textContent);
            return matchesOptionLabel(label, requested);
          }) ?? null;
        }

        async function findListItemByScrolling(filterElement: HTMLElement, itemLabel: string): Promise<HTMLElement | null> {
          const existing = findVisibleListItem(filterElement, itemLabel);

          if (existing) {
            return existing;
          }

          const scrollContainer = getFilterOptionScrollContainer(filterElement);

          if (!scrollContainer) {
            return null;
          }

          const maxScrollTop = Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 0);
          const step = Math.max(Math.floor(scrollContainer.clientHeight * 0.75), 30);

          for (let offset = 0; offset <= maxScrollTop; offset += step) {
            scrollContainer.scrollTop = offset;
            scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            await wait(100);

            const candidate = findVisibleListItem(filterElement, itemLabel);
            if (candidate) {
              return candidate;
            }
          }

          scrollContainer.scrollTop = maxScrollTop;
          scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(140);

          return findVisibleListItem(filterElement, itemLabel);
        }

        async function applyTextFilter(filterElement: HTMLElement, textValue: string): Promise<boolean> {
          const input = filterElement.querySelector<HTMLInputElement>('input[placeholder*="Type to filter by text"], input.SearchInput');

          if (!input) {
            return false;
          }

          input.focus();
          input.value = textValue;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
          await wait(250);
          return true;
        }

        async function clickListItem(filterElement: HTMLElement, itemLabel: string, ctrlKey: boolean): Promise<boolean> {
          const item = await findListItemByScrolling(filterElement, itemLabel);

          if (!item) {
            return false;
          }

          dispatchClick(item, ctrlKey);
          await wait(180);
          return true;
        }

        async function applyListFilter(filterElement: HTMLElement, selectedValues: string[]): Promise<boolean> {
          const normalizedSelections = selectedValues
            .map(function (value) { return normalize(value); })
            .filter(function (value) { return value.length > 0; });

          if (!normalizedSelections.length) {
            return true;
          }

          if (normalizedSelections.some(function (value) { return normalizedLower(value).startsWith('(all)'); })) {
            return clickListItem(filterElement, '(All)', false);
          }

          let appliedAny = false;

          for (let index = 0; index < normalizedSelections.length; index += 1) {
            const applied = await clickListItem(filterElement, normalizedSelections[index], index > 0);
            appliedAny = appliedAny || applied;
          }

          return appliedAny;
        }

        async function applyToggleGroup(filterElement: HTMLElement, selectedValues: string[]): Promise<boolean> {
          const desired = new Set(selectedValues.map(function (value) { return normalizedLower(value); }));
          const options = Array.from(filterElement.querySelectorAll<HTMLElement>('.ColumnFilter .sf-element-filter-item'));
          let touched = false;

          for (const option of options) {
            const labelElement = option.querySelector<HTMLElement>('.sf-element-text-box');
            const checkbox = option.querySelector<HTMLElement>('.sf-element-check-box');
            const label = normalizedLower(labelElement?.getAttribute('title') ?? labelElement?.textContent);

            if (!checkbox || !label) {
              continue;
            }

            const shouldBeSelected = desired.has(label);
            const isSelected = checkbox.classList.contains('sfpc-checked');

            if (shouldBeSelected !== isSelected) {
              dispatchClick(option);
              await wait(120);
              touched = true;
            }
          }

          return touched || desired.size === 0;
        }

        async function applyRangeFilter(filterElement: HTMLElement, selectedMin: string, selectedMax: string): Promise<boolean> {
          const labels = Array.from(filterElement.querySelectorAll<HTMLElement>('.EditableLabel'));

          if (labels.length < 2) {
            return false;
          }

          const requestedValues = [selectedMin, selectedMax];

          for (let index = 0; index < 2; index += 1) {
            const targetLabel = labels[index];
            const requestedValue = requestedValues[index];

            if (!requestedValue) {
              continue;
            }

            targetLabel.scrollIntoView({ block: 'center', inline: 'center' });
            dispatchClick(targetLabel);
            await wait(120);

            const input = filterElement.querySelector<HTMLInputElement>('input:not(.SearchInput)')
              ?? (document.activeElement instanceof HTMLInputElement ? document.activeElement : null);

            if (!input) {
              return false;
            }

            input.focus();
            input.value = requestedValue;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.blur();
            await wait(200);
          }

          return true;
        }

        const filterElement = await findFilterElementByScrolling(selection.title);

        if (!filterElement) {
          return { applied: false, reason: 'filter not found in DOM' };
        }

        filterElement.scrollIntoView({ block: 'center', inline: 'nearest' });
        await wait(180);

        if (selection.kind === 'text') {
          const applied = await applyTextFilter(filterElement, normalize(selection.textValue));
          return { applied, reason: applied ? 'text filter applied' : 'text input not found' };
        }

        if (selection.kind === 'list') {
          const applied = await applyListFilter(filterElement, selection.selectedValues ?? []);
          return { applied, reason: applied ? 'list filter applied' : 'list items not found' };
        }

        if (selection.kind === 'toggle-group') {
          const applied = await applyToggleGroup(filterElement, selection.selectedValues ?? []);
          return { applied, reason: applied ? 'toggle group applied' : 'toggle items not found' };
        }

        if (selection.kind === 'range' && selection.range) {
          const applied = await applyRangeFilter(filterElement, normalize(selection.range.selectedMin), normalize(selection.range.selectedMax));
          return { applied, reason: applied ? 'range filter applied' : 'range editor not found' };
        }

        return { applied: false, reason: `unsupported filter kind: ${selection.kind}` };
        }, filter);

        this.log('filter application result', {
          title: filter.title,
          kind: filter.kind,
          attempt,
          result: applied,
        });

        if ((applied as { applied?: boolean }).applied) {
          break;
        }

        await this.waitForSpotfireIdle(page);
      }
    }

    await this.waitForSpotfireIdle(page);
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

  private async disposeAutomationSession(): Promise<void> {
    const browser = this.persistentBrowser;

    this.persistentPage = undefined;
    this.persistentBrowser = undefined;

    if (browser && browser.connected) {
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
    });

    return puppeteer.launch({
      headless: this.environment.spotfire.headless,
      executablePath: this.environment.spotfire.browserPath || undefined,
      defaultViewport: null,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
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

    return page.evaluate(function () {
      return document.querySelector("input[type='password']") !== null
        && document.querySelector("input[type='text']") !== null;
    });
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
    this.logStep('filters-reset', 'START', 'searching for the Reset Visible Filters button', {
      title: 'Reset Visible Filters',
    });

    let resetTarget = await page.evaluate(function () {
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

      function findResetButton(): HTMLElement | null {
        return Array.from(document.querySelectorAll<HTMLElement>('[title], [aria-label], button, div, span, svg, path'))
          .filter(function (element) { return isVisible(element); })
          .find(function (element) {
            const values = [
              normalize(element.getAttribute('title')),
              normalize(element.getAttribute('aria-label')),
              normalize(element.textContent),
            ].filter(function (value) { return value.length > 0; });

            return element.classList.contains('ResetButton')
              || values.some(function (value) { return value === 'reset visible filters'; });
          }) ?? null;
      }

      const resetButton = findResetButton();
      if (!resetButton) {
        return null;
      }

      resetButton.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = resetButton.getBoundingClientRect();

      return {
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2),
        width: rect.width,
        height: rect.height,
        title: resetButton.getAttribute('title') ?? '',
        className: resetButton.className,
      };
    });

    if (!resetTarget) {
      this.logStep('filters-reset', 'WARN', 'reset button not found in DOM, opening filters panel before retry', {
        title: 'Reset Visible Filters',
      });
      await this.ensureFiltersPanel(page);
      resetTarget = await page.evaluate(function () {
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

        const resetButton = Array.from(document.querySelectorAll<HTMLElement>('[title], [aria-label], button, div, span, svg, path'))
          .filter(function (element) { return isVisible(element); })
          .find(function (element) {
            const values = [
              normalize(element.getAttribute('title')),
              normalize(element.getAttribute('aria-label')),
              normalize(element.textContent),
            ].filter(function (value) { return value.length > 0; });

            return element.classList.contains('ResetButton')
              || values.some(function (value) { return value === 'reset visible filters'; });
          });

        if (!resetButton) {
          return null;
        }

        resetButton.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = resetButton.getBoundingClientRect();

        return {
          x: rect.left + (rect.width / 2),
          y: rect.top + (rect.height / 2),
          width: rect.width,
          height: rect.height,
          title: resetButton.getAttribute('title') ?? '',
          className: resetButton.className,
        };
      });
    }

    if (!resetTarget) {
      this.logStep('filters-reset', 'FAIL', 'could not find Reset Visible Filters button after retry');
      throw new Error('reset visible filters button not found');
    }

    this.logStep('filters-reset', 'START', 'resolved visible reset target and will click by mouse coordinates', resetTarget);
    await page.mouse.move(resetTarget.x, resetTarget.y);
    await page.mouse.down();
    await page.mouse.up();

    this.logStep('filters-reset', 'OK', 'sent real mouse click to Reset Visible Filters target', resetTarget);
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

  private buildReferenceDateFilter(filters: SpotfireFilter[], periodSelection: NonNullable<ScannerRunRequest['periodSelection']>): SpotfireFilter | undefined {
    const referenceDateFilter = filters.find((filter) => filter.title.trim().toLowerCase() === 'data referência');

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
      title: 'Data Referência',
      kind: 'list',
      selectedValues,
    };
  }

  private parseReferenceDate(label: string): Date | undefined {
    const directDate = new Date(label);

    if (!Number.isNaN(directDate.getTime())) {
      return directDate;
    }

    const parts = label.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
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

  private async waitForSpotfireIdle(page: Page): Promise<void> {
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
      { timeout: 120000 },
    ).catch(() => undefined);
  }
}