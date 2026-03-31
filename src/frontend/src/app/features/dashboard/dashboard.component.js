import { __decorate } from "tslib";
import { CommonModule } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { distinctUntilChanged, interval, startWith, switchMap, takeWhile } from 'rxjs';
import { ScannerApiService } from '../../core/api/scanner-api.service';
let DashboardComponent = class DashboardComponent {
    constructor() {
        this.api = inject(ScannerApiService);
        this.destroyRef = inject(DestroyRef);
        this.loading = signal(false);
        this.catalogLoading = signal(true);
        this.catalog = signal(null);
        this.catalogRequestError = signal(null);
        this.editableFilters = signal([]);
        this.job = signal(null);
        this.form = new FormGroup({
            analysisTab: new FormControl('', { nonNullable: true }),
            reportTitle: new FormControl('Scanner 4.0 - CE', {
                nonNullable: true,
                validators: [Validators.required],
            }),
            tableTitle: new FormControl('', { nonNullable: true }),
        });
    }
    ngOnInit() {
        this.form.controls.analysisTab.valueChanges
            .pipe(distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
            .subscribe((analysisTab) => {
            this.form.controls.tableTitle.setValue('', { emitEvent: false });
            this.loadCatalog(analysisTab || undefined);
        });
        this.loadCatalog();
    }
    submit() {
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
    refreshCatalog() {
        this.loadCatalog(this.form.controls.analysisTab.value || undefined);
    }
    catalogReady() {
        return this.catalog()?.status === 'ready';
    }
    selectedTabLabel() {
        return this.form.controls.analysisTab.value || 'Aba ativa do Spotfire';
    }
    selectedTableLabel() {
        return this.form.controls.tableTitle.value || 'Nenhuma tabela escolhida';
    }
    describeFilter(filter) {
        if (filter.kind === 'range' && filter.range) {
            return `Intervalo detectado de ${filter.range.min} até ${filter.range.max}`;
        }
        if (filter.options?.length) {
            return `${filter.options.length} opções detectadas no catálogo`;
        }
        return filter.selectedValues.length ? `${filter.selectedValues.length} valores atuais detectados` : 'Sem valores detectados no catálogo';
    }
    previewValues(values) {
        if (!values.length) {
            return 'nenhum item recebido';
        }
        const preview = values.slice(0, 5).join(', ');
        return values.length > 5 ? `${preview} e mais ${values.length - 5}` : preview;
    }
    previewFilterTitles(filters) {
        if (!filters.length) {
            return 'nenhum filtro recebido';
        }
        const preview = filters.slice(0, 6).map((filter) => filter.title).join(', ');
        return filters.length > 6 ? `${preview} e mais ${filters.length - 6}` : preview;
    }
    changedFiltersCount() {
        return this.getChangedFilters().length;
    }
    toggleOptionSelection(title, optionLabel) {
        this.updateFilter(title, (filter) => {
            const currentValues = filter.selectedValues.filter((value) => value.trim().length > 0);
            const normalizedOption = optionLabel.trim().toLowerCase();
            const hasAllOption = (filter.options ?? []).some((option) => this.isAllOption(option.label));
            if (this.isAllOption(optionLabel)) {
                return {
                    ...filter,
                    selectedValues: [optionLabel],
                };
            }
            const withoutAll = currentValues.filter((value) => !this.isAllOption(value));
            const alreadySelected = withoutAll.some((value) => value.trim().toLowerCase() === normalizedOption);
            const nextValues = alreadySelected
                ? withoutAll.filter((value) => value.trim().toLowerCase() !== normalizedOption)
                : [...withoutAll, optionLabel];
            return {
                ...filter,
                selectedValues: hasAllOption || nextValues.length > 0 ? nextValues : [],
            };
        });
    }
    selectAllFilterValues(title) {
        this.updateFilter(title, (filter) => {
            const allOption = filter.options?.find((option) => option.label.toLowerCase().startsWith('(all)'));
            if (allOption) {
                return {
                    ...filter,
                    selectedValues: [allOption.label],
                };
            }
            return {
                ...filter,
                selectedValues: (filter.options ?? []).map((option) => option.label),
            };
        });
    }
    restoreFilterDefaults(title) {
        const baseline = this.catalog()?.filters.find((filter) => filter.title === title);
        if (!baseline) {
            return;
        }
        this.updateFilter(title, () => this.cloneFilter(baseline));
    }
    clearFilterSelection(title) {
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
    rangeEditorKind(filter) {
        const range = filter.range;
        if (!range) {
            return 'readonly';
        }
        if (this.isDateTimeValue(range.min) || this.isDateTimeValue(range.max)) {
            return 'datetime';
        }
        if (this.isDateValue(range.min) || this.isDateValue(range.max)) {
            return 'date';
        }
        if (this.parseNumericValue(range.min) !== null && this.parseNumericValue(range.max) !== null) {
            return 'number';
        }
        return 'readonly';
    }
    toCalendarInputValue(value) {
        const trimmed = value.trim();
        if (!trimmed) {
            return '';
        }
        const match = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
        if (!match) {
            return '';
        }
        const [, day, month, year, hours, minutes] = match;
        const base = `${year}-${month}-${day}`;
        if (hours && minutes) {
            return `${base}T${hours}:${minutes}`;
        }
        return base;
    }
    updateCalendarRangeFilter(title, boundary, event, template) {
        const nextValue = event.target?.value ?? '';
        const formattedValue = this.fromCalendarInputValue(nextValue, template);
        this.updateRangeFilter(title, boundary, formattedValue);
    }
    preventKeyboardInput(event) {
        event.preventDefault();
    }
    numericRangeConfig(filter) {
        const range = filter.range;
        if (!range) {
            return null;
        }
        const min = this.parseNumericValue(range.min);
        const max = this.parseNumericValue(range.max);
        if (min === null || max === null) {
            return null;
        }
        const orderedMin = Math.min(min, max);
        const orderedMax = Math.max(min, max);
        const selectedMin = this.parseNumericValue(range.selectedMin) ?? orderedMin;
        const selectedMax = this.parseNumericValue(range.selectedMax) ?? orderedMax;
        const decimals = this.getNumericPrecision(range.min, range.max, range.selectedMin, range.selectedMax);
        const spread = orderedMax - orderedMin;
        const rawStep = spread > 0 ? spread / 200 : 1;
        const minimumStep = decimals > 0 ? Number((1 / (10 ** decimals)).toFixed(decimals)) : 1;
        const step = Math.max(Number(rawStep.toFixed(Math.min(decimals + 1, 6))), minimumStep);
        return {
            min: orderedMin,
            max: orderedMax,
            step,
            selectedMin: Math.min(Math.max(selectedMin, orderedMin), selectedMax),
            selectedMax: Math.max(Math.min(selectedMax, orderedMax), selectedMin),
        };
    }
    updateNumericRangeFilter(title, boundary, event) {
        const nextNumericValue = Number(event.target?.value ?? Number.NaN);
        if (Number.isNaN(nextNumericValue)) {
            return;
        }
        this.updateFilter(title, (filter) => {
            if (!filter.range) {
                return filter;
            }
            const config = this.numericRangeConfig(filter);
            if (!config) {
                return filter;
            }
            const nextMin = boundary === 'min' ? Math.min(nextNumericValue, config.selectedMax) : config.selectedMin;
            const nextMax = boundary === 'max' ? Math.max(nextNumericValue, config.selectedMin) : config.selectedMax;
            return {
                ...filter,
                range: {
                    ...filter.range,
                    selectedMin: this.formatNumericValue(filter.range.min, nextMin),
                    selectedMax: this.formatNumericValue(filter.range.max, nextMax),
                },
            };
        });
    }
    formatNumericPreview(value) {
        return value || 'vazio';
    }
    updateRangeFilter(title, boundary, value) {
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
    isValueSelected(filter, label) {
        return filter.selectedValues.some((value) => value.toLowerCase() === label.toLowerCase());
    }
    showCurrentSelection(filter) {
        return this.currentSelectionLabel(filter).length > 0;
    }
    currentSelectionLabel(filter) {
        if (filter.kind === 'range' && filter.range) {
            return filter.range.selectedMin || filter.range.selectedMax
                ? `Intervalo escolhido: ${filter.range.selectedMin || 'vazio'} -> ${filter.range.selectedMax || 'vazio'}`
                : '';
        }
        if (filter.kind === 'text') {
            return filter.selectedValues.length ? `Valor detectado: ${filter.selectedValues.join(', ')}` : '';
        }
        return filter.selectedValues.length ? `Valores escolhidos: ${filter.selectedValues.join(', ')}` : '';
    }
    pollJob(jobId) {
        interval(2000)
            .pipe(startWith(0), switchMap(() => this.api.getExecution(jobId)), takeWhile((job) => job.status === 'queued' || job.status === 'running', true), takeUntilDestroyed(this.destroyRef))
            .subscribe((job) => {
            this.job.set(job);
        });
    }
    loadCatalog(analysisTab) {
        this.catalogLoading.set(true);
        this.catalogRequestError.set(null);
        this.editableFilters.set([]);
        const previousCatalog = this.catalog();
        this.catalog.set(previousCatalog
            ? {
                ...previousCatalog,
                status: 'loading',
                availableTables: analysisTab ? [] : previousCatalog.availableTables,
                filters: analysisTab ? [] : previousCatalog.filters,
            }
            : null);
        const currentReportTitle = this.form.controls.reportTitle.value.trim();
        const currentCatalog = this.catalog();
        const shouldRequestReportTitle = currentReportTitle.length > 0
            && currentReportTitle !== 'Scanner 4.0 - CE'
            && currentReportTitle !== (currentCatalog?.reportTitle ?? '');
        this.api.getCatalog({
            analysisTab,
            reportTitle: shouldRequestReportTitle ? currentReportTitle : undefined,
        })
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
            next: (catalog) => {
                this.catalog.set(catalog);
                this.catalogLoading.set(catalog.status === 'loading');
                this.editableFilters.set(this.mergeEditableFilters(catalog.filters));
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
            },
        });
    }
    mergeEditableFilters(incomingFilters) {
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
    updateFilter(title, updater) {
        this.editableFilters.update((filters) => filters.map((filter) => {
            if (filter.title !== title) {
                return filter;
            }
            return updater(this.cloneFilter(filter));
        }));
    }
    getChangedFilters() {
        const baselineByTitle = new Map((this.catalog()?.filters ?? []).map((filter) => [filter.title, filter]));
        return this.editableFilters()
            .filter((filter) => this.isFilterChanged(filter, baselineByTitle.get(filter.title)))
            .map((filter) => this.cloneFilter(filter));
    }
    isFilterChanged(current, baseline) {
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
    hasMeaningfulSelection(filter) {
        if (filter.kind === 'range') {
            return Boolean(filter.range?.selectedMin?.trim() || filter.range?.selectedMax?.trim());
        }
        if (filter.kind === 'text') {
            return Boolean(filter.textValue?.trim());
        }
        return filter.selectedValues.some((value) => value.trim().length > 0);
    }
    isAllOption(value) {
        return value.trim().toLowerCase().startsWith('(all)');
    }
    isDateValue(value) {
        return /^\d{2}\/\d{2}\/\d{4}$/.test(value.trim());
    }
    isDateTimeValue(value) {
        return /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?$/.test(value.trim());
    }
    fromCalendarInputValue(value, template) {
        const trimmedValue = value.trim();
        if (!trimmedValue) {
            return '';
        }
        const [datePart, timePart] = trimmedValue.split('T');
        const [year, month, day] = datePart.split('-');
        if (!year || !month || !day) {
            return '';
        }
        if (timePart) {
            const seconds = /:\d{2}$/.test(template.trim()) ? ':00' : '';
            return `${day}/${month}/${year} ${timePart}${seconds}`;
        }
        return `${day}/${month}/${year}`;
    }
    parseNumericValue(value) {
        const trimmed = value.trim();
        if (!trimmed || trimmed.includes('/')) {
            return null;
        }
        const normalized = trimmed
            .replace(/\./g, '')
            .replace(',', '.');
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }
    formatNumericValue(template, value) {
        const decimals = this.getNumericPrecision(template);
        if (decimals === 0) {
            return Math.round(value).toString();
        }
        return value.toFixed(decimals).replace('.', ',');
    }
    getNumericPrecision(...values) {
        return values.reduce((highestPrecision, currentValue) => {
            const match = currentValue?.trim().match(/,(\d+)$/);
            return Math.max(highestPrecision, match?.[1]?.length ?? 0);
        }, 0);
    }
    normalizeValues(values) {
        return values
            .map((value) => value.trim().toLowerCase())
            .filter((value) => value.length > 0)
            .sort()
            .join('|');
    }
    cloneFilter(filter) {
        return {
            ...filter,
            selectedValues: [...filter.selectedValues],
            options: filter.options?.map((option) => ({ ...option })),
            range: filter.range ? { ...filter.range } : undefined,
        };
    }
    describeHttpError(error) {
        if (typeof error === 'object' && error !== null) {
            const candidate = error;
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
};
DashboardComponent = __decorate([
    Component({
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
              <div class="editor-label">Valores para aplicar</div>

              <div class="choice-grid" *ngIf="filter.options?.length; else emptyOptionSet">
                <button
                  type="button"
                  class="choice-chip"
                  *ngFor="let option of filter.options ?? []"
                  [class.choice-chip-selected]="isValueSelected(filter, option.label)"
                  [class.choice-chip-dimmed]="!option.selected && !isValueSelected(filter, option.label)"
                  (click)="toggleOptionSelection(filter.title, option.label)">
                  <span>{{ option.label }}</span>
                </button>
              </div>

              <ng-template #emptyOptionSet>
                <p class="filter-meta">Nenhuma opção disponível para esse filtro.</p>
              </ng-template>

              <div class="action-row">
                <button type="button" class="mini-button" (click)="selectAllFilterValues(filter.title)">Selecionar (All)</button>
                <button type="button" class="mini-button" (click)="restoreFilterDefaults(filter.title)">Restaurar padrão</button>
                <button type="button" class="mini-button" (click)="clearFilterSelection(filter.title)">Limpar</button>
              </div>
            </div>

            <div class="range-editor" *ngIf="filter.kind === 'range' && filter.range">
              <ng-container [ngSwitch]="rangeEditorKind(filter)">
                <div class="calendar-range" *ngSwitchCase="'date'">
                  <label class="editor-label calendar-field">
                    Data inicial
                    <input
                      class="calendar-input"
                      type="date"
                      [value]="toCalendarInputValue(filter.range.selectedMin)"
                      (change)="updateCalendarRangeFilter(filter.title, 'min', $event, filter.range.selectedMin)"
                      (keydown)="preventKeyboardInput($event)" />
                  </label>

                  <label class="editor-label calendar-field">
                    Data final
                    <input
                      class="calendar-input"
                      type="date"
                      [value]="toCalendarInputValue(filter.range.selectedMax)"
                      (change)="updateCalendarRangeFilter(filter.title, 'max', $event, filter.range.selectedMax)"
                      (keydown)="preventKeyboardInput($event)" />
                  </label>
                </div>

                <div class="calendar-range" *ngSwitchCase="'datetime'">
                  <label class="editor-label calendar-field">
                    Data e hora inicial
                    <input
                      class="calendar-input"
                      type="datetime-local"
                      [value]="toCalendarInputValue(filter.range.selectedMin)"
                      (change)="updateCalendarRangeFilter(filter.title, 'min', $event, filter.range.selectedMin)"
                      (keydown)="preventKeyboardInput($event)" />
                  </label>

                  <label class="editor-label calendar-field">
                    Data e hora final
                    <input
                      class="calendar-input"
                      type="datetime-local"
                      [value]="toCalendarInputValue(filter.range.selectedMax)"
                      (change)="updateCalendarRangeFilter(filter.title, 'max', $event, filter.range.selectedMax)"
                      (keydown)="preventKeyboardInput($event)" />
                  </label>
                </div>

                <div class="numeric-range-shell" *ngSwitchCase="'number'">
                  <div class="range-badges" *ngIf="numericRangeConfig(filter) as config">
                    <span class="range-pill">Min {{ formatNumericPreview(filter.range.selectedMin || filter.range.min) }}</span>
                    <span class="range-pill">Max {{ formatNumericPreview(filter.range.selectedMax || filter.range.max) }}</span>
                  </div>

                  <div class="dual-slider" *ngIf="numericRangeConfig(filter) as config">
                    <label class="slider-label">
                      <span>Valor inicial</span>
                      <input
                        type="range"
                        [min]="config.min"
                        [max]="config.max"
                        [step]="config.step"
                        [value]="config.selectedMin"
                        (input)="updateNumericRangeFilter(filter.title, 'min', $event)"
                        (keydown)="preventKeyboardInput($event)" />
                    </label>

                    <label class="slider-label">
                      <span>Valor final</span>
                      <input
                        type="range"
                        [min]="config.min"
                        [max]="config.max"
                        [step]="config.step"
                        [value]="config.selectedMax"
                        (input)="updateNumericRangeFilter(filter.title, 'max', $event)"
                        (keydown)="preventKeyboardInput($event)" />
                    </label>
                  </div>
                </div>

                <div class="readonly-range" *ngSwitchDefault>
                  <span class="range-pill">Inicial {{ filter.range.selectedMin || filter.range.min }}</span>
                  <span class="range-pill">Final {{ filter.range.selectedMax || filter.range.max }}</span>
                </div>
              </ng-container>

              <div class="action-row">
                <button type="button" class="mini-button" (click)="restoreFilterDefaults(filter.title)">Restaurar padrão</button>
                <button type="button" class="mini-button" (click)="clearFilterSelection(filter.title)">Limpar</button>
              </div>
            </div>

            <div class="readonly-filter" *ngIf="filter.kind === 'text' || filter.kind === 'unknown'">
              <p class="filter-meta">Esse filtro fica somente em leitura na interface para manter o fluxo sem digitação.</p>
              <div class="readonly-range">
                <span class="range-pill" *ngIf="filter.selectedValues.length">{{ filter.selectedValues.join(', ') }}</span>
                <span class="range-pill" *ngIf="!filter.selectedValues.length">Sem valor editável</span>
              </div>
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
      </ng-container>
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

      .loading-popup-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(34, 24, 18, 0.28);
        backdrop-filter: blur(8px);
      }

      .loading-popup {
        width: min(440px, 100%);
        text-align: center;
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 24px;
        padding: 28px 24px;
        box-shadow: 0 24px 60px rgba(67, 42, 22, 0.16);
      }

      .loading-spinner {
        width: 52px;
        height: 52px;
        margin: 0 auto 16px;
        border-radius: 50%;
        border: 4px solid rgba(178, 74, 47, 0.18);
        border-top-color: var(--accent);
        animation: loading-spin 0.9s linear infinite;
      }

      @keyframes loading-spin {
        to {
          transform: rotate(360deg);
        }
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

      .action-row,
      .option-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .choice-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
        gap: 10px;
        max-height: 240px;
        overflow: auto;
        padding-right: 4px;
      }

      .choice-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        padding: 12px 14px;
        border-radius: 18px;
        border: 1px solid rgba(31, 27, 22, 0.1);
        background: rgba(255, 255, 255, 0.7);
        color: var(--text);
        text-align: center;
        line-height: 1.3;
        font-size: 0.9rem;
      }

      .choice-chip-selected {
        background: linear-gradient(135deg, rgba(178, 74, 47, 0.14) 0%, rgba(204, 106, 54, 0.22) 100%);
        border-color: rgba(178, 74, 47, 0.34);
        color: var(--accent-strong);
      }

      .choice-chip-dimmed {
        opacity: 0.72;
      }

      .calendar-range,
      .numeric-range-shell,
      .readonly-filter {
        display: grid;
        gap: 12px;
      }

      .calendar-range {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .calendar-field {
        gap: 6px;
      }

      .calendar-input {
        min-height: 48px;
        cursor: pointer;
      }

      .range-badges,
      .readonly-range {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .range-pill {
        display: inline-flex;
        align-items: center;
        min-height: 36px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(31, 27, 22, 0.1);
        color: var(--text);
        font-size: 0.88rem;
      }

      .dual-slider {
        display: grid;
        gap: 12px;
      }

      .slider-label {
        display: grid;
        gap: 8px;
        font-weight: 600;
      }

      .slider-label input[type='range'] {
        width: 100%;
        padding: 0;
        border: 0;
        background: transparent;
        accent-color: var(--accent);
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

        .calendar-range {
          grid-template-columns: 1fr;
        }
      }
    `,
        ],
    })
], DashboardComponent);
export { DashboardComponent };
//# sourceMappingURL=dashboard.component.js.map