import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';

import { ScannerApiService } from '../../core/api/scanner-api.service';
import { SpotfireCatalog, SpotfireFilter } from '../../models/spotfire-catalog.model';

type FilterKey = 'ano' | 'mes' | 'atuacaoHd' | 'tipoEquipe' | 'base';
type ReportTypeValue = 'completo';

type SelectFilterState = {
  key: FilterKey;
  title: string;
  value: string;
  options: string[];
};

type ReportTarget = {
  analysisTab: string;
  tableTitle: string;
};

type ReportTypeOption = {
  value: ReportTypeValue;
  label: string;
  targets: ReportTarget[];
};

const DEFAULT_REPORT_TITLE = 'Scanner 4.0 - CE';
const MONTH_OPTIONS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ATUACAO_HD_OPTIONS = ['All', 'Cadastrar', 'CORTE E RELIGAÇÃO', 'EMERGENCIA', 'LIGAÇÕES NOVAS', 'MANUTENÇÃO/OBRAS', 'PERDAS'];
const TIPO_EQUIPE_OPTIONS = ['CADASTRAR', 'CORTE E RELIGAÇÃO', 'EMERGENCIA', 'LIGAÇÕES NOVAS', 'MANUTENÇÃO/OBRAS', 'PERDAS'];
const BASE_OPTIONS = ['Cadastrar', 'ATLÂNTICO', 'CENTRO-NORTE', 'CENTRO-SUL', 'FORTALEZA', 'LESTE', 'METROPOLITANA', 'NORTE', 'SUL'];
const REPORT_TYPE_OPTIONS: ReportTypeOption[] = [
  {
    value: 'completo',
    label: 'Completo',
    targets: [
      {
        analysisTab: 'Tab Completa',
        tableTitle: 'Tabela Completa todas Colunas',
      },
      {
        analysisTab: 'Ranking',
        tableTitle: 'Detalhamento Diário',
      },
    ],
  },
];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  template: `
    <main class="shell">
      <div class="loading-popup-backdrop" *ngIf="catalogLoading() && !catalogReady()">
        <section class="loading-popup" aria-live="polite" aria-busy="true">
          <div class="loading-spinner"></div>
          <h2>Carregando filtros</h2>
        </section>
      </div>

      <ng-container *ngIf="!catalogLoading() || catalogReady()">
        <button
          type="button"
          class="filter-fab"
          [class.filter-fab-active]="filterDrawerOpen()"
          [class.filter-fab-expanded]="filterDrawerOpen()"
          [disabled]="loading()"
          (click)="handlePrimaryAction()"
          [attr.aria-label]="filterDrawerOpen() ? 'Aplicar filtros' : 'Abrir filtros'">
          <ng-container *ngIf="!filterDrawerOpen(); else filterLabel">
            <span class="filter-fab-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path>
              </svg>
            </span>
          </ng-container>

          <ng-template #filterLabel>
            <span class="filter-fab-label">{{ loading() ? 'Filtrando...' : 'Filtrar' }}</span>
          </ng-template>
        </button>

        <div class="drawer-backdrop" *ngIf="filterDrawerOpen()" (click)="closeFilterDrawer()"></div>

        <aside class="filter-drawer" [class.filter-drawer-open]="filterDrawerOpen()">
          <div class="drawer-head">
            <h2>Filtros</h2>
          </div>

          <div class="drawer-body">
            <article class="drawer-card">
              <div class="drawer-card-head">
                <h3>Tipo de Relatório</h3>
              </div>

              <label class="select-shell">
                <span class="select-caption">Valor ativo</span>
                <select [value]="reportType()" (change)="updateReportType($event)">
                  <option *ngFor="let option of reportTypeOptions" [value]="option.value">{{ option.label }}</option>
                </select>
              </label>
            </article>

            <article class="drawer-card" *ngFor="let filter of selectFilters()">
              <div class="drawer-card-head">
                <h3>{{ filter.title }}</h3>
              </div>

              <label class="select-shell">
                <span class="select-caption">Valor ativo</span>
                <select [value]="filter.value" (change)="updateSelectFilter(filter.key, $event)">
                  <option value="">Selecione</option>
                  <option *ngFor="let option of filter.options" [value]="option">{{ option }}</option>
                </select>
              </label>
            </article>

            <article class="drawer-card drawer-card-range">
              <div class="drawer-card-head">
                <h3>Dia</h3>
              </div>

              <div class="day-range-shell">
                <div class="range-summary-shell">
                  <span class="select-caption">Valor ativo</span>
                  <div class="day-range-display">
                    <div>
                      <strong>{{ dayRange().min }}</strong>
                    </div>

                    <div>
                      <strong>{{ dayRange().max }}</strong>
                    </div>
                  </div>
                </div>

                <div class="dual-slider">
                  <label class="slider-label">
                    <input type="range" min="1" [max]="dayLimit()" step="1" [value]="dayRange().min" (input)="updateDayRange('min', $event)" aria-label="Dia inicial" />
                  </label>

                  <label class="slider-label">
                    <input type="range" min="1" [max]="dayLimit()" step="1" [value]="dayRange().max" (input)="updateDayRange('max', $event)" aria-label="Dia final" />
                  </label>
                </div>
              </div>
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
        min-height: 100vh;
        position: relative;
        overflow: hidden;
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
        background: radial-gradient(circle, rgba(232, 105, 61, 0.16), transparent 70%);
      }

      .shell::after {
        width: 320px;
        height: 320px;
        left: -120px;
        bottom: -60px;
        background: radial-gradient(circle, rgba(30, 123, 122, 0.14), transparent 72%);
      }

      .workspace-stage {
        min-height: 100vh;
      }

      .loading-popup-backdrop,
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(28, 21, 17, 0.28);
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
        box-shadow: 0 24px 60px rgba(34, 24, 18, 0.16);
      }

      .loading-spinner {
        width: 48px;
        height: 48px;
        margin: 0 auto 14px;
        border-radius: 50%;
        border: 4px solid rgba(232, 105, 61, 0.14);
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
        background: linear-gradient(145deg, rgba(255, 252, 247, 0.96), rgba(247, 239, 230, 0.92));
        border: 1px solid rgba(23, 26, 31, 0.08);
        box-shadow: 0 14px 30px rgba(34, 24, 18, 0.16);
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

      .filter-fab-active {
        background: linear-gradient(135deg, var(--accent) 0%, #ef7a45 100%);
        color: white;
      }

      .filter-fab-expanded {
        width: auto;
        min-width: 116px;
        padding: 0 18px;
        border-radius: 999px;
      }

      .filter-fab-icon svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }

      .filter-fab-label {
        font-size: 0.84rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .filter-drawer {
        position: fixed;
        top: 0;
        right: 0;
        z-index: 1101;
        width: min(380px, calc(100vw - 20px));
        height: 100vh;
        padding: 22px 18px 18px;
        background:
          linear-gradient(180deg, rgba(255, 250, 245, 0.98), rgba(244, 238, 229, 0.96)),
          radial-gradient(circle at top right, rgba(232, 105, 61, 0.12), transparent 38%);
        border-left: 1px solid rgba(23, 26, 31, 0.08);
        box-shadow: -24px 0 60px rgba(34, 24, 18, 0.18);
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
        margin-bottom: 10px;
      }

      .drawer-body {
        display: grid;
        gap: 8px;
      }

      .drawer-card {
        padding: 14px;
        border-radius: 18px;
        border: 1px solid rgba(23, 26, 31, 0.08);
        background: rgba(255, 255, 255, 0.66);
        display: grid;
        gap: 6px;
      }

      .drawer-card-range {
        background: rgba(255, 255, 255, 0.66);
      }

      .select-shell,
      .slider-label {
        display: grid;
        gap: 4px;
      }

      .select-caption {
        margin: 0 0 3px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 0.64rem;
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

      select,
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

      .day-range-shell {
        padding: 8px;
        border-radius: 14px;
        background: var(--surface-strong);
        border: 1px solid rgba(23, 26, 31, 0.08);
        display: grid;
        gap: 6px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
      }

      .range-summary-shell {
        display: grid;
        gap: 4px;
      }

      .day-range-display {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 5px;
      }

      .day-range-display > div,
      .slider-label {
        padding: 8px 10px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.66);
        border: 1px solid rgba(23, 26, 31, 0.08);
      }

      .day-range-display strong {
        font-size: 0.98rem;
      }

      .dual-slider {
        display: grid;
        gap: 4px;
      }

      .slider-label input[type='range'] {
        width: 100%;
        padding: 0;
        border: 0;
        background: transparent;
        accent-color: var(--accent);
      }

      @media (max-width: 720px) {
        .filter-fab {
          top: 16px;
          right: 16px;
          width: 40px;
          height: 40px;
          border-radius: 12px;
        }

        .filter-fab-expanded {
          width: auto;
        }

        .day-range-display {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 560px) {
        .filter-drawer {
          width: calc(100vw - 8px);
          padding-left: 14px;
          padding-right: 14px;
        }
      }
    `,
  ],
})
export class DashboardComponent implements OnInit {
  protected readonly api = inject(ScannerApiService);

