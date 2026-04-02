import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';

import { ScannerApiService } from '../../core/api/scanner-api.service';
import { SpotfireCatalog, SpotfireFilter } from '../../models/spotfire-catalog.model';

type FilterKey = 'ano' | 'mes' | 'atuacaoHd' | 'base';
type ReportTypeValue = 'completo';

type SelectFilterState = {
  key: FilterKey;
  title: string;
  value: string;
  options: string[];
  sourceTitle?: string;
  sourceKind?: SpotfireFilter['kind'];
  enabled: boolean;
};

type ReportTypeOption = {
  value: ReportTypeValue;
  label: string;
};

type PeriodSelectionPayload = {
  year?: string;
  month?: string;
  dayRange?: {
    min: number;
    max: number;
  };
};

const ALL_OPTION = 'All';
const DEFAULT_REPORT_TITLE = 'Scanner 4.0 - CE';
const MONTH_OPTIONS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ATUACAO_HD_OPTIONS = ['Cadastrar', 'CORTE E RELIGAÇÃO', 'EMERGENCIA', 'LIGAÇÕES NOVAS', 'MANUTENÇÃO/OBRAS', 'PERDAS'];
const BASE_OPTIONS = ['Cadastrar', 'ATLÂNTICO', 'CENTRO-NORTE', 'CENTRO-SUL', 'FORTALEZA', 'LESTE', 'METROPOLITANA', 'NORTE', 'SUL'];
const FILTER_SOURCE_MAP: Record<'atuacaoHd' | 'base', { sourceTitle: string; sourceKind: SpotfireFilter['kind'] }> = {
  atuacaoHd: { sourceTitle: 'Atuação', sourceKind: 'list' },
  base: { sourceTitle: 'Base', sourceKind: 'list' },
};
const REPORT_TYPE_OPTIONS: ReportTypeOption[] = [
  {
    value: 'completo',
    label: 'Completo',
  },
];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  template: `
    <main class="shell">
      <div class="loading-popup-backdrop" *ngIf="catalogLoading() && !filtersVisible()">
        <section class="loading-popup" aria-live="polite" aria-busy="true">
          <div class="loading-spinner"></div>
          <h2>Abrindo Scanner M300</h2>
        </section>
      </div>

      <div class="report-loading" *ngIf="loading()" aria-live="polite" aria-busy="true">
        <div class="loading-spinner"></div>
        <p>Aplicando filtros e baixando tabelas</p>
      </div>

      <ng-container *ngIf="filtersVisible()">
        <button
          *ngIf="!filterDrawerOpen()"
          type="button"
          class="filter-fab"
          [disabled]="loading()"
          (click)="openFilterDrawer()"
          aria-label="Abrir filtros">
            <span class="filter-fab-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path>
              </svg>
            </span>
        </button>

        <div class="drawer-backdrop" *ngIf="filterDrawerOpen()" (click)="closeFilterDrawer()"></div>

        <aside class="filter-drawer" [class.filter-drawer-open]="filterDrawerOpen()">
          <div class="drawer-head">
            <h2>Filtros</h2>
            <button type="button" class="drawer-submit" [disabled]="loading()" (click)="submit()">
              {{ loading() ? 'Filtrando...' : 'Filtrar' }}
            </button>
          </div>

          <div class="drawer-body">
            <article class="drawer-card">
              <div class="drawer-card-head">
                <h3>Tipo de Relatório</h3>
              </div>

              <label class="select-shell">
                <span class="select-caption">Valor ativo</span>
                <div class="option-list" role="listbox" aria-label="Tipo de Relatório">
                  <button
                    type="button"
                    class="option-item"
                    *ngFor="let option of reportTypeOptions"
                    [class.option-item-active]="reportType() === option.value"
                    (click)="updateReportType(option.value)">
                    {{ option.label }}
                  </button>
                </div>
              </label>
            </article>

            <article class="drawer-card drawer-card-period">
              <div class="drawer-card-head">
                <h3>Período</h3>
              </div>

              <div class="period-shell">
                <div class="period-selects">
                  <label class="select-shell" *ngFor="let filter of periodFilters()">
                    <span class="select-caption">{{ filter.title }}</span>
                    <div class="option-list" role="listbox" [attr.aria-label]="filter.title">
                      <button
                        type="button"
                        class="option-item"
                        *ngFor="let option of filter.options"
                        [class.option-item-active]="filter.value === option"
                        (click)="updateSelectFilter(filter.key, option)">
                        {{ option }}
                      </button>
                    </div>
                  </label>
                </div>

                <div class="day-range-shell">
                  <div class="range-summary-shell">
                    <span class="select-caption">Dia</span>
                    <div class="day-range-display">
                      <div>
                        <strong>{{ dayRange().min }}</strong>
                      </div>

                      <div>
                        <strong>{{ dayRange().max }}</strong>
                      </div>
                    </div>
                  </div>

                  <div
                    class="dual-slider"
                    [style.--range-start]="dayRangeStart() + '%'"
                    [style.--range-end]="dayRangeEnd() + '%'">
                    <input type="range" min="1" [max]="dayLimit()" step="1" [value]="dayRange().min" (input)="updateDayRange('min', $event)" aria-label="Dia inicial" />
                    <input type="range" min="1" [max]="dayLimit()" step="1" [value]="dayRange().max" (input)="updateDayRange('max', $event)" aria-label="Dia final" />
                  </div>
                </div>
              </div>
            </article>

            <article class="drawer-card" *ngFor="let filter of secondaryFilters()">
              <div class="drawer-card-head">
                <h3>{{ filter.title }}</h3>
              </div>

              <label class="select-shell">
                <span class="select-caption">Valor ativo</span>
                <div class="option-list" role="listbox" [attr.aria-label]="filter.title">
                  <button
                    type="button"
                    class="option-item"
                    *ngFor="let option of filter.options"
                    [class.option-item-active]="filter.value === option"
                    (click)="updateSelectFilter(filter.key, option)">
                    {{ option }}
                  </button>
                </div>
              </label>
            </article>
          </div>
        </aside>

        <section class="workspace-stage" aria-hidden="true"></section>
      </ng-container>
    </main>
  `,
  styles: [
    `
      .shell {
        --accent: #c1121f;
        --accent-strong: #7a0912;
        --surface: rgba(255, 255, 255, 0.98);
        --surface-strong: rgba(245, 245, 245, 0.96);
        --text: #101010;
        --line: rgba(16, 16, 16, 0.12);
        --muted-strong: rgba(16, 16, 16, 0.58);
        min-height: 100vh;
        position: relative;
        overflow: hidden;
        background: linear-gradient(180deg, #ffffff 0%, #f3f3f3 100%);
      }

      .shell::before,
      .shell::after {
        content: '';
        position: absolute;
        border-radius: 999px;
        pointer-events: none;
        filter: blur(24px);
      }

      .shell::before {
        width: 360px;
        height: 360px;
        top: -80px;
        right: -140px;
        background: radial-gradient(circle, rgba(193, 18, 31, 0.18), transparent 70%);
      }

      .shell::after {
        width: 320px;
        height: 320px;
        left: -120px;
        bottom: -60px;
        background: radial-gradient(circle, rgba(16, 16, 16, 0.12), transparent 72%);
      }

      .workspace-stage {
        min-height: 100vh;
      }

      .report-loading {
        position: fixed;
        inset: 0;
        z-index: 1003;
        display: grid;
        place-items: center;
        gap: 10px;
        pointer-events: none;
        align-content: center;
        justify-items: center;
      }

      .report-loading p {
        margin: 0;
        color: var(--accent-strong);
        font-size: 0.92rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .loading-popup-backdrop,
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.34);
        backdrop-filter: blur(8px);
      }

      .loading-popup-backdrop {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }

      .loading-popup {
        width: min(420px, 100%);
        text-align: center;
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 24px;
        padding: 28px 24px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.16);
      }

      .loading-spinner {
        width: 48px;
        height: 48px;
        margin: 0 auto 14px;
        border-radius: 50%;
        border: 4px solid rgba(193, 18, 31, 0.14);
        border-top-color: var(--accent);
        animation: loading-spin 0.9s linear infinite;
      }

      @keyframes loading-spin {
        to { transform: rotate(360deg); }
      }

      .filter-fab {
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 1102;
        width: 42px;
        height: 42px;
        border: 0;
        border-radius: 14px;
        padding: 0;
        display: grid;
        place-items: center;
        background: linear-gradient(145deg, rgba(255, 255, 255, 0.98), rgba(237, 237, 237, 0.94));
        border: 1px solid rgba(23, 26, 31, 0.08);
        box-shadow: 0 14px 30px rgba(0, 0, 0, 0.16);
        color: var(--accent-strong);
        cursor: pointer;
        transition: transform 0.18s ease, width 0.2s ease, padding 0.2s ease, border-radius 0.2s ease, opacity 0.18s ease;
      }

      .filter-fab:hover {
        transform: translateY(-1px);
      }

      .filter-fab:disabled {
        opacity: 0.7;
        cursor: wait;
        transform: none;
      }

      .filter-fab-icon svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }

      .filter-drawer {
        position: fixed;
        top: 0;
        right: 0;
        z-index: 1101;
        width: min(380px, calc(100vw - 20px));
        height: 100vh;
        padding: 40px 18px 18px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(240, 240, 240, 0.96)),
          radial-gradient(circle at top right, rgba(193, 18, 31, 0.12), transparent 38%);
        border-left: 1px solid rgba(23, 26, 31, 0.08);
        box-shadow: -24px 0 60px rgba(0, 0, 0, 0.18);
        transform: translateX(100%);
        transition: transform 0.24s ease;
        overflow: auto;
      }

      .filter-drawer-open {
        transform: translateX(0);
      }

      .drawer-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }

      .drawer-submit {
        border: 0;
        border-radius: 999px;
        padding: 10px 16px;
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: white;
        background: linear-gradient(135deg, var(--accent) 0%, #7a0912 100%);
        cursor: pointer;
      }

      .drawer-submit:disabled {
        opacity: 0.7;
        cursor: wait;
      }

      .drawer-body {
        display: grid;
        gap: 6px;
        margin-top: 0;
      }

      .drawer-card {
        padding: 9px 10px;
        border-radius: 16px;
        border: 1px solid rgba(23, 26, 31, 0.08);
        background: rgba(255, 255, 255, 0.84);
        display: grid;
        gap: 3px;
      }

      .drawer-card-period {
        gap: 6px;
      }

      .period-shell {
        display: grid;
        gap: 5px;
      }

      .period-selects {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 5px;
      }

      .select-shell,
      .slider-label {
        display: grid;
        gap: 2px;
      }

      .select-shell {
        min-width: 0;
      }

      .select-caption {
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 0.56rem;
        color: var(--muted-strong);
      }

      h2 {
        margin: 0;
        font-size: 1.08rem;
        line-height: 1.04;
      }

      h3 {
        margin: 0;
        font-size: 0.96rem;
        line-height: 1.06;
      }

      input {
        width: 100%;
        border-radius: 12px;
        border: 1px solid rgba(23, 26, 31, 0.12);
        padding: 10px 12px;
        background: var(--surface-strong);
        color: var(--text);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
        font-size: 0.92rem;
      }

      input:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .option-list {
        display: grid;
        gap: 3px;
        max-height: 116px;
        overflow-y: auto;
        padding: 3px;
        border-radius: 10px;
        border: 1px solid rgba(23, 26, 31, 0.12);
        background: var(--surface-strong);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
      }

      .period-selects .option-list {
        gap: 2px;
        max-height: 98px;
        padding: 2px;
        align-content: start;
      }

      .period-selects .option-item {
        padding: 4px 6px;
        font-size: 0.75rem;
        line-height: 1;
      }

      .option-item {
        width: 100%;
        border: 1px solid rgba(23, 26, 31, 0.08);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.92);
        color: var(--text);
        padding: 5px 7px;
        font: inherit;
        font-size: 0.78rem;
        line-height: 1.05;
        text-align: left;
        cursor: pointer;
        transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
      }

      .option-item:hover {
        border-color: rgba(193, 18, 31, 0.34);
        background: rgba(255, 238, 239, 0.96);
      }

      .option-item-active {
        border-color: rgba(193, 18, 31, 0.44);
        background: rgba(255, 226, 229, 0.98);
        color: var(--accent);
        font-weight: 600;
      }

      .day-range-shell {
        padding: 6px;
        border-radius: 12px;
        background: var(--surface-strong);
        border: 1px solid rgba(23, 26, 31, 0.08);
        display: grid;
        gap: 4px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
      }

      .range-summary-shell {
        display: grid;
        gap: 3px;
      }

      .day-range-display {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 4px;
      }

      .day-range-display > div {
        padding: 6px 8px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.66);
        border: 1px solid rgba(23, 26, 31, 0.08);
      }

      .day-range-display strong {
        font-size: 0.88rem;
      }

      .dual-slider {
        position: relative;
        height: 28px;
        display: grid;
        align-items: center;
      }

      .dual-slider::before {
        content: '';
        position: absolute;
        left: 3px;
        right: 3px;
        top: 50%;
        height: 6px;
        transform: translateY(-50%);
        border-radius: 999px;
        background: linear-gradient(
          90deg,
          rgba(23, 26, 31, 0.12) 0%,
          rgba(23, 26, 31, 0.12) var(--range-start),
          rgba(193, 18, 31, 0.82) var(--range-start),
          rgba(193, 18, 31, 0.82) var(--range-end),
          rgba(23, 26, 31, 0.12) var(--range-end),
          rgba(23, 26, 31, 0.12) 100%
        );
      }

      .dual-slider input[type='range'] {
        position: absolute;
        inset: 0;
        width: 100%;
        padding: 0;
        border: 0;
        background: transparent;
        appearance: none;
        -webkit-appearance: none;
        pointer-events: none;
      }

      .dual-slider input[type='range']::-webkit-slider-runnable-track {
        height: 6px;
        background: transparent;
      }

      .dual-slider input[type='range']::-moz-range-track {
        height: 6px;
        background: transparent;
      }

      .dual-slider input[type='range']::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        margin-top: -4px;
        border-radius: 50%;
        border: 2px solid var(--accent);
        background: #ffffff;
        box-shadow: 0 2px 6px rgba(23, 26, 31, 0.18);
        pointer-events: auto;
        cursor: pointer;
      }

      .dual-slider input[type='range']::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid var(--accent);
        background: #ffffff;
        box-shadow: 0 2px 6px rgba(23, 26, 31, 0.18);
        pointer-events: auto;
        cursor: pointer;
      }

      @media (max-width: 720px) {
        .filter-fab {
          top: 16px;
          right: 16px;
          width: 40px;
          height: 40px;
          border-radius: 12px;
        }

        .day-range-display,
        .period-selects {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 560px) {
        .filter-drawer {
          width: calc(100vw - 8px);
          padding-top: 36px;
          padding-left: 14px;
          padding-right: 14px;
        }
      }
    `,
  ],
})
export class DashboardComponent implements OnInit, OnDestroy {
  protected readonly api = inject(ScannerApiService);
  protected readonly allOption = ALL_OPTION;

