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

  public async runExtraction(request: ScannerRunRequest): Promise<ScannerAutomationResult> {
    return this.runSerialized(async () => {
      const outputDirectory = await this.prepareOutputDirectory();
      this.log('starting extraction run', {
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
        }

        await this.openAnalysis(page, request.reportTitle ?? this.environment.spotfire.defaultReportTitle);
        await this.ensureNoMaximizedVisualization(page);
        const availableTabs = await this.loadAvailableTabs(page);
        this.log('collected available tabs', {
          count: availableTabs.length,
          tabs: availableTabs,
        });

        if (request.analysisTab) {
          await this.openAnalysisTab(page, request.analysisTab);
          await this.ensureNoMaximizedVisualization(page);
        }

        await this.ensureFiltersPanel(page);
        await this.resetVisibleFilters(page);

        if (request.selectedFilters?.length) {
          await this.applySelectedFilters(page, request.selectedFilters);
        }

        const filters = await this.loadAllFilters(page);
        this.logFiltersSummary(filters);
        const availableTables = await this.loadAvailableTables(page);
        this.log('collected available tables', {
          count: availableTables.length,
          tables: availableTables,
        });

        let exportFilePath: string | undefined;
        if (request.tableTitle) {
          await this.maximizeTable(page, request.tableTitle);
          exportFilePath = await this.exportTable(page, outputDirectory, request);
        }

        return {
          filters,
          availableTabs,
          availableTables,
          exportFilePath,
        };
      } finally {
        if (!this.environment.spotfire.keepOpen) {
          this.log('closing browser because keepOpen=false');
          await this.disposeAutomationSession();
        } else {
          this.log('keeping browser and page open because keepOpen=true');
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

      await this.ensureFiltersPanel(page);

      const applied = await page.evaluate(async function (selection) {
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
          input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
          input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
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
            input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
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
        result: applied,
      });
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
    const panelIsOpen = await page.evaluate(function (panelLabel) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      return Array.from(document.querySelectorAll<HTMLElement>('.sf-element-panel-header, .sfc-filter-panel, .FilterPanelScroll'))
        .some(function (element) { return normalize(element.textContent).includes(panelLabel); });
    }, this.environment.spotfire.filterPanelLabel);

    if (panelIsOpen) {
      this.log('filters panel is already open on the right side', {
        panelLabel: this.environment.spotfire.filterPanelLabel,
      });
      return;
    }

    const opened = await page.evaluate(function (panelLabel) {
      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim();
      }

      function isVisible(element: HTMLElement): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      const candidates = Array.from(document.querySelectorAll<HTMLElement>('[title], [alt], #Spotfire.FilterPanel, .sfx_label_924, .sfx_tool-button_923'))
        .filter(function (element) { return isVisible(element); })
        .find(function (element) {
          const values = [
            normalize(element.getAttribute('title')),
            normalize(element.getAttribute('alt')),
            normalize(element.textContent),
          ].filter(function (value) { return value.length > 0; });

          return values.some(function (value) { return value === panelLabel; });
        });

      if (!candidates) {
        return false;
      }

      candidates.click();
      return true;
    }, this.environment.spotfire.filterPanelLabel);

    this.log('attempted to open filters panel by text', {
      panelLabel: this.environment.spotfire.filterPanelLabel,
      openedFromToolbar: opened,
    });

    if (!opened) {
      await this.clickByText(page, this.environment.spotfire.filterPanelLabel, true);
      this.log('opened filters panel using generic text click fallback', {
        panelLabel: this.environment.spotfire.filterPanelLabel,
      });
    }

    await this.waitForSpotfireIdle(page);
  }

  private async resetVisibleFilters(page: Page): Promise<void> {
    this.log('searching for reset visible filters button by title text', {
      title: 'Reset Visible Filters',
    });

    const resetButton = await page.$("[title='Reset Visible Filters']");

    if (!resetButton) {
      throw new Error('reset visible filters button not found');
    }

    await resetButton.click();
    this.log('clicked reset visible filters button');
    await this.waitForSpotfireIdle(page);
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
          ?? document.querySelector<HTMLElement>('.sfc-filter-panel .Container')
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