  protected readonly loading = signal(false);
  protected readonly catalogLoading = signal(true);
  protected readonly catalog = signal<SpotfireCatalog | null>(null);
  protected readonly catalogRequestError = signal<string | null>(null);
  protected readonly filterDrawerOpen = signal(false);
  protected readonly reportTitle = signal(DEFAULT_REPORT_TITLE);
  protected readonly reportType = signal<ReportTypeValue>('completo');
  protected readonly selectFilters = signal<SelectFilterState[]>([]);
  protected readonly dayRange = signal({ min: 1, max: new Date().getDate() });
  protected readonly dayLimit = computed(() => new Date().getDate());
  protected readonly selectedReportType = computed(() => this.reportTypeOptions.find((option) => option.value === this.reportType()) ?? this.reportTypeOptions[0]);

  protected readonly reportTypeOptions = REPORT_TYPE_OPTIONS;

  public ngOnInit(): void {
    this.loadCatalog();
  }

  protected handlePrimaryAction(): void {
    if (this.filterDrawerOpen()) {
      this.submit();
      return;
    }

    this.filterDrawerOpen.set(true);
  }

  protected closeFilterDrawer(): void {
    if (this.loading()) {
      return;
    }

    this.filterDrawerOpen.set(false);
  }

  protected updateReportType(event: Event): void {
    const value = (event.target as HTMLSelectElement | null)?.value as ReportTypeValue | '';
    if (!value) {
      return;
    }

    this.reportType.set(value);
  }