  protected readonly loading = signal(false);
  protected readonly catalogLoading = signal(true);
  protected readonly catalog = signal<SpotfireCatalog | null>(null);
  protected readonly catalogRequestError = signal<string | null>(null);
  protected readonly rawCatalogFilters = signal<SpotfireFilter[]>([]);
  protected readonly filterDrawerOpen = signal(false);
  protected readonly reportTitle = signal(DEFAULT_REPORT_TITLE);
  protected readonly reportType = signal<ReportTypeValue>('completo');
  protected readonly selectFilters = signal<SelectFilterState[]>([]);
  protected readonly dayRange = signal({ min: 1, max: 31 });
  protected readonly reportTypeOptions = REPORT_TYPE_OPTIONS;
  protected readonly filtersVisible = computed(() => this.selectFilters().length > 0);
  protected readonly periodFilters = computed(() => this.selectFilters().filter((filter) => filter.key === 'ano' || filter.key === 'mes'));
  protected readonly secondaryFilters = computed(() => this.selectFilters().filter((filter) => filter.key !== 'ano' && filter.key !== 'mes'));
  protected readonly dayLimit = computed(() => {
    const year = this.periodFilters().find((filter) => filter.key === 'ano')?.value ?? '';
    const month = this.periodFilters().find((filter) => filter.key === 'mes')?.value ?? '';
    const days = this.dayOptionsFromSelection(year, month);
    return days[days.length - 1] ?? 31;
  });
  protected readonly dayRangeStart = computed(() => {
    const limit = this.dayLimit();
    return limit > 1 ? ((this.dayRange().min - 1) / (limit - 1)) * 100 : 0;
  });
  protected readonly dayRangeEnd = computed(() => {
    const limit = this.dayLimit();
    return limit > 1 ? ((this.dayRange().max - 1) / (limit - 1)) * 100 : 100;
  });

