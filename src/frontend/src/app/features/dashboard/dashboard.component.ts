import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { distinctUntilChanged, interval, startWith, switchMap, takeWhile } from 'rxjs';

import { ScannerApiService, ScannerJob } from '../../core/api/scanner-api.service';
import { SpotfireCatalog, SpotfireFilter } from '../../models/spotfire-catalog.model';

type FilterKey = 'ano' | 'mes' | 'atuacaoHd' | 'tipoEquipe' | 'base';

type SelectFilterState = {
  key: FilterKey;
  title: string;
  subtitle: string;
  value: string;
  options: string[];
};

const MONTH_OPTIONS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ATUACAO_HD_OPTIONS = ['All', 'Cadastrar', 'CORTE E RELIGAÇÃO', 'EMERGENCIA', 'LIGAÇÕES NOVAS', 'MANUTENÇÃO/OBRAS', 'PERDAS'];
const TIPO_EQUIPE_OPTIONS = ['CADASTRAR', 'CORTE E RELIGAÇÃO', 'EMERGENCIA', 'LIGAÇÕES NOVAS', 'MANUTENÇÃO/OBRAS', 'PERDAS'];
const BASE_OPTIONS = ['Cadastrar', 'ATLÂNTICO', 'CENTRO-NORTE', 'CENTRO-SUL', 'FORTALEZA', 'LESTE', 'METROPOLITANA', 'NORTE', 'SUL'];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <main class="shell">
      <div class="loading-popup-backdrop" *ngIf="catalogLoading() && !catalogReady()">
        <section class="loading-popup" aria-live="polite" aria-busy="true">
          <div class="loading-spinner"></div>
          <h2>Carregando Scanner</h2>
          <p class="summary">A interface só é liberada depois que a página do Scanner termina de carregar abas, filtros e tabelas.</p>
        </section>
      </div>

      <ng-container *ngIf="!catalogLoading() || catalogReady()">
        <button
          type="button"
          class="filter-fab"
          [class.filter-fab-active]="filterDrawerOpen()"
          (click)="toggleFilterDrawer()"
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
            <div>
              <p class="panel-kicker">Filtros</p>
              <h2>Barra lateral</h2>
            </div>
          </div>

          <div class="drawer-body">
            <article class="drawer-card" *ngFor="let filter of selectFilters()">
              <div class="drawer-card-head">
                <div>
                  <h3>{{ filter.title }}</h3>
                </div>
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
                <div>
                  <h3>Dia</h3>
                </div>
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

        <section class="hero">
          <div class="hero-copy">
            <p class="eyebrow">Scanner 4.0 - CE</p>
            <h1>Visual mais limpo, filtros mais claros e painel lateral dedicado</h1>
            <p class="summary">
              A tela principal ficou mais limpa e o controle dos filtros saiu para uma barra lateral direita.
              Os filtros de catálogo agora usam selects mais elegantes e o dia continua com faixa ajustável.
            </p>

            <div class="hero-ribbon">
              <span class="hero-pill">{{ changedFiltersCount() }} filtros configurados</span>
              <span class="hero-pill">{{ catalog()?.availableTabs?.length ?? 0 }} abas lidas</span>
              <span class="hero-pill">drawer lateral ativo</span>
            </div>
          </div>

          <aside class="hero-panel panel">
            <div class="hero-panel-head">
              <div>
                <p class="panel-kicker">Cenário</p>
                <h2>Resumo atual</h2>
              </div>
              <span [class]="'tag ' + (catalog()?.status ?? 'queued')">{{ catalog()?.status ?? 'loading' }}</span>
            </div>

            <div class="hero-metric-grid">
              <article class="hero-metric-card">
                <span class="metric-label">Aba</span>
                <strong>{{ selectedTabLabel() }}</strong>
              </article>

              <article class="hero-metric-card">
                <span class="metric-label">Tabela</span>
                <strong>{{ selectedTableLabel() }}</strong>
              </article>

              <article class="hero-metric-card">
                <span class="metric-label">Ano/Mês</span>
                <strong>{{ activeValue('ano') || '---' }} / {{ activeValue('mes') || '---' }}</strong>
              </article>

              <article class="hero-metric-card">
                <span class="metric-label">Dia</span>
                <strong>{{ dayRange().min }} - {{ dayRange().max }}</strong>
              </article>
            </div>
          </aside>
        </section>

        <section class="grid top-grid">
          <article class="panel form-panel">
            <div class="section-head">
              <div>
                <p class="panel-kicker">Fluxo de extração</p>
                <h2>Parâmetros principais</h2>
              </div>

              <button type="button" class="ghost-button" (click)="refreshCatalog()" [disabled]="catalogLoading() || loading()">
                Recarregar catálogo
              </button>
            </div>

            <form [formGroup]="form" (ngSubmit)="submit()">
              <label>
                Relatório
                <input formControlName="reportTitle" placeholder="Scanner 4.0 - CE" />
              </label>

              <label>
                Aba
                <select formControlName="analysisTab">
                  <option value="">Usar a aba ativa do Spotfire</option>
                  <option *ngFor="let tab of catalog()?.availableTabs ?? []" [value]="tab">{{ tab }}</option>
                </select>
              </label>

              <label>
                Tabela para exportar
                <select formControlName="tableTitle">
                  <option value="">Escolher depois</option>
                  <option *ngFor="let table of catalog()?.availableTables ?? []" [value]="table">{{ table }}</option>
                </select>
              </label>

              <p class="hint">
                Os filtros são ajustados pelo botão lateral de filtros. Quando terminar, execute a extração.
              </p>

              <button type="submit" [disabled]="form.invalid || loading() || catalogLoading() || catalog()?.status !== 'ready'">
                {{ loading() ? 'Enviando extração...' : 'Iniciar extração dos dados' }}
              </button>
            </form>
          </article>

          <article class="panel status-panel">
            <div class="section-head compact-head">
              <div>
                <p class="panel-kicker">Seleção atual</p>
                <h2>Resumo dos filtros</h2>
              </div>
            </div>

            <div class="selection-summary">
              <article class="selection-line" *ngFor="let filter of selectFilters()">
                <span>{{ filter.title }}</span>
                <strong>{{ filter.value || 'sem seleção' }}</strong>
              </article>

              <article class="selection-line">
                <span>Dia</span>
                <strong>{{ dayRange().min }} - {{ dayRange().max }}</strong>
              </article>
            </div>

            <div class="status-stack">
              <p><strong>Status:</strong> <span [class]="'tag ' + (catalog()?.status ?? 'queued')">{{ catalog()?.status ?? 'loading' }}</span></p>
              <p><strong>Relatório:</strong> {{ catalog()?.reportTitle || form.controls.reportTitle.value }}</p>
              <p><strong>Aba selecionada:</strong> {{ selectedTabLabel() }}</p>
              <p><strong>Tabela selecionada:</strong> {{ selectedTableLabel() }}</p>
              <p *ngIf="catalog()?.updatedAt"><strong>Atualizado em:</strong> {{ catalog()?.updatedAt }}</p>
              <p *ngIf="catalog()?.errorMessage" class="error"><strong>Erro do catálogo:</strong> {{ catalog()?.errorMessage }}</p>
              <p *ngIf="catalogRequestError()" class="error"><strong>Erro ao consultar API:</strong> {{ catalogRequestError() }}</p>
            </div>

            <ng-container *ngIf="job() as currentJob; else emptyState">
              <hr />
              <h3>Última extração</h3>
              <p><strong>Job:</strong> {{ currentJob.id }}</p>
              <p><strong>Status:</strong> <span [class]="'tag ' + currentJob.status">{{ currentJob.status }}</span></p>
              <p><strong>Filtros enviados:</strong> {{ currentJob.request.selectedFilters?.length ?? 0 }}</p>
              <p *ngIf="currentJob.exportFilePath">
                <strong>Saída:</strong>
                <a class="download-link" [href]="api.getExportDownloadUrl(currentJob.id)">Baixar export</a>
                <span class="path">{{ currentJob.exportFilePath }}</span>
              </p>
              <p *ngIf="currentJob.errorMessage" class="error"><strong>Erro:</strong> {{ currentJob.errorMessage }}</p>
            </ng-container>

            <ng-template #emptyState>
              <p>Nenhuma extração iniciada ainda.</p>
            </ng-template>
          </article>
        </section>
      </ng-container>
    </main>
  `,
  styles: [
    `
      .shell {
        max-width: 1220px;
        margin: 0 auto;
        padding: 40px 20px 72px;
        position: relative;
      }

      .shell::before,
      .shell::after {
        content: '';
        position: absolute;
        border-radius: 999px;
        pointer-events: none;
        filter: blur(22px);
      }

      .shell::before {
        width: 320px;
        height: 320px;
        top: 0;
        right: -120px;
        background: radial-gradient(circle, rgba(232, 105, 61, 0.2), transparent 70%);
      }

      .shell::after {
        width: 260px;
        height: 260px;
        left: -100px;
        top: 520px;
        background: radial-gradient(circle, rgba(30, 123, 122, 0.16), transparent 72%);
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
        width: min(440px, 100%);
        text-align: center;
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 28px;
        padding: 28px 24px;
        box-shadow: 0 24px 60px rgba(34, 24, 18, 0.16);
      }

      .loading-spinner {
        width: 52px;
        height: 52px;
        margin: 0 auto 16px;
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
        border-radius: 14px;
        padding: 0;
        display: grid;
        place-items: center;
        background: linear-gradient(145deg, rgba(255, 252, 247, 0.96), rgba(247, 239, 230, 0.92));
        border: 1px solid rgba(23, 26, 31, 0.08);
        box-shadow: 0 14px 30px rgba(34, 24, 18, 0.16);
      }

      .filter-fab-active {
        background: linear-gradient(145deg, rgba(232, 105, 61, 0.16), rgba(30, 123, 122, 0.14));
      }

      .filter-fab-icon svg {
        width: 16px;
        height: 16px;
        fill: var(--accent-strong);
      }

      .filter-drawer {
        position: fixed;
        top: 0;
        right: 0;
        z-index: 1101;
        width: min(380px, calc(100vw - 20px));
        height: 100vh;
        padding: 20px 18px 18px;
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

      .drawer-head,
      .hero-panel-head,
      .section-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 14px;
      }

      .drawer-summary,
      .summary,
      .hint,
      .drawer-card-copy,
      .path {
        margin: 0;
        color: var(--muted);
        line-height: 1.34;
        font-size: 0.92rem;
      }

      .drawer-body {
        display: grid;
        gap: 8px;
        margin-top: 10px;
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

      .drawer-card-kicker,
      .eyebrow,
      .panel-kicker,
      .metric-label,
      .select-caption {
        margin: 0 0 3px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 0.64rem;
        color: var(--muted-strong);
      }

      .select-shell {
        display: grid;
        gap: 4px;
      }

      .range-badge,
      .hero-pill,
      .tag {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        padding: 0 10px;
        border-radius: 999px;
        border: 1px solid rgba(23, 26, 31, 0.1);
        background: rgba(255, 255, 255, 0.72);
        font-size: 0.72rem;
        font-weight: 700;
      }

      .hero {
        margin-bottom: 28px;
        display: grid;
        grid-template-columns: minmax(0, 1.18fr) minmax(320px, 0.82fr);
        gap: 18px;
      }

      .hero-ribbon {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 18px;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.3rem, 5vw, 4.1rem);
        line-height: 0.94;
        letter-spacing: -0.05em;
        max-width: 11ch;
      }

      h2 {
        margin: 0;
        font-size: 1.18rem;
        line-height: 1.06;
      }

      h3 {
        margin: 0;
        font-size: 0.98rem;
        line-height: 1.08;
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1.08fr) minmax(320px, 0.92fr);
        gap: 18px;
      }

      .panel {
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 30px;
        padding: 24px;
        backdrop-filter: blur(14px);
        box-shadow: 0 26px 70px rgba(34, 24, 18, 0.1);
      }

      .hero-panel {
        background:
          linear-gradient(180deg, rgba(255, 250, 245, 0.96), rgba(246, 241, 233, 0.92)),
          radial-gradient(circle at top right, rgba(232, 105, 61, 0.12), transparent 38%);
      }

      .hero-metric-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-top: 14px;
      }

      .hero-metric-card {
        display: grid;
        gap: 5px;
        padding: 12px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.68);
        border: 1px solid rgba(23, 26, 31, 0.08);
      }

      form,
      label,
      .slider-label {
        display: grid;
        gap: 4px;
      }

      input,
      select {
        width: 100%;
        border-radius: 12px;
        border: 1px solid rgba(23, 26, 31, 0.12);
        padding: 10px 12px;
        background: var(--surface-strong);
        color: var(--text);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
        font-size: 0.92rem;
      }

      button {
        border: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--accent) 0%, #ef7a45 100%);
        color: white;
        padding: 14px 18px;
        font-weight: 700;
        cursor: pointer;
        transition: transform 0.18s ease, opacity 0.18s ease;
      }

      button:hover { transform: translateY(-1px); }
      button:disabled { opacity: 0.62; cursor: not-allowed; transform: none; }

      .ghost-button {
        background: transparent;
        color: var(--accent-strong);
        border: 1px solid rgba(23, 26, 31, 0.12);
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

      .day-range-display > div {
        padding: 8px 10px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.66);
        border: 1px solid rgba(23, 26, 31, 0.08);
        display: grid;
        gap: 2px;
      }

      .day-range-display strong { font-size: 0.98rem; }

      .dual-slider { display: grid; gap: 4px; }

      .slider-label {
        padding: 8px 10px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.66);
        border: 1px solid rgba(23, 26, 31, 0.08);
        gap: 3px;
      }

      .slider-label input[type='range'] {
        width: 100%;
        padding: 0;
        border: 0;
        background: transparent;
        accent-color: var(--accent);
      }

      .selection-summary {
        display: grid;
        gap: 8px;
        margin-bottom: 14px;
      }

      .selection-line {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: flex-start;
      }

      .status-stack p,
      .path,
      .error { line-height: 1.36; }
      .status-stack p { margin: 0 0 6px; }
      .error { color: var(--error); }

      .download-link {
        color: var(--accent-strong);
        font-weight: 700;
        text-decoration: none;
        margin-right: 8px;
      }

      .download-link:hover { text-decoration: underline; }

      hr {
        border: 0;
        border-top: 1px solid var(--line);
        margin: 18px 0;
      }

      .tag {
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .queued,
      .running { background: rgba(157, 100, 0, 0.12); color: var(--warn); }
      .completed { background: rgba(45, 117, 82, 0.12); color: var(--ok); }
      .failed { background: rgba(161, 52, 41, 0.12); color: var(--error); }
      .loading { background: rgba(30, 123, 122, 0.12); color: #1e7b7a; }

      @media (max-width: 1080px) {
        .hero,
        .grid { grid-template-columns: 1fr; }
      }

      @media (max-width: 720px) {
        .filter-fab {
          top: 16px;
          right: 16px;
          width: 40px;
          height: 40px;
          border-radius: 12px;
        }

        .hero-metric-grid,
        .day-range-display { grid-template-columns: 1fr; }
      }

      @media (max-width: 560px) {
        .selection-line,
        .section-head,
        .drawer-head,
        .hero-panel-head { flex-direction: column; }

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
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(false);
  protected readonly catalogLoading = signal(true);
  protected readonly catalog = signal<SpotfireCatalog | null>(null);
  protected readonly catalogRequestError = signal<string | null>(null);
  protected readonly rawCatalogFilters = signal<SpotfireFilter[]>([]);
  protected readonly filterDrawerOpen = signal(false);
  protected readonly selectFilters = signal<SelectFilterState[]>([]);
  protected readonly dayRange = signal({ min: 1, max: new Date().getDate() });
  protected readonly job = signal<ScannerJob | null>(null);

  protected readonly form: FormGroup<{
    analysisTab: FormControl<string>;
    reportTitle: FormControl<string>;
    tableTitle: FormControl<string>;
  }> = new FormGroup({
    analysisTab: new FormControl('', { nonNullable: true }),
    reportTitle: new FormControl('Scanner 4.0 - CE', { nonNullable: true, validators: [Validators.required] }),
    tableTitle: new FormControl('', { nonNullable: true }),
  });

  protected readonly dayLimit = computed(() => new Date().getDate());

  public ngOnInit(): void {
    this.form.controls.analysisTab.valueChanges
      .pipe(distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe((analysisTab) => {
        this.form.controls.tableTitle.setValue('', { emitEvent: false });
        this.loadCatalog(analysisTab || undefined);
      });

    this.loadCatalog();
  }

  protected toggleFilterDrawer(): void {
    this.filterDrawerOpen.update((open) => !open);
  }

  protected closeFilterDrawer(): void {
    this.filterDrawerOpen.set(false);
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

  protected selectedTabLabel(): string {
    return this.form.controls.analysisTab.value || 'Aba ativa do Spotfire';
  }

  protected selectedTableLabel(): string {
    return this.form.controls.tableTitle.value || 'Nenhuma tabela escolhida';
  }

  protected activeValue(key: FilterKey): string {
    return this.selectFilters().find((filter) => filter.key === key)?.value ?? '';
  }

  protected changedFiltersCount(): number {
    return this.buildSelectedFilters().length;
  }

  protected refreshCatalog(): void {
    this.loadCatalog(this.form.controls.analysisTab.value || undefined);
  }

  protected catalogReady(): boolean {
    return this.catalog()?.status === 'ready';
  }

  protected submit(): void {
    if (this.form.invalid) {
      return;
    }

    this.loading.set(true);
    const rawValue = this.form.getRawValue();

    this.api.startExecution({
      reportTitle: rawValue.reportTitle,
      analysisTab: rawValue.analysisTab || undefined,
      tableTitle: rawValue.tableTitle || undefined,
      selectedFilters: this.buildSelectedFilters(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          this.job.set(job);
          this.loading.set(false);
          this.pollJob(job.id);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

  private pollJob(jobId: string): void {
    interval(2000)
      .pipe(
        startWith(0),
        switchMap(() => this.api.getExecution(jobId)),
        takeWhile((job) => job.status === 'queued' || job.status === 'running', true),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((job) => {
        this.job.set(job);
      });
  }

  private loadCatalog(analysisTab?: string): void {
    this.catalogLoading.set(true);
    this.catalogRequestError.set(null);

    const currentReportTitle = this.form.controls.reportTitle.value.trim();

    this.api.getCatalog({
      analysisTab,
      reportTitle: currentReportTitle.length > 0 && currentReportTitle !== 'Scanner 4.0 - CE' ? currentReportTitle : undefined,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (catalog) => {
          this.catalog.set(catalog);
          this.rawCatalogFilters.set(catalog.filters);
          this.selectFilters.set(this.buildSelectFilters(catalog.filters));
          this.dayRange.set(this.buildDayRange(catalog.filters));
          this.catalogLoading.set(catalog.status === 'loading');

          if (!this.form.controls.reportTitle.value || this.form.controls.reportTitle.value === 'Scanner 4.0 - CE') {
            this.form.controls.reportTitle.setValue(catalog.reportTitle, { emitEvent: false });
          }

          if (!catalog.availableTabs.includes(this.form.controls.analysisTab.value)) {
            this.form.controls.analysisTab.setValue('', { emitEvent: false });
          }

          if (!catalog.availableTables.includes(this.form.controls.tableTitle.value)) {
            this.form.controls.tableTitle.setValue('', { emitEvent: false });
          }
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
        subtitle: 'Recorte anual da análise.',
        options: this.yearOptionsFromCatalog(rawFilters),
        value: previous.get('ano') ?? currentYear,
      },
      {
        key: 'mes',
        title: 'Mês',
        subtitle: 'Leitura mensal até o mês atual.',
        options: MONTH_OPTIONS.slice(0, new Date().getMonth() + 1),
        value: previous.get('mes') ?? currentMonth,
      },
      {
        key: 'atuacaoHd',
        title: 'AtuaçãoHD',
        subtitle: 'Catálogo principal de atuação.',
        options: ATUACAO_HD_OPTIONS,
        value: previous.get('atuacaoHd') ?? 'All',
      },
      {
        key: 'tipoEquipe',
        title: 'Tipo Equipe',
        subtitle: 'Tipologia operacional da equipe.',
        options: TIPO_EQUIPE_OPTIONS,
        value: previous.get('tipoEquipe') ?? '',
      },
      {
        key: 'base',
        title: 'Base',
        subtitle: 'Base e cobertura regional.',
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