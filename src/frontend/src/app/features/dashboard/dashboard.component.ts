import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { interval, startWith, switchMap, takeWhile } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

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
        <h1>Orquestração da extração Spotfire</h1>
        <p class="summary">
          O frontend agora recebe primeiro o catálogo completo do Spotfire: abas, tabelas e filtros.
          A extração só acontece depois que esse catálogo estiver pronto e o usuário escolher o que quer baixar.
        </p>
      </section>

      <section class="grid top-grid">
        <article class="panel form-panel">
          <div class="section-head">
            <h2>Extração</h2>
            <button type="button" class="ghost-button" (click)="refreshCatalog()" [disabled]="catalogLoading()">
              Atualizar catálogo
            </button>
          </div>

          <form [formGroup]="form" (ngSubmit)="submit()">
            <label>
              Relatório
              <input formControlName="reportTitle" placeholder="Scanner 4.0 - CE" />
            </label>

            <label *ngIf="catalog()?.availableTabs?.length; else manualTabField">
              Aba alvo
              <select formControlName="analysisTab">
                <option value="">Escolha pela grade ao lado ou use a aba ativa</option>
                <option *ngFor="let tab of catalog()?.availableTabs" [value]="tab">{{ tab }}</option>
              </select>
            </label>

            <ng-template #manualTabField>
              <label>
                Aba alvo
                <input formControlName="analysisTab" placeholder="Descubra primeiro ou informe manualmente" />
              </label>
            </ng-template>

            <label *ngIf="catalog()?.availableTables?.length">
              Tabela para exportar
              <select formControlName="tableTitle">
                <option value="">Escolher depois</option>
                <option *ngFor="let table of catalog()?.availableTables" [value]="table">{{ table }}</option>
              </select>
            </label>

            <p class="hint">A extração usa a aba e a tabela selecionadas acima. Os filtros exibidos abaixo vêm do catálogo inicial recebido do backend.</p>

            <button type="submit" [disabled]="form.invalid || loading() || catalogLoading() || catalog()?.status !== 'ready'">
              {{ loading() ? 'Enfileirando...' : submitLabel() }}
            </button>
          </form>
        </article>

        <article class="panel status-panel">
          <h2>Catálogo recebido</h2>
          <div class="status-stack">
            <p><strong>Status:</strong> <span [class]="'tag ' + (catalog()?.status ?? 'queued')">{{ catalog()?.status ?? 'loading' }}</span></p>
            <p><strong>Relatório base:</strong> {{ catalog()?.reportTitle || form.controls.reportTitle.value }}</p>
            <p><strong>Abas:</strong> {{ catalog()?.availableTabs?.length ?? 0 }}</p>
            <p><strong>Tabelas:</strong> {{ catalog()?.availableTables?.length ?? 0 }}</p>
            <p><strong>Filtros:</strong> {{ catalog()?.filters?.length ?? 0 }}</p>
            <p><strong>Aba selecionada:</strong> {{ selectedTabLabel() }}</p>
            <p><strong>Tabela selecionada:</strong> {{ selectedTableLabel() }}</p>
            <p *ngIf="catalog()?.updatedAt"><strong>Atualizado em:</strong> {{ catalog()?.updatedAt }}</p>
            <p *ngIf="catalog()?.errorMessage" class="error"><strong>Erro no catálogo:</strong> {{ catalog()?.errorMessage }}</p>
            <p *ngIf="catalogLoading()">Recebendo abas e filtros do backend. Enquanto isso a tela continua consultando o catálogo.</p>
          </div>

          <ng-container *ngIf="job() as currentJob; else emptyState">
            <hr />
            <h3>Última extração</h3>
            <p><strong>Job:</strong> {{ currentJob.id }}</p>
            <p><strong>Status:</strong> <span [class]="'tag ' + currentJob.status">{{ currentJob.status }}</span></p>
            <p><strong>Aba:</strong> {{ currentJob.request.analysisTab || 'Aba ativa do Spotfire' }}</p>
            <p><strong>Relatório:</strong> {{ currentJob.request.reportTitle }}</p>
            <p><strong>Tabela:</strong> {{ currentJob.request.tableTitle || 'Nenhuma selecionada' }}</p>
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

      <section class="grid middle-grid">
        <article class="panel tabs-panel">
          <div class="section-head">
            <h2>Abas disponíveis</h2>
            <span>{{ catalog()?.availableTabs?.length ?? 0 }}</span>
          </div>

          <div class="chip-grid" *ngIf="catalog()?.availableTabs?.length; else noTabs">
            <button
              *ngFor="let tab of catalog()?.availableTabs"
              type="button"
              class="chip"
              [class.active]="form.controls.analysisTab.value === tab"
              (click)="selectTab(tab)">
              {{ tab }}
            </button>
          </div>

          <ng-template #noTabs>
            <p>Nenhuma aba recebida ainda do backend.</p>
          </ng-template>
        </article>

        <article class="panel tables-panel">
          <div class="section-head">
            <h2>Tabelas disponíveis</h2>
            <span>{{ catalog()?.availableTables?.length ?? 0 }}</span>
          </div>

          <div class="list-grid" *ngIf="catalog()?.availableTables?.length; else noTables">
            <button
              *ngFor="let table of catalog()?.availableTables"
              type="button"
              class="list-item"
              [class.active]="form.controls.tableTitle.value === table"
              (click)="selectTable(table)">
              {{ table }}
            </button>
          </div>

          <ng-template #noTables>
            <p>Nenhuma tabela recebida ainda do backend.</p>
          </ng-template>
        </article>
      </section>

      <section class="panel filter-panel">
        <div class="section-head">
          <h2>Filtros detectados</h2>
          <span>{{ catalog()?.filters?.length ?? 0 }} itens</span>
        </div>

        <div class="filter-list" *ngIf="catalog()?.filters?.length; else noFilters">
          <div class="filter-card" *ngFor="let filter of catalog()?.filters">
            <div class="filter-header">
              <strong>{{ filter.title }}</strong>
              <span class="filter-kind">{{ filter.kind }}</span>
            </div>
            <div class="filter-meta">{{ describeFilter(filter) }}</div>

            <div class="selected-values" *ngIf="filter.selectedValues.length">
              {{ filter.selectedValues.join(', ') }}
            </div>

            <div class="option-list" *ngIf="filter.options?.length">
              <span class="option-pill" *ngFor="let option of visibleOptions(filter)">
                {{ option.label }}
              </span>
            </div>

            <div class="range-line" *ngIf="filter.range">
              {{ filter.range.selectedMin }} -> {{ filter.range.selectedMax }}
            </div>
          </div>
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
        max-width: 1120px;
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
        font-size: clamp(2.2rem, 5vw, 4rem);
        line-height: 0.96;
        max-width: 9ch;
      }

      .summary {
        max-width: 60ch;
        color: var(--muted);
        line-height: 1.6;
      }

      .top-grid,
      .middle-grid {
        margin-bottom: 18px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
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

      .hint {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
        font-size: 0.92rem;
      }

      label {
        display: grid;
        gap: 8px;
        font-weight: 600;
      }

      input {
        width: 100%;
        border-radius: 14px;
        border: 1px solid rgba(31, 27, 22, 0.16);
        padding: 13px 14px;
        background: var(--surface-strong);
      }

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

      .ghost-button {
        background: transparent;
        color: var(--accent-strong);
        border: 1px solid rgba(31, 27, 22, 0.14);
        padding: 10px 14px;
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

      .error {
        color: var(--error);
      }

      .status-stack p {
        margin: 0 0 10px;
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
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }

      .chip-grid,
      .list-grid {
        display: grid;
        gap: 10px;
      }

      .chip-grid {
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      }

      .chip,
      .list-item {
        border-radius: 14px;
        border: 1px solid rgba(31, 27, 22, 0.12);
        background: rgba(255, 248, 239, 0.82);
        color: var(--text);
        padding: 12px 14px;
        text-align: left;
      }

      .chip.active,
      .list-item.active {
        background: linear-gradient(135deg, rgba(178, 74, 47, 0.16) 0%, rgba(204, 106, 54, 0.16) 100%);
        border-color: rgba(178, 74, 47, 0.36);
      }

      .filter-card {
        border-radius: 16px;
        background: rgba(255, 248, 239, 0.84);
        border: 1px solid rgba(31, 27, 22, 0.08);
        padding: 14px;
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

      .filter-meta {
        margin: 8px 0 10px;
        color: var(--muted);
        font-size: 0.92rem;
      }

      .selected-values,
      .range-line {
        font-weight: 600;
        line-height: 1.4;
      }

      .option-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }

      .option-pill {
        display: inline-flex;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(31, 27, 22, 0.06);
        font-size: 0.82rem;
      }

      @media (max-width: 820px) {
        .grid {
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
  protected readonly job = signal<ScannerJob | null>(null);

  protected readonly form: FormGroup<{
    analysisTab: FormControl<string>;
    reportTitle: FormControl<string>;
    tableTitle: FormControl<string>;
  }> = new FormGroup({
    analysisTab: new FormControl('', {
      nonNullable: true,
    }),
    reportTitle: new FormControl('Scanner 4.0 - CE', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    tableTitle: new FormControl('', {
      nonNullable: true,
    }),
  });

  public ngOnInit(): void {
    this.startCatalogSync();
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

    this.api.getCatalog()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (catalog) => {
          this.catalog.set(catalog);
          this.catalogLoading.set(catalog.status === 'loading');

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
        error: () => {
          this.catalogLoading.set(false);
        },
      });
  }

  private startCatalogSync(): void {
    interval(3000)
      .pipe(startWith(0), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.loadCatalog();
      });
  }

  protected refreshCatalog(): void {
    this.loadCatalog();
  }

  protected selectTab(tab: string): void {
    this.form.controls.analysisTab.setValue(tab);
  }

  protected selectTable(table: string): void {
    this.form.controls.tableTitle.setValue(table);
  }

  protected selectedTabLabel(): string {
    return this.form.controls.analysisTab.value || 'Nenhuma aba escolhida';
  }

  protected selectedTableLabel(): string {
    return this.form.controls.tableTitle.value || 'Nenhuma tabela escolhida';
  }

  protected describeFilter(filter: SpotfireFilter): string {
    if (filter.kind === 'range' && filter.range) {
      return `Intervalo ${filter.range.min} a ${filter.range.max}`;
    }

    if (filter.kind === 'text') {
      return filter.textValue ? `Texto atual: ${filter.textValue}` : 'Filtro textual sem valor preenchido';
    }

    if (filter.options?.length) {
      return `${filter.options.length} opções mapeadas`;
    }

    return filter.selectedValues.length ? `${filter.selectedValues.length} valores selecionados` : 'Sem detalhes adicionais';
  }

  protected visibleOptions(filter: SpotfireFilter) {
    return (filter.options ?? []).slice(0, 6);
  }

  protected submitLabel(): string {
    return this.form.controls.tableTitle.value ? 'Baixar dado da tabela selecionada' : 'Iniciar extração';
  }
}