  private catalogPollTimer?: ReturnType<typeof setTimeout>;

  public ngOnInit(): void {
    const builtFilters = this.buildSelectFilters();
    this.selectFilters.set(builtFilters);
    this.dayRange.set(this.buildDayRange(new Map(builtFilters.map((filter) => [filter.key, filter.value]))));
    this.loadCatalog();
  }

  public ngOnDestroy(): void {
    this.clearCatalogPoll();
  }

  protected openFilterDrawer(): void {
    this.filterDrawerOpen.set(true);
  }

  protected closeFilterDrawer(): void {
    if (this.loading()) {
      return;
    }

    this.filterDrawerOpen.set(false);
  }

  protected updateReportType(value: ReportTypeValue | string): void {
    if (!value) {
      return;
    }

    this.reportType.set(value as ReportTypeValue);
  }

  protected updateSelectFilter(key: FilterKey, value: string): void {
    const updatedFilters = this.selectFilters().map((filter) => filter.key === key ? { ...filter, value } : filter);

    if (key === 'ano' || key === 'mes') {
      const overrideValues = new Map(updatedFilters.map((filter) => [filter.key, filter.value]));
      const rebuiltFilters = this.buildSelectFilters(overrideValues);
      this.selectFilters.set(rebuiltFilters);
      this.dayRange.set(this.buildDayRange(new Map(rebuiltFilters.map((filter) => [filter.key, filter.value]))));
      return;
    }

    this.selectFilters.set(updatedFilters);
  }

