import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { interval, startWith, switchMap, takeWhile } from 'rxjs';

import { ScannerApiService, ScannerJob } from '../../core/api/scanner-api.service';
import { SpotfireCatalog, SpotfireFilter } from '../../models/spotfire-catalog.model';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <main class="shell">
      <section class="hero">
        <p class="eyebrow">Scanner 4.0 - CE</p>
        <h1>Escolha a aba, ajuste os filtros e só depois extraia</h1>
        <p class="summary">
          O fluxo agora começa com o catálogo inicial do Spotfire. A tela mostra a lista de abas em dropdown,
          carrega todos os filtros detectados e só envia a execução quando o usuário terminar os ajustes.
        </p>
      </section>

      <section class="grid top-grid">
        <article class="panel form-panel">
          <div class="section-head">
            <h2>Parâmetros da extração</h2>
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
              Primeiro escolha a aba e ajuste os filtros abaixo. O botão só dispara a automação quando você terminar.
            </p>

            <button type="submit" [disabled]="form.invalid || loading() || catalogLoading() || catalog()?.status !== 'ready'">
              {{ loading() ? 'Enviando extração...' : 'Iniciar extração dos dados' }}
            </button>
          </form>
        </article>

        <article class="panel status-panel">
          <h2>Resumo do catálogo</h2>
          <div class="status-stack">
            <p><strong>Status:</strong> <span [class]="'tag ' + (catalog()?.status ?? 'queued')">{{ catalog()?.status ?? 'loading' }}</span></p>
            <p><strong>Relatório:</strong> {{ catalog()?.reportTitle || form.controls.reportTitle.value }}</p>
            <p><strong>Total de abas:</strong> {{ catalog()?.availableTabs?.length ?? 0 }}</p>
            <p><strong>Total de tabelas:</strong> {{ catalog()?.availableTables?.length ?? 0 }}</p>
            <p><strong>Total de filtros:</strong> {{ editableFilters().length }}</p>
            <p><strong>Filtros alterados:</strong> {{ changedFiltersCount() }}</p>
            <p><strong>Aba selecionada:</strong> {{ selectedTabLabel() }}</p>
            <p><strong>Tabela selecionada:</strong> {{ selectedTableLabel() }}</p>
            <p *ngIf="catalog()?.updatedAt"><strong>Atualizado em:</strong> {{ catalog()?.updatedAt }}</p>
            <p *ngIf="catalog()?.errorMessage" class="error"><strong>Erro do catálogo:</strong> {{ catalog()?.errorMessage }}</p>
            <p *ngIf="catalogRequestError()" class="error"><strong>Erro ao consultar API:</strong> {{ catalogRequestError() }}</p>
            <p *ngIf="catalogLoading()">Carregando abas, tabelas e filtros do backend.</p>
          </div>

          <div class="preview-stack" *ngIf="catalog() as currentCatalog">
            <p><strong>Abas recebidas:</strong> {{ previewValues(currentCatalog.availableTabs) }}</p>
            <p><strong>Tabelas recebidas:</strong> {{ previewValues(currentCatalog.availableTables) }}</p>
            <p><strong>Filtros detectados:</strong> {{ previewFilterTitles(editableFilters()) }}</p>
          </div>

          <ng-container *ngIf="job() as currentJob; else emptyState">
            <hr />
            <h3>Última extração</h3>
            <p><strong>Job:</strong> {{ currentJob.id }}</p>
            <p><strong>Status:</strong> <span [class]="'tag ' + currentJob.status">{{ currentJob.status }}</span></p>
            <p><strong>Aba:</strong> {{ currentJob.request.analysisTab || 'Aba ativa do Spotfire' }}</p>
            <p><strong>Tabela:</strong> {{ currentJob.request.tableTitle || 'Nenhuma selecionada' }}</p>
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

      <section class="panel filter-panel">
        <div class="section-head">
          <h2>Filtros para aplicar antes da extração</h2>
          <span>{{ editableFilters().length }} itens</span>
        </div>

        <div class="filter-list" *ngIf="editableFilters().length; else noFilters">
          <article class="filter-card" *ngFor="let filter of editableFilters()">
            <div class="filter-header">
              <strong>{{ filter.title }}</strong>
              <span class="filter-kind">{{ filter.kind }}</span>
            </div>

            <p class="filter-meta">{{ describeFilter(filter) }}</p>

            <div class="editor-block" *ngIf="filter.kind === 'list' || filter.kind === 'toggle-group'">
              <label class="editor-label">
                Valores para aplicar
                <select
                  multiple
                  class="multi-select"
                  (change)="updateSelectedOptions(filter.title, selectElementValues($event))">
                  <option
                    *ngFor="let option of filter.options ?? []"
                    [value]="option.label"
                    [selected]="isValueSelected(filter, option.label)">
                    {{ option.label }}
                  </option>
                </select>
              </label>

              <div class="action-row">
                <button type="button" class="mini-button" (click)="selectAllFilterValues(filter.title)">Selecionar (All)</button>
                <button type="button" class="mini-button" (click)="restoreFilterDefaults(filter.title)">Restaurar padrão</button>
                <button type="button" class="mini-button" (click)="clearFilterSelection(filter.title)">Limpar</button>
              </div>
            </div>

            <div class="range-editor" *ngIf="filter.kind === 'range' && filter.range">
              <label class="editor-label">
                Valor inicial
                <input
                  [value]="filter.range.selectedMin"
                  (input)="updateRangeFilter(filter.title, 'min', inputValue($event))"
                  placeholder="Valor inicial" />
              </label>

              <label class="editor-label">
                Valor final
                <input
                  [value]="filter.range.selectedMax"
                  (input)="updateRangeFilter(filter.title, 'max', inputValue($event))"
                  placeholder="Valor final" />
              </label>
            </div>

            <p class="selected-values" *ngIf="showCurrentSelection(filter)">
              {{ currentSelectionLabel(filter) }}
            </p>
          </article>
        </div>

        <ng-template #noFilters>
          <p>Os filtros aparecerão aqui assim que o backend concluir a carga inicial do Spotfire.</p>
        </ng-template>
      </section>
    </main>
  `,
  styles: [
    `
      .shell {
        max-width: 1180px;
        margin: 0 auto;
        padding: 48px 20px 64px;
      }

      .hero {
        margin-bottom: 28px;
      }

      .eyebrow {
        margin: 0 0 10px;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 0.78rem;
        color: var(--accent-strong);
      }

      h1 {
        margin: 0;
        font-size: clamp(2.1rem, 5vw, 4rem);
        line-height: 0.96;
        max-width: 12ch;
      }

      .summary {
        max-width: 64ch;
        color: var(--muted);
        line-height: 1.6;
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
        gap: 18px;
        margin-bottom: 18px;
      }

      .panel {
        border: 1px solid var(--line);
        background: var(--surface);
        backdrop-filter: blur(14px);
        border-radius: 24px;
        padding: 22px;
        box-shadow: 0 22px 50px rgba(67, 42, 22, 0.08);
      }

      h2 {
        margin-top: 0;
        margin-bottom: 16px;
      }

      form {
        display: grid;
        gap: 14px;
      }

      label,
      .editor-label {
        display: grid;
        gap: 8px;
        font-weight: 600;
      }

      input,
      select {
        width: 100%;
        border-radius: 14px;
        border: 1px solid rgba(31, 27, 22, 0.16);
        padding: 13px 14px;
        background: var(--surface-strong);
      }

      button {
        border: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--accent) 0%, #cc6a36 100%);
        color: white;
        padding: 14px 18px;
        font-weight: 700;
        cursor: pointer;
      }

      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .ghost-button,
      .mini-button,
      .option-button {
        background: transparent;
        color: var(--accent-strong);
        border: 1px solid rgba(31, 27, 22, 0.14);
      }

      .mini-button {
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 0.85rem;
      }

      .tag {
        display: inline-flex;
        align-items: center;
        padding: 4px 10px;
        border-radius: 999px;
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 0.08em;
      }

      .queued,
      .running {
        background: rgba(157, 90, 0, 0.12);
        color: var(--warn);
      }

      .completed {
        background: rgba(44, 107, 69, 0.12);
        color: var(--ok);
      }

      .failed {
        background: rgba(159, 45, 36, 0.12);
        color: var(--error);
      }

      .loading {
        background: rgba(21, 79, 99, 0.12);
        color: #154f63;
      }

      .hint,
      .filter-meta {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
        font-size: 0.92rem;
      }

      .error {
        color: var(--error);
      }

      .status-stack p,
      .preview-stack p {
        margin: 0 0 10px;
      }

      .preview-stack {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--line);
      }

      hr {
        border: 0;
        border-top: 1px solid var(--line);
        margin: 18px 0;
      }

      h3 {
        margin: 0 0 12px;
      }

      .download-link {
        color: var(--accent-strong);
        font-weight: 700;
        text-decoration: none;
        margin-right: 8px;
      }

      .download-link:hover {
        text-decoration: underline;
      }

      .path {
        display: block;
        margin-top: 6px;
        color: var(--muted);
        word-break: break-all;
      }

      .section-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }

      .filter-list {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 14px;
      }

      .filter-card {
        border-radius: 16px;
        background: rgba(255, 248, 239, 0.84);
        border: 1px solid rgba(31, 27, 22, 0.08);
        padding: 16px;
        display: grid;
        gap: 12px;
      }

      .filter-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }

      .filter-kind {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.75rem;
        color: var(--muted);
      }

      .editor-block,
      .range-editor {
        display: grid;
        gap: 10px;
      }

      .range-editor {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .action-row,
      .option-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .multi-select {
        min-height: 180px;
        border-radius: 16px;
        background: var(--surface-strong);
      }

      .option-pill {
        display: inline-flex;
        padding: 7px 12px;
        border-radius: 999px;
        font-size: 0.82rem;
      }

      .option-button {
        color: var(--text);
      }

      .option-selected {
        background: linear-gradient(135deg, rgba(178, 74, 47, 0.16) 0%, rgba(204, 106, 54, 0.16) 100%);
        border-color: rgba(178, 74, 47, 0.36);
      }

      .selected-values {
        margin: 0;
        font-weight: 600;
        line-height: 1.45;
      }

      @media (max-width: 920px) {
        .grid {
          grid-template-columns: 1fr;
        }

        .range-editor {
          grid-template-columns: 1fr;
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
  protected readonly editableFilters = signal<SpotfireFilter[]>([]);
  protected readonly job = signal<ScannerJob | null>(null);

  protected readonly form: FormGroup<{
    analysisTab: FormControl<string>;
    reportTitle: FormControl<string>;
    tableTitle: FormControl<string>;
  }> = new FormGroup({
    analysisTab: new FormControl('', { nonNullable: true }),
    reportTitle: new FormControl('Scanner 4.0 - CE', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    tableTitle: new FormControl('', { nonNullable: true }),
  });

  public ngOnInit(): void {
    this.loadCatalog();
  }

  protected submit(): void {
    if (this.form.invalid) {
      return;
    }

    this.loading.set(true);
    const rawValue = this.form.getRawValue();
    const payload = {
      reportTitle: rawValue.reportTitle,
      analysisTab: rawValue.analysisTab || undefined,
      tableTitle: rawValue.tableTitle || undefined,
      selectedFilters: this.getChangedFilters(),
    };

    this.api.startExecution(payload)
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

  protected refreshCatalog(): void {
    this.loadCatalog();
  }

  protected selectedTabLabel(): string {
    return this.form.controls.analysisTab.value || 'Aba ativa do Spotfire';
  }

  protected selectedTableLabel(): string {
    return this.form.controls.tableTitle.value || 'Nenhuma tabela escolhida';
  }

  protected describeFilter(filter: SpotfireFilter): string {
    if (filter.kind === 'range' && filter.range) {
      return `Intervalo detectado de ${filter.range.min} até ${filter.range.max}`;
    }

    if (filter.options?.length) {
      return `${filter.options.length} opções detectadas no catálogo`;
    }

    return filter.selectedValues.length ? `${filter.selectedValues.length} valores atuais detectados` : 'Sem valores detectados no catálogo';
  }

  protected previewValues(values: string[]): string {
    if (!values.length) {
      return 'nenhum item recebido';
    }

    const preview = values.slice(0, 5).join(', ');
    return values.length > 5 ? `${preview} e mais ${values.length - 5}` : preview;
  }

  protected previewFilterTitles(filters: SpotfireFilter[]): string {
    if (!filters.length) {
      return 'nenhum filtro recebido';
    }

    const preview = filters.slice(0, 6).map((filter) => filter.title).join(', ');
    return filters.length > 6 ? `${preview} e mais ${filters.length - 6}` : preview;
  }

  protected changedFiltersCount(): number {
    return this.getChangedFilters().length;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | null)?.value ?? '';
  }

  protected selectElementValues(event: Event): string[] {
    const target = event.target as HTMLSelectElement | null;

    if (!target) {
      return [];
    }

    return Array.from(target.selectedOptions)
      .map((option) => option.value.trim())
      .filter((value, index, list) => value.length > 0 && list.indexOf(value) === index);
  }

  protected updateSelectedOptions(title: string, selectedValues: string[]): void {
    const normalizedValues = selectedValues.filter((value, index, list) => value.length > 0 && list.indexOf(value) === index);

    this.updateFilter(title, (filter) => ({
      ...filter,
      selectedValues: normalizedValues,
    }));
  }

  protected selectAllFilterValues(title: string): void {
    this.updateFilter(title, (filter) => {
      const allOption = filter.options?.find((option) => option.label.toLowerCase().startsWith('(all)'));

      if (!allOption) {
        return filter;
      }

      return {
        ...filter,
        selectedValues: [allOption.label],
      };
    });
  }

  protected restoreFilterDefaults(title: string): void {
    const baseline = this.catalog()?.filters.find((filter) => filter.title === title);

    if (!baseline) {
      return;
    }

    this.updateFilter(title, () => this.cloneFilter(baseline));
  }

  protected clearFilterSelection(title: string): void {
    this.updateFilter(title, (filter) => ({
      ...filter,
      selectedValues: [],
      range: filter.range
        ? {
          ...filter.range,
          selectedMin: '',
          selectedMax: '',
        }
        : undefined,
    }));
  }

  protected updateRangeFilter(title: string, boundary: 'min' | 'max', value: string): void {
    this.updateFilter(title, (filter) => ({
      ...filter,
      range: filter.range
        ? {
          ...filter.range,
          selectedMin: boundary === 'min' ? value : filter.range.selectedMin,
          selectedMax: boundary === 'max' ? value : filter.range.selectedMax,
        }
        : undefined,
    }));
  }

  protected isValueSelected(filter: SpotfireFilter, label: string): boolean {
    return filter.selectedValues.some((value) => value.toLowerCase() === label.toLowerCase());
  }

  protected showCurrentSelection(filter: SpotfireFilter): boolean {
    return this.currentSelectionLabel(filter).length > 0;
  }

  protected currentSelectionLabel(filter: SpotfireFilter): string {
    if (filter.kind === 'range' && filter.range) {
      return filter.range.selectedMin || filter.range.selectedMax
        ? `Intervalo escolhido: ${filter.range.selectedMin || 'vazio'} -> ${filter.range.selectedMax || 'vazio'}`
        : '';
    }

    return filter.selectedValues.length ? `Valores escolhidos: ${filter.selectedValues.join(', ')}` : '';
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

  private loadCatalog(): void {
    this.catalogLoading.set(true);
    this.catalogRequestError.set(null);

    this.api.getCatalog()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (catalog) => {
          this.catalog.set(catalog);
          this.catalogLoading.set(catalog.status === 'loading');
          this.editableFilters.set(this.mergeEditableFilters(catalog.filters));

          if (!this.form.controls.reportTitle.value || this.form.controls.reportTitle.value === 'Scanner 4.0 - CE') {
            this.form.controls.reportTitle.setValue(catalog.reportTitle);
          }

          if (!catalog.availableTabs.includes(this.form.controls.analysisTab.value)) {
            this.form.controls.analysisTab.setValue('');
          }

          if (!catalog.availableTables.includes(this.form.controls.tableTitle.value)) {
            this.form.controls.tableTitle.setValue('');
          }
        },
        error: (error) => {
          this.catalogLoading.set(false);
          this.catalogRequestError.set(this.describeHttpError(error));
        },
      });
  }

  private mergeEditableFilters(incomingFilters: SpotfireFilter[]): SpotfireFilter[] {
    const currentByTitle = new Map(this.editableFilters().map((filter) => [filter.title, filter]));

    return incomingFilters.map((filter) => {
      const existing = currentByTitle.get(filter.title);

      if (!existing || existing.kind !== filter.kind) {
        return this.cloneFilter(filter);
      }

      return {
        ...this.cloneFilter(filter),
        selectedValues: [...existing.selectedValues],
        range: filter.range
          ? {
            ...filter.range,
            selectedMin: existing.range?.selectedMin ?? filter.range.selectedMin,
            selectedMax: existing.range?.selectedMax ?? filter.range.selectedMax,
          }
          : undefined,
      };
    });
  }

  private updateFilter(title: string, updater: (filter: SpotfireFilter) => SpotfireFilter): void {
    this.editableFilters.update((filters) => filters.map((filter) => {
      if (filter.title !== title) {
        return filter;
      }

      return updater(this.cloneFilter(filter));
    }));
  }

  private getChangedFilters(): SpotfireFilter[] {
    const baselineByTitle = new Map((this.catalog()?.filters ?? []).map((filter) => [filter.title, filter]));

    return this.editableFilters()
      .filter((filter) => this.isFilterChanged(filter, baselineByTitle.get(filter.title)))
      .map((filter) => this.cloneFilter(filter));
  }

  private isFilterChanged(current: SpotfireFilter, baseline?: SpotfireFilter): boolean {
    if (!baseline) {
      return this.hasMeaningfulSelection(current);
    }

    if (current.kind !== baseline.kind) {
      return true;
    }

    if (current.kind === 'range') {
      return (current.range?.selectedMin ?? '').trim() !== (baseline.range?.selectedMin ?? '').trim()
        || (current.range?.selectedMax ?? '').trim() !== (baseline.range?.selectedMax ?? '').trim();
    }

    return this.normalizeValues(current.selectedValues) !== this.normalizeValues(baseline.selectedValues);
  }

  private hasMeaningfulSelection(filter: SpotfireFilter): boolean {
    if (filter.kind === 'range') {
      return Boolean(filter.range?.selectedMin?.trim() || filter.range?.selectedMax?.trim());
    }

    return filter.selectedValues.some((value) => value.trim().length > 0);
  }

  private normalizeValues(values: string[]): string {
    return values
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
      .sort()
      .join('|');
  }

  private cloneFilter(filter: SpotfireFilter): SpotfireFilter {
    return {
      ...filter,
      selectedValues: [...filter.selectedValues],
      options: filter.options?.map((option) => ({ ...option })),
      range: filter.range ? { ...filter.range } : undefined,
    };
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
        const suffix = typeof candidate.statusText === 'string' && candidate.statusText.trim().length > 0
          ? ` ${candidate.statusText}`
          : '';
        return `HTTP ${candidate.status}${suffix}`;
      }
    }

    return 'falha ao carregar o catálogo do backend';
  }
}