  protected updateSelectFilter(key: FilterKey, event: Event): void {
    const value = (event.target as HTMLSelectElement | null)?.value ?? '';
    this.selectFilters.update((filters) => filters.map((filter) => filter.key === key ? { ...filter, value } : filter));
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
    if (this.loading()) {
      return;
    }

    const targets = this.selectedReportType()?.targets ?? [];
    if (targets.length === 0) {
      return;
    }

    this.loading.set(true);
    const selectedFilters = this.buildSelectedFilters();

    forkJoin(targets.map((target) => this.api.startExecution({
      reportTitle: this.reportTitle(),
      analysisTab: target.analysisTab,
      tableTitle: target.tableTitle,
      selectedFilters,
    }))).subscribe({
      next: () => {
        this.loading.set(false);
        this.filterDrawerOpen.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  private loadCatalog(): void {
    this.catalogLoading.set(true);
    this.catalogRequestError.set(null);

    this.api.getCatalog()
      .subscribe({
        next: (catalog) => {
          this.catalog.set(catalog);
          this.selectFilters.set(this.buildSelectFilters(catalog.filters));
          this.dayRange.set(this.buildDayRange(catalog.filters));
          this.reportTitle.set(catalog.reportTitle || DEFAULT_REPORT_TITLE);
          this.catalogLoading.set(catalog.status === 'loading');
        },
        error: (error) => {
          this.catalogLoading.set(false);
          this.catalogRequestError.set(this.describeHttpError(error));
          this.selectFilters.set(this.buildSelectFilters([]));
          this.dayRange.set({ min: 1, max: this.dayLimit() });
        },
      });
  }

  private buildSelectFilters(rawFilters: SpotfireFilter[]): SelectFilterState[] {
    const currentYear = String(new Date().getFullYear());
    const currentMonth = MONTH_OPTIONS[new Date().getMonth()];
    const previous = new Map(this.selectFilters().map((filter) => [filter.key, filter.value]));

    return [
      {
        key: 'ano',
        title: 'Ano',
        options: this.yearOptionsFromCatalog(rawFilters),
        value: previous.get('ano') ?? currentYear,
      },
      {
        key: 'mes',
        title: 'Mês',
        options: MONTH_OPTIONS.slice(0, new Date().getMonth() + 1),
        value: previous.get('mes') ?? currentMonth,
      },
      {
        key: 'atuacaoHd',
        title: 'AtuaçãoHD',
        options: ATUACAO_HD_OPTIONS,
        value: previous.get('atuacaoHd') ?? 'All',
      },
      {
        key: 'tipoEquipe',
        title: 'Tipo Equipe',
        options: TIPO_EQUIPE_OPTIONS,
        value: previous.get('tipoEquipe') ?? '',
      },
      {
        key: 'base',
        title: 'Base',
        options: BASE_OPTIONS,
        value: previous.get('base') ?? '',
      },
    ];
  }

  private buildDayRange(rawFilters: SpotfireFilter[]): { min: number; max: number } {
    const previous = this.dayRange();
    const rawDayFilter = rawFilters.find((filter) => filter.title.toLowerCase() === 'dia');
    const catalogMax = Number(rawDayFilter?.range?.max ?? this.dayLimit());
    const limit = Number.isFinite(catalogMax) && catalogMax > 0 ? catalogMax : this.dayLimit();

    return {
      min: Math.min(previous.min, limit),
      max: Math.min(Math.max(previous.max, previous.min), limit),
    };
  }

  private yearOptionsFromCatalog(rawFilters: SpotfireFilter[]): string[] {
    const yearFilter = rawFilters.find((filter) => filter.title.toLowerCase() === 'ano');
    const options = yearFilter?.options?.map((option) => option.label).filter((label) => /^\d{4}$/.test(label)) ?? [];

    if (options.length > 0) {
      return [...new Set(options)].sort((left, right) => Number(right) - Number(left));
    }

    const currentYear = new Date().getFullYear();
    return [String(currentYear), String(currentYear - 1)];
  }

  private buildSelectedFilters(): SpotfireFilter[] {
    const filters: SpotfireFilter[] = [];

    for (const filter of this.selectFilters()) {
      if (!filter.value) {
        continue;
      }

      filters.push({
        title: filter.title,
        kind: 'list',
        selectedValues: [filter.value],
      });
    }

    filters.push({
      title: 'Dia',
      kind: 'range',
      selectedValues: [],
      range: {
        min: '1',
        max: String(this.dayLimit()),
        selectedMin: String(this.dayRange().min),
        selectedMax: String(this.dayRange().max),
      },
    });

    return filters;
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