  protected updateDayRange(boundary: 'min' | 'max', event: Event): void {
    const value = Number((event.target as HTMLInputElement | null)?.value ?? Number.NaN);
    if (Number.isNaN(value)) {
      return;
    }

    this.dayRange.update((range) => {
      const nextMin = boundary === 'min' ? Math.min(value, range.max) : range.min;
      const nextMax = boundary === 'max' ? Math.max(value, range.min) : range.max;
      return { min: nextMin, max: nextMax };
    });
  }

  protected catalogReady(): boolean {
    return this.catalog()?.status === 'ready';
  }

  protected submit(): void {
    if (this.loading() || !this.filtersVisible()) {
      return;
    }

    this.filterDrawerOpen.set(false);
    this.loading.set(true);

    const selectedFilters = this.buildSelectedFilters();

    this.api.dataDownload({
      reportTitle: this.reportTitle(),
      selectedFilters,
      periodSelection: this.buildPeriodSelection(),
    }).subscribe({
      next: () => {
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  private loadCatalog(): void {
    this.clearCatalogPoll();
    this.catalogLoading.set(true);
    this.catalogRequestError.set(null);

    this.api.getCatalog()
      .subscribe({
        next: (catalog) => {
          this.catalog.set(catalog);
          this.rawCatalogFilters.set([]);

          const builtFilters = this.buildSelectFilters();
          this.selectFilters.set(builtFilters);
          this.dayRange.set(this.buildDayRange(new Map(builtFilters.map((filter) => [filter.key, filter.value]))));
          this.reportTitle.set(catalog.reportTitle || DEFAULT_REPORT_TITLE);
          this.catalogLoading.set(catalog.status === 'loading');

          if (catalog.status === 'loading') {
            this.scheduleCatalogPoll();
          }
        },
        error: (error) => {
          this.catalogLoading.set(false);
          this.catalogRequestError.set(this.describeHttpError(error));
          this.rawCatalogFilters.set([]);
          const builtFilters = this.buildSelectFilters();
          this.selectFilters.set(builtFilters);
          this.dayRange.set(this.buildDayRange(new Map(builtFilters.map((filter) => [filter.key, filter.value]))));
        },
      });
  }

  private scheduleCatalogPoll(): void {
    this.clearCatalogPoll();
    this.catalogPollTimer = setTimeout(() => {
      this.loadCatalog();
    }, 2000);
  }

  private clearCatalogPoll(): void {
    if (!this.catalogPollTimer) {
      return;
    }

    clearTimeout(this.catalogPollTimer);
    this.catalogPollTimer = undefined;
  }

  private buildSelectFilters(overrideValues?: Map<FilterKey, string>): SelectFilterState[] {
    const previous = overrideValues ?? new Map(this.selectFilters().map((filter) => [filter.key, filter.value]));
    const availableYears = this.yearOptions();
    const fallbackYear = availableYears.includes(String(new Date().getFullYear())) ? String(new Date().getFullYear()) : (availableYears[0] ?? '');
    const anoValue = this.resolveValue(previous.get('ano'), this.withAllOption(availableYears), fallbackYear);

    const availableMonths = this.monthOptionsFromSelection(anoValue);
    const currentMonth = MONTH_OPTIONS[new Date().getMonth()];
    const fallbackMonth = availableMonths.includes(currentMonth) ? currentMonth : (availableMonths[0] ?? '');
    const mesValue = this.resolveValue(previous.get('mes'), this.withAllOption(availableMonths), fallbackMonth);

    return [
      {
        key: 'ano',
        title: 'Ano',
        value: anoValue,
        options: this.withAllOption(availableYears),
        enabled: true,
      },
      {
        key: 'mes',
        title: 'Mês',
        value: mesValue,
        options: this.withAllOption(availableMonths),
        enabled: true,
      },
      {
        key: 'atuacaoHd',
        title: 'Atuação',
        value: this.resolveValue(previous.get('atuacaoHd'), this.withAllOption(ATUACAO_HD_OPTIONS), ''),
        options: this.withAllOption(ATUACAO_HD_OPTIONS),
        sourceTitle: FILTER_SOURCE_MAP.atuacaoHd.sourceTitle,
        sourceKind: FILTER_SOURCE_MAP.atuacaoHd.sourceKind,
        enabled: true,
      },
      {
        key: 'base',
        title: 'Base',
        value: this.resolveValue(previous.get('base'), this.withAllOption(BASE_OPTIONS), ''),
        options: this.withAllOption(BASE_OPTIONS),
        sourceTitle: FILTER_SOURCE_MAP.base.sourceTitle,
        sourceKind: FILTER_SOURCE_MAP.base.sourceKind,
        enabled: true,
      },
    ];
  }

  private buildDayRange(overrideValues?: Map<FilterKey, string>): { min: number; max: number } {
    const previous = this.dayRange();
    const values = overrideValues ?? new Map(this.selectFilters().map((filter) => [filter.key, filter.value]));
    const days = this.dayOptionsFromSelection(values.get('ano') ?? '', values.get('mes') ?? '');
    const minDay = days[0] ?? 1;
    const maxDay = days[days.length - 1] ?? 31;

    return {
      min: Math.max(minDay, Math.min(previous.min, maxDay)),
      max: Math.max(Math.max(minDay, previous.min), Math.min(previous.max, maxDay)),
    };
  }

  private yearOptions(): string[] {
    const currentYear = new Date().getFullYear();
    return [String(currentYear), String(currentYear - 1)];
  }

  private monthOptionsFromSelection(selectedYear: string): string[] {
    const normalizedYear = selectedYear === ALL_OPTION ? '' : selectedYear;
    const currentYear = new Date().getFullYear();
    const selectedYearNumber = Number(normalizedYear);

    if (normalizedYear && Number.isFinite(selectedYearNumber) && selectedYearNumber < currentYear) {
      return MONTH_OPTIONS;
    }

    return MONTH_OPTIONS.slice(0, new Date().getMonth() + 1);
  }

  private dayOptionsFromSelection(selectedYear: string, selectedMonth: string): number[] {
    const normalizedYear = selectedYear === ALL_OPTION ? '' : selectedYear;
    const normalizedMonth = selectedMonth === ALL_OPTION ? '' : selectedMonth;
    const selectedMonthIndex = MONTH_OPTIONS.indexOf(normalizedMonth);

    if (selectedMonthIndex === -1) {
      return Array.from({ length: 31 }, (_, index) => index + 1);
    }

    const currentDate = new Date();
    const resolvedYear = normalizedYear ? Number(normalizedYear) : currentDate.getFullYear();
    const maxDay = new Date(resolvedYear, selectedMonthIndex + 1, 0).getDate();
    const limitedMaxDay = normalizedYear === String(currentDate.getFullYear()) && selectedMonthIndex === currentDate.getMonth()
      ? Math.min(maxDay, currentDate.getDate())
      : maxDay;

    return Array.from({ length: limitedMaxDay }, (_, index) => index + 1);
  }

  private buildSelectedFilters(): SpotfireFilter[] {
    const filters: SpotfireFilter[] = [];

    for (const filter of this.secondaryFilters()) {
      if (!filter.value || !filter.enabled || !filter.sourceTitle || !filter.sourceKind) {
        continue;
      }

      const selectedValues = filter.value === ALL_OPTION
        ? filter.options.filter((option) => option !== ALL_OPTION)
        : [filter.value];

      if (selectedValues.length === 0) {
        continue;
      }

      filters.push({
        title: filter.sourceTitle,
        kind: filter.sourceKind,
        selectedValues,
      });
    }

    return filters;
  }

  private buildPeriodSelection(): PeriodSelectionPayload {
    const year = this.periodFilters().find((filter) => filter.key === 'ano')?.value ?? '';
    const month = this.periodFilters().find((filter) => filter.key === 'mes')?.value ?? '';
    return {
      year: year || undefined,
      month: month || undefined,
      dayRange: {
        min: this.dayRange().min,
        max: this.dayRange().max,
      },
    };
  }

  private resolveValue(value: string | undefined, options: string[], fallback: string): string {
    if (value === ALL_OPTION && options.includes(ALL_OPTION)) {
      return ALL_OPTION;
    }

    if (value && options.includes(value)) {
      return value;
    }

    if (fallback && options.includes(fallback)) {
      return fallback;
    }

    return '';
  }

  private withAllOption(options: string[]): string[] {
    return [...new Set([ALL_OPTION, ...options.filter((option) => option !== ALL_OPTION)])];
  }

  private describeHttpError(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
      const candidate = error as { message?: unknown; status?: unknown; statusText?: unknown; error?: unknown };

      if (typeof candidate.error === 'string' && candidate.error.trim().length > 0) {
        return candidate.error;
      }

      if (typeof candidate.message === 'string' && candidate.message.trim().length > 0) {
        return candidate.message;
      }

      if (typeof candidate.status === 'number') {
        const suffix = typeof candidate.statusText === 'string' && candidate.statusText.trim().length > 0 ? ` ${candidate.statusText}` : '';
        return `HTTP ${candidate.status}${suffix}`;
      }
    }

    return 'falha ao carregar o catálogo do backend';
  }
}
