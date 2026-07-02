// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import { CommonModule } from '@angular/common';
import { buildTimelineSegments } from '../../shared/utils/timeline-segment.utils';
import { TimelineVisualComponent } from '../../shared/components/timeline-visual/timeline-visual.component';
import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import { forkJoin, firstValueFrom } from 'rxjs';
import html2canvas from 'html2canvas';
import {
  DataDownloadCallbacks,
  GeneratedReport,
  ReportKpiInsight,
  OsDiaOrderEvidence,
  EficienciaOrderEvidence,
  EficienciaTeamAnalysis,
  TmeImpOrderEvidence,
  TmeImpTeamAnalysis,
  PrimeiroLoginDayEvidence,
  PrimeiroLoginTeamAnalysis,
  PrimeiroDeslocDayEvidence,
  PrimeiroDeslocTeamAnalysis,
  RetornoBaseDayEvidence,
  RetornoBaseTeamAnalysis,
  TeamKpiScorecard,
  ScannerApiService,
  ScannerDataDownloadResult,
  ScannerJob,
  BasesConfig
} from '../../core/api/scanner-api.service';
import { DashboardPdfService } from './services/dashboard-pdf.service';
import { DashboardChartService } from './services/dashboard-chart.service';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TocNavComponent } from '../../shared/toc/toc-nav.component';
import { SpotfireFilter } from '../../models/spotfire-catalog.model';

type FilterKey = 'ano' | 'mes' | 'atuacaoHd' | 'base';
type ReportTypeValue = 'operacional' | 'analitico';
type ReportFilterKey = 'reportBase' | 'reportTipoEquipe' | 'reportEquipe' | 'reportDataRef';

type SelectFilterState = {
  key: FilterKey;
  title: string;
  value: string[];
  options: string[];
  sourceTitle?: string;
  sourceKind?: SpotfireFilter['kind'];
  enabled: boolean;
};

type ReportSelectFilterState = {
  key: ReportFilterKey;
  title: string;
  value: string[];
  options: string[];
  enabled: boolean;
};

type ReportTypeOption = {
  value: ReportTypeValue;
  label: string;
};

type PeriodSelectionPayload = {
  year?: string[];
  month?: string[];
  dayRange?: { min: number; max: number };
  /** Per-month ranges for cross-month selections (key = month abbrev e.g. "abr") */
  monthDayRanges?: Record<string, { min: number; max: number }>;
};

const ALL_OPTION = 'All';
const DEFAULT_REPORT_TITLE = 'Scanner 4.0 - CE';
const MONTH_OPTIONS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ATUACAO_HD_OPTIONS = ['Cadastrar', 'CORTE E RELIGAÇÃO', 'EMERGENCIA', 'LIGAÇÕES NOVAS', 'MANUTENÇÃO/OBRAS', 'PERDAS'];
const BASE_OPTIONS = ['Cadastrar', 'ATLÂNTICO', 'CENTRO-NORTE', 'CENTRO-SUL', 'FORTALEZA', 'LESTE', 'METROPOLITANA', 'NORTE', 'SUL'];
const REPORT_TEAM_TYPE_OPTIONS = ['Própria', 'Parceira'];
const FILTER_SOURCE_MAP: Record<'atuacaoHd' | 'base', { sourceTitle: string; sourceKind: SpotfireFilter['kind'] }> = {
  atuacaoHd: { sourceTitle: 'Atuação', sourceKind: 'list' },
  base: { sourceTitle: 'Base', sourceKind: 'list' },
};
const REPORT_TYPE_OPTIONS: ReportTypeOption[] = [
  {
    value: 'operacional',
    label: 'Operacional',
  },
  {
    value: 'analitico',
    label: 'Analítico',
  },
];

const STORAGE_KEY = 'scanner_filter_state';

type SavedFilterState = {
  filters: Record<FilterKey, string[]>;
  dayRange: { min: number; max: number };
  reportType: ReportTypeValue;
  analiticoFilters?: Record<ReportFilterKey, string[]>;
  operacionalFilters?: Record<ReportFilterKey, string[]>;
  reportFilters?: Record<ReportFilterKey, string[]>; // fallback
  savedAt?: string;
};

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, TocNavComponent, TimelineVisualComponent],
  template: `
    <main class="shell">
      <div class="report-loading" *ngIf="loading()" aria-live="polite" aria-busy="true">
        <div class="loading-success-icon" *ngIf="!errorMessage() && generatingReport()">
          <svg viewBox="0 0 52 52" aria-hidden="true">
            <circle class="loading-success-circle" cx="26" cy="26" r="23" fill="none" stroke-width="3"/>
            <polyline class="loading-success-check" points="14,27 22,35 38,18" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="loading-spinner" *ngIf="!errorMessage() && !generatingReport()"></div>
        <div class="loading-error-icon" *ngIf="errorMessage()">⚠</div>
        <p *ngIf="!errorMessage()">{{ progressMessage() || 'Aplicando filtros e baixando tabelas' }}</p>
        <p *ngIf="errorMessage()" class="loading-error-text">{{ errorMessage() }}</p>
        <button *ngIf="errorMessage()" type="button" class="loading-retry-btn" (click)="dismissError()">Fechar</button>
      </div>

      <ng-container *ngIf="filtersVisible()">
        <header class="report-filter-bar" [class.report-filter-bar-hidden]="reportBarHidden()">
          <div class="report-filter-groups">
            <div class="rf-chip" (click)="toggleDropdown('reportType', $event)">
              <span class="rf-chip-label">Tipo de Relatório</span>
              <span class="rf-chip-value">{{ reportTypeLabel() }}</span>
              <svg class="rf-chip-arrow" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <div class="rf-dropdown" *ngIf="openDropdownKey() === 'reportType'" (click)="$event.stopPropagation()">
                <div class="rf-dropdown-list">
                  <button *ngFor="let option of reportTypeOptions"
                          class="rf-dropdown-option"
                          [class.rf-dropdown-option-active]="reportType() === option.value"
                          type="button"
                          (click)="$event.stopPropagation(); updateReportType(option.value)">
                    <span class="rf-opt-check">
                      <svg *ngIf="reportType() === option.value" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5.5l3 3 7-7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </span>
                    {{ option.label }}
                  </button>
                </div>
              </div>
            </div>
            <div class="rf-chip" *ngFor="let filter of reportFilterStates(); trackBy: trackByReportFilterKey"
                 (click)="toggleDropdown(filter.key, $event)">
              <span class="rf-chip-label">{{ filter.title }}</span>
              <span class="rf-chip-value">{{ describeReportSelection(filter) }}</span>
              <svg class="rf-chip-arrow" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <div class="rf-dropdown" *ngIf="openDropdownKey() === filter.key" (click)="$event.stopPropagation()">
                <input *ngIf="filter.options.length > 8" class="rf-dropdown-search" type="text" placeholder="Buscar…"
                       [value]="dropdownSearch()" (input)="onDropdownSearch($event)" (click)="$event.stopPropagation()"/>
                <div class="rf-dropdown-list">
                  <button *ngFor="let option of filteredDropdownOptions(filter)"
                          class="rf-dropdown-option" [class.rf-dropdown-option-active]="isReportOptionSelected(filter, option)"
                          type="button" (click)="selectDropdownOption(filter.key, option, $event)">
                    <span class="rf-opt-check">
                      <svg *ngIf="isReportOptionSelected(filter, option)" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5.5l3 3 7-7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </span>
                    {{ option }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>

        <button
          *ngIf="!filterDrawerOpen()"
          type="button"
          class="filter-fab"
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
            <h2>Filtros de extração</h2>
            <button type="button" class="drawer-submit" (click)="submit()">
              {{ loading() ? 'Reaplicar' : 'Filtrar' }}
            </button>
          </div>

          <div class="drawer-body">

            <article class="drawer-card drawer-card-period">
              <div class="drawer-card-head">
                <h3>Período</h3>
              </div>

              <div class="period-shell">
                <div class="period-selects">
                  <ng-container *ngFor="let filter of periodFilters(); trackBy: trackByFilterKey">
                    <div class="select-shell">
                      <span class="select-caption">{{ filter.title }}</span>
                      <div class="option-list" role="listbox" [attr.aria-label]="filter.title" aria-multiselectable="true"
                        (mousemove)="dragScrollList(filter.key, $event)">
                        <button
                          type="button"
                          class="option-item"
                          *ngFor="let option of filter.options; trackBy: trackByOption"
                          [class.option-item-active]="isOptionSelected(filter, option)"
                          [attr.aria-selected]="isOptionSelected(filter, option)"
                          (mousedown)="beginOptionSelection(filter.key, option, $event)"
                          (mouseenter)="continueOptionSelection(filter.key, option, $event)"
                          (mouseup)="endFilterDrag()">
                          {{ option }}
                        </button>
                      </div>
                      <span class="select-summary">{{ describeSelection(filter) }}</span>
                    </div>
                  </ng-container>
                </div>

                <div class="day-range-shell">
                  <div class="range-summary-shell">
                    <span class="select-caption">Dia</span>
                    <div class="day-range-display">
                      <div>
                        <ng-container *ngIf="!multiMonthSelected(); else multiMinInput">
                          <input #minNumInput type="number" class="day-input" min="1" [max]="dayLimit()" [value]="resolvedDayRange().min" (change)="updateDayRangeFromInput('min', $event)" (keydown.enter)="$any($event.target).blur()" aria-label="Dia inicial" />
                        </ng-container>
                        <ng-template #multiMinInput>
                          <input type="text" class="day-input" [value]="dayMinLabel()" (change)="updateDayRangeFromText('min', $event)" (keydown.enter)="$any($event.target).blur()" aria-label="Dia inicial" placeholder="dd/mm" />
                        </ng-template>
                      </div>

                      <div>
                        <ng-container *ngIf="!multiMonthSelected(); else multiMaxInput">
                          <input #maxNumInput type="number" class="day-input" min="1" [max]="dayLimit()" [value]="resolvedDayRange().max" (change)="updateDayRangeFromInput('max', $event)" (keydown.enter)="$any($event.target).blur()" aria-label="Dia final" />
                        </ng-container>
                        <ng-template #multiMaxInput>
                          <input type="text" class="day-input" [value]="dayMaxLabel()" (change)="updateDayRangeFromText('max', $event)" (keydown.enter)="$any($event.target).blur()" aria-label="Dia final" placeholder="dd/mm" />
                        </ng-template>
                      </div>
                    </div>
                  </div>

                  <div class="dual-slider">
                    <!-- Track fill: driven directly by Angular, no CSS custom-property lag -->
                    <div #sliderFill class="dual-slider-fill"
                         [style.left.%]="fillLeft()"
                         [style.width.%]="fillWidth()"></div>
                    <input #sliderThumbMin type="range" min="1" [max]="sliderTotal()" step="1" [value]="sliderMin()" (input)="updateDayRangeSlider('min', $event)" [style.z-index]="dayRangeMinOnTop() ? 3 : 2" aria-label="Dia inicial" />
                    <input #sliderThumbMax type="range" min="1" [max]="sliderTotal()" step="1" [value]="sliderMax()" (input)="updateDayRangeSlider('max', $event)" [style.z-index]="dayRangeMinOnTop() ? 2 : 3" aria-label="Dia final" />
                  </div>
                </div>
              </div>
            </article>

            <article class="drawer-card" *ngFor="let filter of secondaryFilters(); trackBy: trackByFilterKey">
              <div class="drawer-card-head">
                <h3>{{ filter.title }}</h3>
              </div>

              <span class="select-caption">Valor ativo</span>
              <div class="option-list" role="listbox" [attr.aria-label]="filter.title" aria-multiselectable="true"
                (mousemove)="dragScrollList(filter.key, $event)">
                <button
                  type="button"
                  class="option-item"
                  *ngFor="let option of filter.options; trackBy: trackByOption"
                  [class.option-item-active]="isOptionSelected(filter, option)"
                  [attr.aria-selected]="isOptionSelected(filter, option)"
                  (mousedown)="beginOptionSelection(filter.key, option, $event)"
                  (mouseenter)="continueOptionSelection(filter.key, option, $event)"
                  (mouseup)="endFilterDrag()">
                  {{ option }}
                </button>
              </div>
              <span class="select-summary">{{ describeSelection(filter) }}</span>
            </article>
          </div>
        </aside>

        <section class="workspace-stage">
          <ng-container *ngIf="reportData() as report">

            <!-- Hero header -->
            <div class="rpt-hero anim-el">
              <div class="rpt-hero-left">
                <h1 class="rpt-hero-title">Relatório Analítico</h1>
                <span class="rpt-hero-meta">Gerado em {{ report.generatedAt | date:'dd/MM/yyyy HH:mm' }}</span>
                <span *ngIf="periodRangeLabel()" class="rpt-hero-meta">Período de referência: {{ periodRangeLabel() }}</span>
                <span class="rpt-hero-author">Autor: Alysson Pinheiro &mdash; Analista de Dados</span>
              </div>

              <div class="rpt-hero-actions" style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
                <button class="rpt-export-btn" (click)="openExportModal()">Exportar PDF</button>
              </div>
            </div>

            <!-- Export Modal -->
            <div class="export-modal-backdrop" *ngIf="exportModalOpen()" (click)="closeExportModal()"></div>
            <div class="export-modal" *ngIf="exportModalOpen()" role="dialog" aria-modal="true">
              <div class="export-modal-header">
                <div class="export-modal-title-row">
                  <button *ngIf="exportModalStep() === 'bases'" class="export-modal-back" (click)="exportModalStep.set('mode')" aria-label="Voltar">← Voltar</button>
                  <h3 class="export-modal-title">
                    {{ exportModalStep() === 'mode' ? 'Exportar Relatório PDF' : (exportModeType() === 'proprias' ? 'Próprias' : 'Parceiras') + ' — Selecione a Base' }}
                  </h3>
                </div>
                <button class="export-modal-close" (click)="closeExportModal()" aria-label="Fechar">✕</button>
              </div>

              <!-- Step 1: choose export type -->
              <ng-container *ngIf="exportModalStep() === 'mode'">
                <p class="export-modal-desc">Escolha o tipo de exportação. <strong>⬇ Baixar</strong> salva direto na pasta Downloads. <strong>📤 Compartilhar</strong> gera o PDF e abre o painel de compartilhamento do Windows.</p>

                <!-- Loading overlay durante geração via API -->
                <div class="export-loading-row" *ngIf="exportLoading()">
                  <span class="export-loading-spinner"></span>
                  <span>Gerando relatórios... aguarde.</span>
                </div>
                <div class="export-error-row" *ngIf="exportError()">{{ exportError() }}</div>

                <div style="margin-top: 10px; margin-bottom: 15px; display: flex; align-items: center; gap: 8px;">
                  <label style="position: relative; display: inline-block; width: 36px; height: 20px; margin: 0; cursor: pointer;">
                    <input type="checkbox" style="opacity: 0; width: 0; height: 0; position: absolute;" id="attentionToggle" [checked]="includeAttentionMessage()" (change)="includeAttentionMessage.set(!includeAttentionMessage())" />
                    <span style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; transition: .3s; border-radius: 20px;"
                          [style.background-color]="includeAttentionMessage() ? '#007bff' : '#ccc'">
                      <span style="position: absolute; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%;"
                            [style.transform]="includeAttentionMessage() ? 'translateX(16px)' : 'translateX(0)'"></span>
                    </span>
                  </label>
                  <label for="attentionToggle" style="font-weight: 500; font-size: 14px; cursor: pointer; user-select: none;">enviar com mensagem de atenção</label>
                </div>

                <div class="export-modal-options" [class.export-modal-options--disabled]="exportLoading()">

                  <div class="export-option-row">
                    <div class="export-option-info">
                      <span class="export-option-icon">📄</span>
                      <div class="export-option-body">
                        <span class="export-option-title">Relatório Atual</span>
                        <span class="export-option-sub">PDF com todos os dados do relatório atual.</span>
                      </div>
                    </div>
                    <div class="export-option-actions">
                      <button class="export-action-btn export-action-btn--download" (click)="exportWithMode('current', false)" [disabled]="exportLoading()" title="Baixar PDF">
                        ⬇ Baixar
                      </button>
                      <button class="export-action-btn export-action-btn--share"
                        (click)="shareMode('current')"
                        [disabled]="!!shareModeLoading()" title="Compartilhar via Windows">
                        {{ shareModeLoading() === 'current' ? '⏳ Preparando...' : '📤 Compartilhar' }}
                      </button>
                    </div>
                  </div>

                  <div class="export-option-row">
                    <div class="export-option-info">
                      <span class="export-option-icon">🏢</span>
                      <div class="export-option-body">
                        <span class="export-option-title">Relatório Próprias</span>
                        <span class="export-option-sub" *ngIf="availablePropriasBases.length > 0">{{ availablePropriasBases.length }} {{ availablePropriasBases.length === 1 ? 'PDF' : 'PDFs' }} (1 por base) — equipes próprias ({{ availablePropriasBases.join(', ') }}).</span>
                        <span class="export-option-sub" *ngIf="availablePropriasBases.length === 0">Nenhuma equipe própria disponível nos dados.</span>
                      </div>
                    </div>
                    <div class="export-option-actions">
                      <button class="export-action-btn export-action-btn--download" (click)="exportWithMode('proprias', false)" [disabled]="exportLoading()" title="Baixar PDFs">
                        ⬇ Baixar
                      </button>
                      <button class="export-action-btn export-action-btn--share"
                        (click)="shareMode('proprias')"
                        [disabled]="!!shareModeLoading()" title="Compartilhar via Windows">
                        {{ shareModeLoading() === 'proprias' ? '⏳ Preparando...' : '📤 Compartilhar' }}
                      </button>
                    </div>
                  </div>

                  <div class="export-option-row">
                    <div class="export-option-info">
                      <span class="export-option-icon">🤝</span>
                      <div class="export-option-body">
                        <span class="export-option-title">Relatório Parceiras</span>
                        <span class="export-option-sub" *ngIf="availableParceirasBases.length > 0">{{ availableParceirasBases.length }} {{ availableParceirasBases.length === 1 ? 'PDF' : 'PDFs' }} (1 por base) — equipes parceiras ({{ availableParceirasBases.join(', ') }}).</span>
                        <span class="export-option-sub" *ngIf="availableParceirasBases.length === 0">Nenhuma equipe parceira disponível nos dados.</span>
                      </div>
                    </div>
                    <div class="export-option-actions">
                      <button class="export-action-btn export-action-btn--download" (click)="exportWithMode('parceiras', false)" [disabled]="exportLoading()" title="Baixar PDFs">
                        ⬇ Baixar
                      </button>
                      <button class="export-action-btn export-action-btn--share"
                        (click)="shareMode('parceiras')"
                        [disabled]="!!shareModeLoading()" title="Compartilhar via Windows">
                        {{ shareModeLoading() === 'parceiras' ? '⏳ Preparando...' : '📤 Compartilhar' }}
                      </button>
                    </div>
                  </div>

                </div>
              </ng-container>

              <!-- Step 2: select base -->
              <ng-container *ngIf="exportModalStep() === 'bases'">
                <p class="export-modal-desc">Clique em cada base para abrir o PDF correspondente. No diálogo do navegador escolha "Salvar como PDF".</p>
                <div class="export-base-grid">
                  <button class="export-base-card" *ngFor="let base of (exportModeType() === 'proprias' ? availablePropriasBases : availableParceirasBases)" (click)="exportBase(base)">
                    <div class="export-base-card-top">
                      <span class="export-base-name">{{ base }}</span>
                      <span class="export-base-prefix">{{ exportModeType() === 'proprias' ? reportBasePrefixMap[base].own : reportBasePrefixMap[base].partner }}</span>
                    </div>
                    <span class="export-base-action">Abrir PDF →</span>
                  </button>
                </div>
              </ng-container>

            </div>

            <!-- ======= MODO OPERACIONAL ======= -->
            <ng-container *ngIf="reportType() === 'operacional'">

            <!-- TOC Scroll Spy sidebar -->
            <app-toc-nav [kpis]="report.kpis" />

            <!-- Executive Summary -->
            <div class="exec-summary anim-el" *ngIf="report.executiveSummary as es">

              <!-- Row 1: stat counters -->
              <div class="exec-stats-row">
                <div class="exec-stat">
                  <span class="exec-stat-value">{{ es.totalTeams }}</span>
                  <span class="exec-stat-label">Equipes</span>
                </div>
                <div class="exec-stat-divider"></div>
                <div class="exec-stat" *ngIf="es.periodDays > 0">
                  <span class="exec-stat-value">{{ es.periodDays }}</span>
                  <span class="exec-stat-label">Dias analisados</span>
                </div>
                <div class="exec-stat-divider" *ngIf="es.periodDays > 0"></div>
                <div class="exec-stat">
                  <span class="exec-stat-value exec-stat-value--alert">{{ es.kpiAlerts.length }}</span>
                  <span class="exec-stat-label">KPIs em alerta</span>
                </div>
                <div class="exec-stat-divider"></div>
                <div class="exec-stat">
                  <span class="exec-stat-value exec-stat-value--alert">{{ es.teamsBelowMetaCount }}</span>
                  <span class="exec-stat-label">Equipes críticas</span>
                </div>
              </div>

              <!-- Row 2: KPI alerts -->
              <div class="exec-kpi-alerts" *ngIf="es.kpiAlerts.length > 0">
                <div class="exec-kpi-row" *ngFor="let alert of es.kpiAlerts">
                  <span class="exec-kpi-name">{{ alert.kpi }}</span>
                  <div class="exec-kpi-bar-wrap">
                    <div class="exec-kpi-bar" [style.width.%]="(alert.teamsBelowMeta / es.totalTeams) * 100"></div>
                  </div>
                  <span class="exec-kpi-count">{{ alert.teamsBelowMeta }}/{{ es.totalTeams }}</span>
                  <span class="exec-kpi-worst">crítico: <strong>{{ alert.worst.team }}</strong> ({{ alert.worst.value }})</span>
                </div>
              </div>

              <!-- Row 3: highlights + top issues -->
              <div class="exec-footer-row">
                <div class="exec-badges-horizontal">
                  <span class="exec-badges-label">ALERTAS</span>
                  <div class="exec-badges">
                    <div class="exec-badge exec-badge--yellow" *ngIf="es.idleHighlight">
                      <span>⏳</span><span>{{ es.idleHighlight }}</span>
                    </div>
                    <div class="exec-badge exec-badge--red" *ngIf="es.retornoBaseAlertCount > 0">
                      <span>⚠</span><span>{{ es.retornoBaseAlertCount }} eq. Retorno Base > meta</span>
                    </div>
                    <div class="exec-badge exec-badge--red" *ngIf="es.tmeImpAlertCount > 0">
                      <span>⚠</span><span>{{ es.tmeImpAlertCount }} eq. TME IMP > meta</span>
                    </div>
                  </div>
                </div>
                <div class="exec-top-issues" *ngIf="es.topActionIssues.length > 0">
                  <span class="exec-top-issues-label">Recorrentes</span>
                  <span class="exec-issue-tag" *ngFor="let issue of es.topActionIssues" [title]="issue">{{ issue.split(':')[0] }}</span>
                </div>
              </div>

            </div>

            <!-- KPI sections with bar charts -->
            <ng-container *ngIf="report.kpis.length > 0">
              <section class="kpi-section anim-el" [id]="'kpi-' + i" *ngFor="let kpi of report.kpis; let i = index">
                <div class="kpi-section-header">
                  <div class="kpi-title-row">
                    <h2 class="kpi-name">{{ kpi.kpi }}</h2>
                    <span class="kpi-dir-badge"
                          [class.kpi-dir-badge--up]="kpi.direction === 'higher-is-better'"
                          [class.kpi-dir-badge--down]="kpi.direction !== 'higher-is-better'">
                      {{ kpi.direction === 'higher-is-better' ? '↑ Maior é melhor' : '↓ Menor é melhor' }}
                    </span>
                  </div>
                  <div class="kpi-chips">
                    <span class="kpi-chip">Meta <strong>{{ kpi.metaTarget }}</strong></span>
                    <span class="kpi-chip">Média <strong>{{ kpi.average }}</strong></span>
                  </div>
                </div>
                <div class="kpi-chart-block">
                  <div class="kpi-chart-group-label kpi-group-good" *ngIf="kpi.topTeams.length > 0">🏆 Top Performers</div>
                  <div class="kpi-cr kpi-cr--good" *ngFor="let t of kpi.topTeams; let i = index">
                    <span class="kpi-cr-pos">{{ i + 1 }}</span>
                    <span class="kpi-cr-team">{{ t.team }}</span>
                    <div class="kpi-cr-track">
                      <div class="kpi-cr-fill kpi-cr-fill--good" [style.width.%]="barWidthPct(t.value, kpi.kpi, kpi)"></div>
                      <div class="kpi-cr-meta-line" [style.left.%]="kpiMetaPct(kpi.kpi, kpi.metaTarget, kpi)"></div>
                    </div>
                    <span class="kpi-cr-val">{{ t.value }}</span>
                  </div>
                  <div class="kpi-cr kpi-cr--avg">
                    <span class="kpi-cr-pos">—</span>
                    <span class="kpi-cr-team kpi-cr-team--avg">Média geral</span>
                    <div class="kpi-cr-track">
                      <div class="kpi-cr-fill kpi-cr-fill--avg" [style.width.%]="barWidthPct(kpi.average, kpi.kpi, kpi)"></div>
                      <div class="kpi-cr-meta-line" [style.left.%]="kpiMetaPct(kpi.kpi, kpi.metaTarget, kpi)"></div>
                    </div>
                    <span class="kpi-cr-val kpi-cr-val--avg">{{ kpi.average }}</span>
                  </div>
                  <div class="kpi-chart-group-label kpi-group-opp" *ngIf="kpi.opportunityTeams.length > 0">⚠ Oportunidade</div>
                  <div class="kpi-cr kpi-cr--opp" *ngFor="let t of kpi.opportunityTeams; let i = index">
                    <span class="kpi-cr-pos">{{ i + 1 }}</span>
                    <span class="kpi-cr-team">{{ t.team }}</span>
                    <div class="kpi-cr-track">
                      <div class="kpi-cr-fill kpi-cr-fill--bad" [style.width.%]="barWidthPct(t.value, kpi.kpi, kpi)"></div>
                      <div class="kpi-cr-meta-line" [style.left.%]="kpiMetaPct(kpi.kpi, kpi.metaTarget, kpi)"></div>
                    </div>
                    <span class="kpi-cr-val kpi-cr-val--opp">{{ t.value }}</span>
                  </div>
                </div>
                <!-- OS/Dia drill-down (3 abaixo do padrão) -->
                <ng-container *ngIf="kpi.kpi === 'OS Dia'">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — 3 Abaixo do Padrão
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.4 - CE M300</span>
                  </div>
                  <ng-container *ngIf="report.specialAnalysis.osDiaAnalysis && report.specialAnalysis.osDiaAnalysis.length > 0; else noOsDiaAnalysis">
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of filterOsDiaEvidence(report.specialAnalysis.osDiaAnalysis)">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}</span>
                        <span class="rpt-osdia-badge rpt-osdia-badge--gap">Gap {{ analysis.gap | number:'1.1-1' }} OS/dia</span>
                        <button class="export-png-btn" (click)="exportTeamCardToPng($event, analysis.team)" title="Copiar imagem">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>
                          </svg>
                        </button>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">OS/Dia <strong>{{ analysis.osDiaValue }}</strong></span>
                        <span class="rpt-osdia-chip">Meta <strong>{{ analysis.metaTarget }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTrExceeds > 0">
                          Temp. Reparo&gt;20% HD: <strong>{{ analysis.summary.countTrExceeds }}</strong>
                        </span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTlExceeds > 0">
                          Temp. Desloc.: <strong>{{ analysis.summary.countTlExceeds }}</strong>
                        </span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTempPrepAlto > 0">
                          Temp. Partida≥10min: <strong>{{ analysis.summary.countTempPrepAlto }}</strong>
                        </span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countSemOsAlto > 0">
                          SemOS≥10min: <strong>{{ analysis.summary.countSemOsAlto }}</strong>
                        </span>
                        <span class="rpt-osdia-chip">Total OS: <strong>{{ analysis.totalOrders }} em {{ analysis.totalJornadas }} dias</strong></span>
                        <span class="rpt-osdia-chip">Ocioso: <strong>{{ calcIdleMin(analysis) | number:'1.0-0' }} min — {{ analysis.idleDays }} dias</strong></span>
                      </div>
                      <!-- Card único de warnings: ociosidade + ordens flagadas -->
                      <ng-container *ngIf="analysis.idleAnalysis || analysis.flaggedOrders.length > 0; else noOsDiaEvidence">
                        <div class="osdia-idle-notice">
                          <!-- Ociosidade -->
                          <ng-container *ngIf="analysis.idleAnalysis">
                            <div class="osdia-idle-header">
                              <span class="osdia-idle-icon">⚠️</span>
                              <strong>Ociosidade elevada — {{ analysis.idleAnalysis.idlePct | number:'1.1-1' }}% da jornada sem trabalho registrado</strong>
                            </div>
                            <div class="osdia-idle-metrics">
                              <span class="osdia-idle-chip osdia-idle-chip--hd">HD {{ analysis.totalJornadas === 1 ? 'Total' : 'Médio/dia' }} <strong>{{ analysis.hdTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--prep">Temp. Partida {{ analysis.totalJornadas === 1 ? 'Total' : 'Médio/dia' }} <strong>{{ analysis.tempPrepTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--sem">SemOrdem {{ analysis.totalJornadas === 1 ? 'Total' : 'Médio/dia' }} <strong>{{ analysis.semOrdemTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--idle">Ocioso {{ analysis.totalJornadas === 1 ? 'Total' : 'Médio/dia' }} <strong>{{ analysis.idleAnalysis.idleMin | number:'1.0-0' }} min ({{ analysis.idleAnalysis.idlePct | number:'1.1-1' }}%) — limite: 10%</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--he" *ngIf="analysis.idleAnalysis!.horasExtras! > 0">Horas Extras {{ analysis.totalJornadas === 1 ? 'Total' : 'Méd/dia' }} <strong>{{ analysis.idleAnalysis!.horasExtras | number:'1.0-0' }} min</strong></span>
                            </div>
                          </ng-container>
                          <!-- Ordens flagadas agrupadas por data referência -->
                          <div class="osdia-ev-list" *ngIf="analysis.flaggedOrders.length > 0">
                            <ng-template #osDiaEvTpl let-ev>
                              <div class="osdia-ev-header">
                                <span class="osdia-ev-ordem">OS {{ ev.nr_ordem }}</span>
                                <span class="rpt-osdia-badge rpt-osdia-badge--first" *ngIf="!ev.prev_liberada">1ª OS</span>
                                <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ osDiaFlagLabel(f) }}</span>
                                <span class="rpt-osdia-flag" *ngIf="entreOsAfterIntervalo(ev)">Entre OS≥10min</span>
                                <span class="rpt-osdia-flag" *ngIf="getOciosoTotal(ev) != null">Ocioso: {{ getOciosoTotal(ev) | number:'1.0-0' }} min</span>
                              </div>
                              <p class="osdia-ev-causa" *ngIf="ev.classe || ev.causa || evDespAfterPrevLib(ev)">
                                <span *ngIf="ev.classe"><strong>Classe:</strong> {{ ev.classe }}</span>
                                <span class="osdia-ev-causa-sep" *ngIf="ev.classe && ev.causa"> · </span>
                                <span *ngIf="ev.causa"><strong>Causa:</strong> {{ ev.causa }}</span>
                                <ng-container *ngIf="evDespAfterPrevLib(ev) as despTime">
                                  <span class="osdia-ev-causa-sep" *ngIf="ev.classe || ev.causa"> · </span>
                                  <span><strong>Desp.:</strong> {{ despTime }}</span>
                                </ng-container>
                              </p>
                              <app-timeline-visual [ev]="ev"></app-timeline-visual>
                              <ul class="osdia-ev-alerts">
                                <li *ngIf="ev.flags.includes('tr_excede_hd')" class="osdia-ev-alert">
                                  <strong>Tempo de Reparo alto:</strong> <span [innerHTML]="highlightMin(osDiaAlertBody('tr_excede_hd', ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('tl_excede_hd')" class="osdia-ev-alert">
                                  <strong>Tempo de Deslocamento alto:</strong> <span [innerHTML]="highlightMin(osDiaAlertBody('tl_excede_hd', ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('temp_prep_alto')" class="osdia-ev-alert">
                                  <strong>Tempo de Partida/OS:</strong> <span [innerHTML]="highlightMin(tempPrepAltoText(ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('triagem_alto')" class="osdia-ev-alert">
                                  <strong>2º Desp. | Prioritário:</strong> <span [innerHTML]="highlightMin(triagemAltoText(ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('primeiro_desloc_alto')" class="osdia-ev-alert">
                                  <strong>1º Desloc.:</strong> <span [innerHTML]="highlightMin(ev.alertTexts?.['primeiro_desloc_alto'] ?? '')"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('sem_os_alto') || entreOsAfterIntervalo(ev)" class="osdia-ev-alert">
                                  <strong>Sem Ordem/OS:</strong> <span [innerHTML]="highlightMin(osDiaAlertBody('sem_os_alto', ev))"></span>
                                  <ol class="osdia-sem-os-list">
                                    <li *ngFor="let d of alertSemOsDetails(ev.sem_os_details)"><em class="osdia-sem-os-label">{{ semOsDetailLabel(d, ev.nr_ordem_despacho_anterior) }}:</em> <span [innerHTML]="highlightMin(semOsDetailBody(d, ev.nr_ordem_despacho_anterior))"></span></li>
                                    <li *ngIf="entreOsAfterIntervalo(ev) as eo"><em class="osdia-sem-os-label">Entre OS:</em> <span [innerHTML]="highlightMin(formatEntreOsText(eo))"></span></li>
                                  </ol>
                                </li>
                                
                                
                                <li *ngIf="ev.nr_ordem_despacho_anterior" class="osdia-ev-alert osdia-ev-alert--warn">
                                  <strong>Despacho anterior da 1ªOS:</strong> a OS <strong>{{ ev.nr_ordem_despacho_anterior }}</strong> foi despachada em {{ formatDespachoHora(ev.hora_despacho_anterior) }} antes do deslocamento da 1ª OS desta equipe, provavelmente por motivo de prioridade, dessa forma o despacho da 1ªOS pode ficar elevado.
                                </li>
                              </ul>
                            </ng-template>
                            <ng-container *ngFor="let grp of allDateGroupsForKpi(analysis.flaggedOrders || [], []); trackBy: trackByDateRef">
                              <div class="ev-date-group-header">{{ grp.dateRef }}</div>
                              <div class="osdia-ev-item" *ngFor="let ev of grp.items">
                                <ng-container *ngTemplateOutlet="osDiaEvTpl; context: {$implicit: ev}"></ng-container>
                              </div>
                            </ng-container>
                            <ng-container *ngIf="analysis.extraFlaggedOrders?.length">
                              <button class="ev-ver-mais-btn team-ver-mais" style="background-color: lightblue; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-top: 10px; width: 100%; text-align: center; font-weight: bold;" (click)="toggleTeamExpanded('OS Dia', analysis.team)">
                                {{ isTeamExpanded('OS Dia', analysis.team) ? '▲ Ver menos' : '▼ Ver mais ' + (analysis.extraFlaggedOrders?.length || 0) + ' OS(s) com baixo tempo' }}
                              </button>
                              <div *ngIf="isTeamExpanded('OS Dia', analysis.team)" class="extra-orders-container" style="margin-top: 15px; border-top: 1px dashed #ccc; padding-top: 10px;">
                                <ng-container *ngFor="let grp of allDateGroupsForKpi(analysis.extraFlaggedOrders || [], []); trackBy: trackByDateRef">
                                  <div class="ev-date-group-header" style="opacity: 0.8">{{ grp.dateRef }} (Extra)</div>
                                  <div class="osdia-ev-item osdia-ev-item--extra" *ngFor="let ev of grp.items">
                                    <ng-container *ngTemplateOutlet="osDiaEvTpl; context: {$implicit: ev}"></ng-container>
                                  </div>
                                </ng-container>
                              </div>
                            </ng-container>
                          </div>
                        </div>
                      </ng-container>
                      <ng-template #noOsDiaEvidence>
                        <p class="rpt-no-data">Nenhuma ordem com alertas nos dados filtrados.</p>
                      </ng-template>
                    </div>
                  </div>
                  </ng-container>
                  <ng-template #noOsDiaAnalysis>
                    <p class="kpi-meta-ok">✅ Todas as equipes atingiram a meta esperada.</p>
                  </ng-template>
                </ng-container>
                <!-- Eficiência drill-down (evidências de incidências) -->
                <ng-container *ngIf="kpi.kpi === 'Eficiência' && kpi.evidenceAnalysis && kpi.evidenceAnalysis.length > 0">                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Top 3 e 3 Abaixo do Padrão
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.4 - CE M300</span>
                  </div>
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of sortedEficienciaAnalysis(kpi.evidenceAnalysis)">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}</span>
                        <span class="rpt-osdia-badge"
                              [class.rpt-osdia-badge--gap]="analysis.analysisType === 'underperformer'"
                              [class.rpt-osdia-badge--good]="analysis.analysisType === 'top_performer'">
                          {{ analysis.eficienciaValue }}% efic.
                        </span>
                        <button class="export-png-btn" (click)="exportTeamCardToPng($event, analysis.team)" title="Copiar imagem">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>
                          </svg>
                        </button>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">Média <strong>{{ analysis.averageEficiencia }}%</strong></span>
                        <span class="rpt-osdia-chip">TL Médio <strong>{{ analysis.avgDeslocamentoMin | number:'1.0-0' }} min</strong></span>
                        <span class="rpt-osdia-chip">TR Médio <strong>{{ analysis.avgExecucaoMin | number:'1.0-0' }} min</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.avgTempoPadraoMin > 0">T. Padrão Médio <strong>{{ analysis.avgTempoPadraoMin | number:'1.0-0' }} min</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countDeslocamentoCurto > 0">
                          TL Curto: <strong>{{ analysis.summary.countDeslocamentoCurto }}</strong>
                        </span>
                      </div>
                      <!-- Card único de warnings -->
                      <ng-container *ngIf="analysis.flaggedOrders.length > 0 || (analysis.tempoPadraoVazioOrders && analysis.tempoPadraoVazioOrders.length > 0); else noEficienciaEvidence">
                        <div class="osdia-idle-notice">
                          <div class="osdia-idle-header">
                            <span class="osdia-idle-icon">⚠️</span>
                            <strong>Alertas detectados</strong>
                          </div>

                          <!-- Flags de equipe -->
                          <div class="osdia-idle-metrics" *ngIf="analysis.flags.length > 0">
                            <span class="osdia-idle-chip osdia-idle-chip--hd">TL Global <strong>{{ analysis.globalAvgDeslocamentoMin | number:'1.0-0' }} min</strong></span>
                            <span class="osdia-idle-chip osdia-idle-chip--prep">TR Global <strong>{{ analysis.globalAvgExecucaoMin | number:'1.0-0' }} min</strong></span>
                            <span class="osdia-idle-chip osdia-idle-chip--idle" *ngIf="analysis.flags.includes('short_displacement')">
                              TL curto: <strong>{{ analysis.avgDeslocamentoMin | number:'1.0-0' }} min (≤ {{ (analysis.globalAvgDeslocamentoMin * 0.25) | number:'1.0-0' }} min — 25% global)</strong>
                            </span>
                          </div>

                          <!-- Ordens flagadas (TR>HD, Desloc. Curto) agrupadas por data referência -->
                          <div class="osdia-ev-list" *ngIf="analysis.flaggedOrders.length > 0">
                            <ng-template #eficienciaEvTpl let-ev>
                              <div class="osdia-ev-header">
                                <span class="osdia-ev-ordem">OS {{ ev.nr_ordem }}</span>
                                <span class="rpt-osdia-badge rpt-osdia-badge--first" *ngIf="!ev.prev_liberada">1ª OS</span>
                                <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ eficienciaFlagLabel(f) }}</span>
                              </div>
                              <p class="osdia-ev-causa" *ngIf="ev.classe || ev.causa || evDespAfterPrevLib(ev)">
                                <span *ngIf="ev.classe"><strong>Classe:</strong> {{ ev.classe }}</span>
                                <span class="osdia-ev-causa-sep" *ngIf="ev.classe && ev.causa"> · </span>
                                <span *ngIf="ev.causa"><strong>Causa:</strong> {{ ev.causa }}</span>
                                <ng-container *ngIf="evDespAfterPrevLib(ev) as despTime">
                                  <span class="osdia-ev-causa-sep" *ngIf="ev.classe || ev.causa"> · </span>
                                  <span><strong>Desp.:</strong> {{ despTime }}</span>
                                </ng-container>
                              </p>
                              <app-timeline-visual [ev]="ev" [hidePartida]="true" [trimToACaminho]="true"></app-timeline-visual>
                              <ul class="osdia-ev-alerts">
                                <li *ngIf="ev.flags.includes('tr_muito_baixo')" class="osdia-ev-alert">
                                  <strong>Tempo de Reparo muito baixo:</strong> <span [innerHTML]="highlightMin(eficienciaAlertBody('tr_muito_baixo', ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('deslocamento_curto')" class="osdia-ev-alert">
                                  <strong>Deslocamento (TL) muito curto:</strong> <span [innerHTML]="highlightMin(eficienciaAlertBody('deslocamento_curto', ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('tr_excede_hd')" class="osdia-ev-alert">
                                  <strong>Tempo de Reparo alto:</strong> <span [innerHTML]="highlightMin(eficienciaAlertBody('tr_excede_hd', ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('tempo_padrao_vazio')" class="osdia-ev-alert">
                                  <strong>Tempo Padrão ausente:</strong> <span [innerHTML]="highlightMin(eficienciaAlertBody('tempo_padrao_vazio', ev))"></span>
                                </li>
                              </ul>
                            </ng-template>
                            <ng-container *ngFor="let grp of allDateGroupsForKpi(analysis.flaggedOrders, undefined); trackBy: trackByDateRef">
                              <div class="ev-date-group-header">{{ grp.dateRef }}</div>
                              <div class="osdia-ev-item" *ngFor="let ev of grp.items">
                                <ng-container *ngTemplateOutlet="eficienciaEvTpl; context: {$implicit: ev}"></ng-container>
                              </div>
                            </ng-container>
                            <ng-container *ngIf="analysis.extraFlaggedOrders?.length">
                              <button class="ev-ver-mais-btn team-ver-mais" style="background-color: lightblue; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-top: 10px; width: 100%; text-align: center; font-weight: bold;" (click)="toggleTeamExpanded('Eficiência', analysis.team)">
                                {{ isTeamExpanded('Eficiência', analysis.team) ? '▲ Ver menos' : '▼ Ver mais ' + (analysis.extraFlaggedOrders?.length || 0) + ' OS(s) com baixo tempo' }}
                              </button>
                              <div *ngIf="isTeamExpanded('Eficiência', analysis.team)" class="extra-orders-container" style="margin-top: 15px; border-top: 1px dashed #ccc; padding-top: 10px;">
                                <ng-container *ngFor="let grp of allDateGroupsForKpi(analysis.extraFlaggedOrders || [], []); trackBy: trackByDateRef">
                                  <div class="ev-date-group-header" style="opacity: 0.8">{{ grp.dateRef }} (Extra)</div>
                                  <div class="osdia-ev-item osdia-ev-item--extra" *ngFor="let ev of grp.items">
                                    <ng-container *ngTemplateOutlet="eficienciaEvTpl; context: {$implicit: ev}"></ng-container>
                                  </div>
                                </ng-container>
                              </div>
                            </ng-container>
                          </div>

                          <!-- Simulação: equipe penalizada por T.Padrão ausente -->
                          <ng-container *ngIf="analysis.summary.countTempoPadraoVazio > 0">
                            <p class="osdia-idle-desc">
                              <strong>Equipe penalizada por ausência de Tempo Padrão:</strong>
                              {{ analysis.summary.countTempoPadraoVazio }} ordem(ns) sem tempo padrão cadastrado. O sistema calcula a eficiência como <em>Tempo Padrão / TR</em>, portanto ordens vazias contam como zero, prejudicando o resultado.<ng-container *ngIf="analysis.simulatedEficiencia !== undefined && analysis.simulatedEficiencia !== null">
                              <br><strong>Simulação:</strong> se usassem o TR médio global ({{ analysis.globalAvgExecucaoMin | number:'1.0-0' }} min), a eficiência estimada seria
                              <strong>{{ analysis.simulatedEficiencia | number:'1.1-1' }}%</strong>
                              vs. atual <strong>{{ analysis.eficienciaValue }}%</strong>.</ng-container>
                            </p>
                          </ng-container>

                        </div>
                      </ng-container>
                      <ng-template #noEficienciaEvidence>
                        <p class="rpt-no-data">Nenhuma ordem com alertas nos dados filtrados.</p>
                      </ng-template>
                    </div>
                  </div>
                </ng-container>
                <!-- Eficiência: all teams at meta -->
                <ng-container *ngIf="kpi.kpi === 'Eficiência' && (!kpi.evidenceAnalysis || kpi.evidenceAnalysis.length === 0)">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Top 3 e 3 Abaixo do Padrão
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.4 - CE M300</span>
                  </div>
                  <p class="kpi-meta-ok">✅ Todas as equipes atingiram a meta esperada.</p>
                </ng-container>
                <!-- Utilização drill-down (3 abaixo do padrão) -->
                <ng-container *ngIf="kpi.kpi === 'Utilização' && report.specialAnalysis.utilizacaoAnalysis && report.specialAnalysis.utilizacaoAnalysis.length > 0">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — 3 Abaixo do Padrão
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of filterOsDiaEvidence(report.specialAnalysis.utilizacaoAnalysis)">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}<ng-container *ngIf="isTeamInBottomOsDia(analysis.team)"> *</ng-container></span>
                        <span class="rpt-osdia-badge rpt-osdia-badge--gap">Gap {{ analysis.gap | number:'1.1-1' }}%</span>
                        <button class="export-png-btn" (click)="exportTeamCardToPng($event, analysis.team)" title="Copiar imagem">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                        </button>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">Utilização <strong>{{ analysis.utilizacaoValue }}%</strong></span>
                        <span class="rpt-osdia-chip">Meta <strong>{{ analysis.metaTarget }}%</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTempPrepAlto > 0">
                          Temp. Partida≥10min: <strong>{{ analysis.summary.countTempPrepAlto }}</strong>
                        </span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countSemOsAlto > 0">
                          SemOS≥10min: <strong>{{ analysis.summary.countSemOsAlto }}</strong>
                        </span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.jornadasAbaixoMeta > 0">
                          Jornadas &lt; meta: <strong>{{ analysis.jornadasAbaixoMeta }}/{{ analysis.totalJornadas }}</strong>
                        </span>
                        <span class="rpt-osdia-chip">Total OS: <strong>{{ analysis.totalOrders }} em {{ analysis.totalJornadas }} dias</strong></span>
                        <span class="rpt-osdia-chip">Ocioso: <strong>{{ calcIdleMin(analysis) | number:'1.0-0' }} min — {{ analysis.idleDays }} dias</strong></span>
                      </div>
                      <!-- Card único de warnings: ociosidade + ordens flagadas -->
                      <ng-container *ngIf="analysis.idleAnalysis || analysis.flaggedOrders.length > 0; else noUtilizacaoEvidence">
                        <div class="osdia-idle-notice">
                          <!-- Ociosidade -->
                          <ng-container *ngIf="analysis.idleAnalysis">
                            <div class="osdia-idle-header">
                              <span class="osdia-idle-icon">⚠️</span>
                              <strong>Ociosidade elevada — {{ analysis.idleAnalysis.idlePct | number:'1.1-1' }}% da jornada sem trabalho registrado</strong>
                            </div>
                            <div class="osdia-idle-metrics">
                              <span class="osdia-idle-chip osdia-idle-chip--hd">HD {{ analysis.totalJornadas === 1 ? 'Total' : 'Médio/dia' }} <strong>{{ analysis.hdTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--prep">Temp. Partida {{ analysis.totalJornadas === 1 ? 'Total' : 'Médio/dia' }} <strong>{{ analysis.tempPrepTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--sem">SemOrdem {{ analysis.totalJornadas === 1 ? 'Total' : 'Médio/dia' }} <strong>{{ analysis.semOrdemTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--idle">Ocioso {{ analysis.totalJornadas === 1 ? 'Total' : 'Médio/dia' }} <strong>{{ analysis.idleAnalysis.idleMin | number:'1.0-0' }} min ({{ analysis.idleAnalysis.idlePct | number:'1.1-1' }}%) — limite: 10%</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--he" *ngIf="analysis.idleAnalysis!.horasExtras! > 0">Horas Extras {{ analysis.totalJornadas === 1 ? 'Total' : 'Méd/dia' }} <strong>{{ analysis.idleAnalysis!.horasExtras | number:'1.0-0' }} min</strong></span>
                            </div>
                          </ng-container>
                          <!-- Ordens flagadas agrupadas por data referência -->
                          <div class="osdia-ev-list" *ngIf="analysis.flaggedOrders.length > 0">
                            <ng-template #utilizacaoEvTpl let-ev>
                              <div class="osdia-ev-header">
                                <span class="osdia-ev-ordem">OS {{ ev.nr_ordem }}</span>
                                <span class="rpt-osdia-badge rpt-osdia-badge--first" *ngIf="!ev.prev_liberada">1ª OS</span>
                                <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ osDiaFlagLabel(f) }}</span>
                                <span class="rpt-osdia-flag" *ngIf="entreOsAfterIntervalo(ev)">Entre OS≥10min</span>
                                <span class="rpt-osdia-flag" *ngIf="getOciosoTotal(ev) != null">Ocioso: {{ getOciosoTotal(ev) | number:'1.0-0' }} min</span>
                              </div>
                              <p class="osdia-ev-causa" *ngIf="ev.classe || ev.causa || evDespAfterPrevLib(ev)">
                                <span *ngIf="ev.classe"><strong>Classe:</strong> {{ ev.classe }}</span>
                                <span class="osdia-ev-causa-sep" *ngIf="ev.classe && ev.causa"> · </span>
                                <span *ngIf="ev.causa"><strong>Causa:</strong> {{ ev.causa }}</span>
                                <ng-container *ngIf="evDespAfterPrevLib(ev) as despTime">
                                  <span class="osdia-ev-causa-sep" *ngIf="ev.classe || ev.causa"> · </span>
                                  <span><strong>Desp.:</strong> {{ despTime }}</span>
                                </ng-container>
                              </p>
                              <app-timeline-visual [ev]="ev"></app-timeline-visual>
                              <ul class="osdia-ev-alerts">
                                <li *ngIf="ev.flags.includes('tr_excede_hd')" class="osdia-ev-alert">
                                  <strong>Tempo de Reparo alto:</strong> <span [innerHTML]="highlightMin(osDiaAlertBody('tr_excede_hd', ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('temp_prep_alto')" class="osdia-ev-alert">
                                  <strong>Tempo de Partida/OS:</strong> <span [innerHTML]="highlightMin(tempPrepAltoText(ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('triagem_alto')" class="osdia-ev-alert">
                                  <strong>2º Desp. | Prioritário:</strong> <span [innerHTML]="highlightMin(triagemAltoText(ev))"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('primeiro_desloc_alto')" class="osdia-ev-alert">
                                  <strong>1º Desloc.:</strong> <span [innerHTML]="highlightMin(ev.alertTexts?.['primeiro_desloc_alto'] ?? '')"></span>
                                </li>
                                <li *ngIf="ev.flags.includes('sem_os_alto') || entreOsAfterIntervalo(ev)" class="osdia-ev-alert">
                                  <strong>Sem Ordem/OS:</strong> <span [innerHTML]="highlightMin(osDiaAlertBody('sem_os_alto', ev))"></span>
                                  <ol class="osdia-sem-os-list">
                                    <li *ngFor="let d of alertSemOsDetails(ev.sem_os_details)"><em class="osdia-sem-os-label">{{ semOsDetailLabel(d) }}:</em> <span [innerHTML]="highlightMin(semOsDetailBody(d))"></span></li>
                                    <li *ngIf="entreOsAfterIntervalo(ev) as eo"><em class="osdia-sem-os-label">Entre OS:</em> <span [innerHTML]="highlightMin(formatEntreOsText(eo))"></span></li>
                                  </ol>
                                </li>
                                
                                
                                <li *ngIf="ev.nr_ordem_despacho_anterior" class="osdia-ev-alert osdia-ev-alert--warn">
                                  <strong>Despacho anterior da 1ªOS:</strong> a OS <strong>{{ ev.nr_ordem_despacho_anterior }}</strong> foi despachada em {{ formatDespachoHora(ev.hora_despacho_anterior) }} antes do deslocamento da 1ª OS desta equipe, provavelmente por motivo de prioridade, dessa forma o despacho da 1ªOS pode ficar elevado.
                                </li>
                              </ul>
                            </ng-template>
                            <ng-container *ngFor="let grp of allDateGroupsForKpi(analysis.flaggedOrders, undefined); trackBy: trackByDateRef">
                              <div class="ev-date-group-header">{{ grp.dateRef }}</div>
                              <div class="osdia-ev-item" *ngFor="let ev of grp.items">
                                <ng-container *ngTemplateOutlet="utilizacaoEvTpl; context: {$implicit: ev}"></ng-container>
                              </div>
                            </ng-container>
                            <ng-container *ngIf="analysis.extraFlaggedOrders?.length">
                              <button class="ev-ver-mais-btn team-ver-mais" style="background-color: lightblue; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-top: 10px; width: 100%; text-align: center; font-weight: bold;" (click)="toggleTeamExpanded('Utilização', analysis.team)">
                                {{ isTeamExpanded('Utilização', analysis.team) ? '▲ Ver menos' : '▼ Ver mais ' + (analysis.extraFlaggedOrders?.length || 0) + ' OS(s) com baixo tempo' }}
                              </button>
                              <div *ngIf="isTeamExpanded('Utilização', analysis.team)" class="extra-orders-container" style="margin-top: 15px; border-top: 1px dashed #ccc; padding-top: 10px;">
                                <ng-container *ngFor="let grp of allDateGroupsForKpi(analysis.extraFlaggedOrders || [], []); trackBy: trackByDateRef">
                                  <div class="ev-date-group-header" style="opacity: 0.8">{{ grp.dateRef }} (Extra)</div>
                                  <div class="osdia-ev-item osdia-ev-item--extra" *ngFor="let ev of grp.items">
                                    <ng-container *ngTemplateOutlet="utilizacaoEvTpl; context: {$implicit: ev}"></ng-container>
                                  </div>
                                </ng-container>
                              </div>
                            </ng-container>
                          </div>
                        </div>
                      </ng-container>
                      <ng-template #noUtilizacaoEvidence>
                        <p class="rpt-no-data">Nenhuma ordem com alertas nos dados filtrados.</p>
                      </ng-template>
                    </div>
                  </div>
                </ng-container>
                <!-- Utilização: all teams at meta -->
                <ng-container *ngIf="kpi.kpi === 'Utilização' && (!report.specialAnalysis.utilizacaoAnalysis || report.specialAnalysis.utilizacaoAnalysis.length === 0)">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — 3 Abaixo do Padrão
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="kpi-meta-ok">✅ Todas as equipes atingiram a meta esperada.</p>
                </ng-container>
                <!-- TME IMP drill-down -->
                <ng-container *ngIf="kpi.kpi === 'TME IMP' && kpi.tmeImpAnalysis && kpi.tmeImpAnalysis.length > 0">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Ordens com TME IMP Elevado
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="rpt-section-desc">Ordens onde o tempo improdutivo (TR Ordem Imp SS) superou 1,5× a média da equipe ou a meta de 20 min. O TME IMP mede o tempo entre a chegada ao local (No Local) e a liberação da OS, sem execução produtiva — quanto maior esse tempo, mais prejudica a pontuação da equipe.</p>
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of filterTmeImpEvidence(kpi.tmeImpAnalysis)">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}</span>
                        <span class="rpt-osdia-badge rpt-osdia-badge--gap">
                          {{ analysis.gap > 0 ? '+' : '' }}{{ analysis.gap | number:'1.1-1' }} min s/meta
                        </span>
                        <button class="export-png-btn" (click)="exportTeamCardToPng($event, analysis.team)" title="Copiar imagem">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>
                          </svg>
                        </button>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">TME IMP <strong>{{ analysis.tmeImpValue | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Meta <strong>{{ analysis.metaTarget }} min</strong></span>
                        <span class="rpt-osdia-chip">Média equipe <strong>{{ analysis.avgTmeImpMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Média global <strong>{{ analysis.globalAvgTmeImpMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Total OS <strong>{{ analysis.totalOrders }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTmeMuitoAlto > 0">TME≥1.5×avg: <strong>{{ analysis.summary.countTmeMuitoAlto }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countSemDeslocamento > 0">Sem desloc.: <strong>{{ analysis.summary.countSemDeslocamento }}</strong></span>
                      </div>
                      <div class="osdia-ev-list" *ngIf="analysis.flaggedOrders.length > 0; else noTmeImpEvidence">
                        <ng-template #tmeImpEvTpl let-ev>
                          <div class="osdia-ev-header">
                            <span class="osdia-ev-ordem">OS {{ ev.nr_ordem }}</span>
                            <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ tmeImpFlagLabel(f) }}</span>
                          </div>
                          <p class="osdia-ev-causa" *ngIf="ev.classe || ev.causa">
                            <span *ngIf="ev.classe"><strong>Classe:</strong> {{ ev.classe }}</span>
                            <span class="osdia-ev-causa-sep" *ngIf="ev.classe && ev.causa"> · </span>
                            <span *ngIf="ev.causa"><strong>Causa:</strong> {{ ev.causa }}</span>
                          </p>
                          <div class="kpi-ev-timeline">
                            <span class="kpi-tl-node kpi-tl-node--prev">
                              <span class="kpi-tl-label">OS Anterior</span>
                            </span>
                            <span class="kpi-tl-arrow">→</span>
                            <span class="kpi-tl-node">
                              <span class="kpi-tl-label">Lib. Anterior</span>
                              <span class="kpi-tl-time">{{ ev.prev_liberada || '—' }}</span>
                            </span>
                            <span class="kpi-tl-sep">|</span>
                            <span class="kpi-tl-node kpi-tl-node--cur">
                              <span class="kpi-tl-label">OS Atual</span>
                            </span>
                            <span class="kpi-tl-arrow">→</span>
                            <span class="kpi-tl-node">
                              <span class="kpi-tl-label">Despachada</span>
                              <span class="kpi-tl-time">{{ ev.despachada }}</span>
                            </span>
                            <span class="kpi-tl-arrow">→</span>
                            <span class="kpi-tl-node">
                              <span class="kpi-tl-label">A Caminho</span>
                              <span class="kpi-tl-time">{{ ev.a_caminho }}</span>
                            </span>
                            <span class="kpi-tl-arrow">→</span>
                            <span class="kpi-tl-node">
                              <span class="kpi-tl-label">No Local</span>
                              <span class="kpi-tl-time">{{ ev.no_local }}</span>
                            </span>
                            <span class="kpi-tl-arrow">→</span>
                            <span class="kpi-tl-node kpi-tl-node--end">
                              <span class="kpi-tl-label">Liberada</span>
                              <span class="kpi-tl-time">{{ ev.liberada }}</span>
                            </span>
                          </div>
                          <ul class="osdia-ev-alerts">
                            <li *ngIf="ev.flags.includes('tme_muito_alto')" class="osdia-ev-alert">
                              <strong>TME IMP elevado:</strong> <span [innerHTML]="highlightMin(tmeImpAlertBody('tme_muito_alto', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('sem_deslocamento')" class="osdia-ev-alert">
                              <strong>Sem registro de deslocamento:</strong> <span [innerHTML]="highlightMin(tmeImpAlertBody('sem_deslocamento', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('sem_execucao')" class="osdia-ev-alert">
                              <strong>Sem TR Ordem:</strong> <span [innerHTML]="highlightMin(tmeImpAlertBody('sem_execucao', ev))"></span>
                            </li>
                          </ul>
                        </ng-template>
                        <ng-container *ngFor="let grp of allDateGroupsForKpi(analysis.flaggedOrders, undefined); trackBy: trackByDateRef">
                          <div class="ev-date-group-header">{{ grp.dateRef }}</div>
                          <div class="osdia-ev-item" *ngFor="let ev of grp.items">
                            <ng-container *ngTemplateOutlet="tmeImpEvTpl; context: {$implicit: ev}"></ng-container>
                          </div>
                        </ng-container>
                        <ng-container *ngIf="analysis.extraFlaggedOrders?.length">
                          <button class="ev-ver-mais-btn team-ver-mais" style="background-color: lightblue; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-top: 10px; width: 100%; text-align: center; font-weight: bold;" (click)="toggleTeamExpanded('TME IMP', analysis.team)">
                            {{ isTeamExpanded('TME IMP', analysis.team) ? '▲ Ver menos' : '▼ Ver mais ' + (analysis.extraFlaggedOrders?.length || 0) + ' OS(s) com baixo tempo' }}
                          </button>
                          <div *ngIf="isTeamExpanded('TME IMP', analysis.team)" class="extra-orders-container" style="margin-top: 15px; border-top: 1px dashed #ccc; padding-top: 10px;">
                            <ng-container *ngFor="let grp of allDateGroupsForKpi(analysis.extraFlaggedOrders || [], []); trackBy: trackByDateRef">
                              <div class="ev-date-group-header" style="opacity: 0.8">{{ grp.dateRef }} (Extra)</div>
                              <div class="osdia-ev-item osdia-ev-item--extra" *ngFor="let ev of grp.items">
                                <ng-container *ngTemplateOutlet="tmeImpEvTpl; context: {$implicit: ev}"></ng-container>
                              </div>
                            </ng-container>
                          </div>
                        </ng-container>
                      </div>
                      <ng-template #noTmeImpEvidence>
                        <p class="rpt-no-data">Nenhuma ordem com TME IMP elevado nos dados filtrados.</p>
                      </ng-template>
                    </div>
                  </div>
                </ng-container>
                <!-- TME IMP: all teams at meta -->
                <ng-container *ngIf="kpi.kpi === 'TME IMP' && (!kpi.tmeImpAnalysis || kpi.tmeImpAnalysis.length === 0)">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Ordens com TME IMP Elevado
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="kpi-meta-ok">✅ Todas as equipes atingiram a meta esperada.</p>
                </ng-container>
                <!-- 1º Login drill-down -->
                <ng-container *ngIf="kpi.kpi === '1º Login' && kpi.primeiroLoginAnalysis && kpi.primeiroLoginAnalysis.length > 0">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Dias com 1º Login Acima da Meta
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="rpt-section-desc">Dias em que o primeiro login corrigido superou a meta de 8 min. Atrasos no login atrasam o primeiro despacho, comprimem a jornada e reduzem o número de OS possíveis.</p>
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of filterLoginEvidence(kpi.primeiroLoginAnalysis)">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}</span>
                        <span class="rpt-osdia-badge rpt-osdia-badge--gap">
                          {{ analysis.gap > 0 ? '+' : '' }}{{ analysis.gap | number:'1.1-1' }} min s/meta
                        </span>
                        <button class="export-png-btn" (click)="exportTeamCardToPng($event, analysis.team)" title="Copiar imagem">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>
                          </svg>
                        </button>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">1º Login <strong>{{ analysis.primeiroLoginValue | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Meta <strong>{{ analysis.metaTarget }} min</strong></span>
                        <span class="rpt-osdia-chip">Média equipe <strong>{{ analysis.avgLoginMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Média global <strong>{{ analysis.globalAvgLoginMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Dias com atraso <strong>{{ analysis.diasAcimaMetaCount }}/{{ analysis.totalDays }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countLoginMuitoTardio > 0">Login&gt;16min: <strong>{{ analysis.summary.countLoginMuitoTardio }}</strong></span>
                      </div>
                      <div class="osdia-ev-list" *ngIf="analysis.flaggedDays.length > 0; else noLoginEvidence">
                        <ng-template #loginEvTpl let-ev>
                          <div class="osdia-ev-header">
                            <span class="osdia-ev-ordem">{{ ev.date_ref || '—' }}</span>
                            <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ loginFlagLabel(f) }}</span>
                          </div>
                          <div class="kpi-ev-timeline">
                            <span class="kpi-tl-node kpi-tl-node--prev">
                              <span class="kpi-tl-label">Início Calendário</span>
                              <span class="kpi-tl-time">{{ ev.inicio_calendario }}</span>
                            </span>
                            <span class="kpi-tl-arrow">→</span>
                            <span class="kpi-tl-node kpi-tl-node--end">
                              <span class="kpi-tl-label">Log In Corrigido</span>
                              <span class="kpi-tl-time">{{ ev.log_in_corrigido }}</span>
                            </span>
                          </div>
                          <ul class="osdia-ev-alerts">
                            <li *ngIf="ev.flags.includes('login_muito_tardio')" class="osdia-ev-alert">
                              <strong>Login muito tardio:</strong> <span [innerHTML]="highlightMin(loginAlertBody('login_muito_tardio', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('login_tardio') && !ev.flags.includes('login_muito_tardio')" class="osdia-ev-alert">
                              <strong>Login tardio:</strong> <span [innerHTML]="highlightMin(loginAlertBody('login_tardio', ev))"></span>
                            </li>
                          </ul>
                        </ng-template>
                        <div class="osdia-ev-item" *ngFor="let ev of analysis.flaggedDays">
                          <ng-container *ngTemplateOutlet="loginEvTpl; context: {$implicit: ev}"></ng-container>
                        </div>
                        <ng-container *ngIf="isDateExpanded('1º Login', analysis.team, '__extra__')">
                          <div class="osdia-ev-item osdia-ev-item--extra" *ngFor="let ev of (analysis.extraFlaggedDays ?? [])">
                            <ng-container *ngTemplateOutlet="loginEvTpl; context: {$implicit: ev}"></ng-container>
                          </div>
                        </ng-container>
                        <button class="ev-ver-mais-btn" *ngIf="(analysis.extraFlaggedDays ?? []).length > 0" (click)="toggleDateExpanded('1º Login', analysis.team, '__extra__')">
                          {{ isDateExpanded('1º Login', analysis.team, '__extra__') ? '▲ Ver menos' : '▼ Ver mais ' + (analysis.extraFlaggedDays ?? []).length + ' dia(s)...' }}
                        </button>
                      </div>
                      <ng-template #noLoginEvidence>
                        <p class="rpt-no-data">Nenhum dia com 1º Login acima da meta.</p>
                      </ng-template>
                    </div>
                  </div>
                </ng-container>
                <!-- 1º Login: all teams at meta -->
                <ng-container *ngIf="kpi.kpi === '1º Login' && (!kpi.primeiroLoginAnalysis || kpi.primeiroLoginAnalysis.length === 0)">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Dias com 1º Login Acima da Meta
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="kpi-meta-ok">✅ Todas as equipes atingiram a meta esperada.</p>
                </ng-container>
                <!-- 1º Desloc. drill-down -->
                <ng-container *ngIf="kpi.kpi === '1º Desloc.' && kpi.primeiroDeslocAnalysis && kpi.primeiroDeslocAnalysis.length > 0">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Dias com 1º Desloc. Acima da Meta
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="rpt-section-desc">Dias em que o tempo entre o primeiro despacho e o primeiro "A Caminho" superou a meta de 25 min. Um 1º Desloc. alto indica que a equipe demora a sair em campo após o primeiro despacho.</p>
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of filterDeslocEvidence(kpi.primeiroDeslocAnalysis)">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}</span>
                        <span class="rpt-osdia-badge rpt-osdia-badge--gap">
                          {{ analysis.gap > 0 ? '+' : '' }}{{ analysis.gap | number:'1.1-1' }} min s/meta
                        </span>
                        <button class="export-png-btn" (click)="exportTeamCardToPng($event, analysis.team)" title="Copiar imagem">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>
                          </svg>
                        </button>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">1º Desloc. <strong>{{ analysis.primeiroDeslocValue | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Meta <strong>{{ analysis.metaTarget }} min</strong></span>
                        <span class="rpt-osdia-chip">Média equipe <strong>{{ analysis.avgDeslocMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Média global <strong>{{ analysis.globalAvgDeslocMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Dias c/ atraso <strong>{{ analysis.diasAcimaMetaCount }}/{{ analysis.totalDays }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countDeslocMuitoLento > 0">Desloc.&gt;37min: <strong>{{ analysis.summary.countDeslocMuitoLento }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countSemDeslocRegistrado > 0">Sem registro: <strong>{{ analysis.summary.countSemDeslocRegistrado }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countDespachioTardio > 0">Despacho tardio: <strong>{{ analysis.summary.countDespachioTardio }}</strong></span>
                      </div>
                      <div class="osdia-ev-list" *ngIf="analysis.flaggedDays.length > 0; else noDeslocEvidence">
                        <ng-template #deslocEvTpl let-ev>
                          <div class="osdia-ev-header">
                            <span class="osdia-ev-ordem">{{ ev.date_ref || '—' }}{{ ev.nr_ordem ? ' · OS ' + ev.nr_ordem : '' }}</span>
                            <span class="rpt-osdia-badge rpt-osdia-badge--first" *ngIf="ev.is_primeira_os_jornada" title="Primeira OS da jornada">1ª OS</span>
                            <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ deslocFlagLabel(f) }}</span>
                          </div>
                          <app-timeline-visual [ev]="ev"></app-timeline-visual>
                          <ul class="osdia-ev-alerts">
                            <li *ngIf="ev.flags.includes('despacho_tardio')" class="osdia-ev-alert">
                              <strong>Despacho tardio:</strong> <span [innerHTML]="highlightMin(deslocAlertBody('despacho_tardio', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('desloc_muito_lento')" class="osdia-ev-alert">
                              <strong>1º Desloc.:</strong> <span [innerHTML]="highlightMin(deslocAlertBody('desloc_muito_lento', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('desloc_lento') && !ev.flags.includes('desloc_muito_lento')" class="osdia-ev-alert">
                              <strong>1º Desloc.:</strong> <span [innerHTML]="highlightMin(deslocAlertBody('desloc_lento', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('sem_desloc_registrado')" class="osdia-ev-alert">
                              <strong>Sem deslocamento registrado:</strong> <span [innerHTML]="highlightMin(deslocAlertBody('sem_desloc_registrado', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('triagem_alto')" class="osdia-ev-alert">
                              <strong>2º Desp. | Prioritário:</strong> <span [innerHTML]="highlightMin(triagemAltoText(ev))"></span>
                            </li>
                            
                                <li *ngIf="ev.nr_ordem_despacho_anterior" class="osdia-ev-alert osdia-ev-alert--warn">
                              <strong>Despacho anterior da 1ªOS:</strong> a OS <strong>{{ ev.nr_ordem_despacho_anterior }}</strong> foi despachada em {{ formatDespachoHora(ev.hora_despacho_anterior) }} antes do deslocamento da 1ª OS desta equipe, provavelmente por motivo de prioridade, dessa forma o despacho da 1ªOS pode ficar elevado.
                            </li>
                          </ul>
                        </ng-template>
                        <div class="osdia-ev-item" *ngFor="let ev of analysis.flaggedDays">
                          <ng-container *ngTemplateOutlet="deslocEvTpl; context: {$implicit: ev}"></ng-container>
                        </div>
                        <ng-container *ngIf="isDateExpanded('1º Desloc.', analysis.team, '__extra__')">
                          <div class="osdia-ev-item osdia-ev-item--extra" *ngFor="let ev of (analysis.extraFlaggedDays ?? [])">
                            <ng-container *ngTemplateOutlet="deslocEvTpl; context: {$implicit: ev}"></ng-container>
                          </div>
                        </ng-container>
                        <button class="ev-ver-mais-btn" *ngIf="(analysis.extraFlaggedDays ?? []).length > 0" (click)="toggleDateExpanded('1º Desloc.', analysis.team, '__extra__')">
                          {{ isDateExpanded('1º Desloc.', analysis.team, '__extra__') ? '▲ Ver menos' : '▼ Ver mais ' + (analysis.extraFlaggedDays ?? []).length + ' dia(s)...' }}
                        </button>
                      </div>
                      <ng-template #noDeslocEvidence>
                        <p class="rpt-no-data">Nenhum dia com 1º Desloc. acima da meta.</p>
                      </ng-template>
                    </div>
                  </div>
                </ng-container>
                <!-- 1º Desloc.: all teams at meta -->
                <ng-container *ngIf="kpi.kpi === '1º Desloc.' && (!kpi.primeiroDeslocAnalysis || kpi.primeiroDeslocAnalysis.length === 0)">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Dias com 1º Desloc. Acima da Meta
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="kpi-meta-ok">✅ Todas as equipes atingiram a meta esperada.</p>
                </ng-container>
                <!-- Retorno Base drill-down -->
                <ng-container *ngIf="kpi.kpi === 'Retorno Base' && kpi.retornoBaseAnalysis && kpi.retornoBaseAnalysis.length > 0">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Dias com Retorno Base Acima da Meta
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="rpt-section-desc">Dias em que o retorno à base superou a meta de 40 min. Este tempo é descontado no cálculo de Utilização, impactando diretamente a nota da equipe.</p>
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of filterRetornoEvidence(kpi.retornoBaseAnalysis)">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}</span>
                        <span class="rpt-osdia-badge rpt-osdia-badge--gap">
                          {{ analysis.gap > 0 ? '+' : '' }}{{ analysis.gap | number:'1.1-1' }} min s/meta
                        </span>
                        <button class="export-png-btn" (click)="exportTeamCardToPng($event, analysis.team)" title="Copiar imagem">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>
                          </svg>
                        </button>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">Retorno Base <strong>{{ analysis.retornoBaseValue | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Meta <strong>{{ analysis.metaTarget }} min</strong></span>
                        <span class="rpt-osdia-chip">Média equipe <strong>{{ analysis.avgRetornoMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Média global <strong>{{ analysis.globalAvgRetornoMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">Dias c/ atraso <strong>{{ analysis.diasAcimaMetaCount }}/{{ analysis.totalDays }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countRetornoMuitoAlto > 0">Retorno&gt;60min: <strong>{{ analysis.summary.countRetornoMuitoAlto }}</strong></span>
                      </div>
                      <div class="osdia-ev-list" *ngIf="analysis.flaggedDays.length > 0; else noRetornoEvidence">
                        <ng-template #retornoEvTpl let-ev>
                          <div class="osdia-ev-header">
                            <span class="osdia-ev-ordem">{{ ev.date_ref || '—' }}</span>
                            <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ retornoFlagLabel(f) }}</span>
                          </div>
                          <div class="kpi-ev-timeline">
                            <span class="kpi-tl-node kpi-tl-node--prev">
                              <span class="kpi-tl-label">Última OS Liberada</span>
                              <span class="kpi-tl-time">{{ ev.hora_ultima_ordem }}</span>
                            </span>
                            <span class="kpi-tl-arrow">→</span>
                            <span class="kpi-tl-node kpi-tl-node--end">
                              <span class="kpi-tl-label">Log Off Corrigido</span>
                              <span class="kpi-tl-time">{{ ev.log_off_corrigido }}</span>
                            </span>
                          </div>
                          <ul class="osdia-ev-alerts">
                            <li *ngIf="ev.flags.includes('retorno_muito_alto')" class="osdia-ev-alert">
                              <strong>Retorno muito alto:</strong> <span [innerHTML]="highlightMin(retornoAlertBody('retorno_muito_alto', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('retorno_alto') && !ev.flags.includes('retorno_muito_alto')" class="osdia-ev-alert">
                              <strong>Retorno acima da meta:</strong> <span [innerHTML]="highlightMin(retornoAlertBody('retorno_alto', ev))"></span>
                            </li>
                            <li *ngIf="ev.flags.includes('retorno_divergente')" class="osdia-ev-alert osdia-ev-alert--warn">
                              <strong>Divergência:</strong> <span [innerHTML]="highlightMin(retornoAlertBody('retorno_divergente', ev))"></span>
                            </li>
                          </ul>
                        </ng-template>
                        <div class="osdia-ev-item" *ngFor="let ev of analysis.flaggedDays">
                          <ng-container *ngTemplateOutlet="retornoEvTpl; context: {$implicit: ev}"></ng-container>
                        </div>
                        <ng-container *ngIf="isDateExpanded('Retorno Base', analysis.team, '__extra__')">
                          <div class="osdia-ev-item osdia-ev-item--extra" *ngFor="let ev of (analysis.extraFlaggedDays ?? [])">
                            <ng-container *ngTemplateOutlet="retornoEvTpl; context: {$implicit: ev}"></ng-container>
                          </div>
                        </ng-container>
                        <button class="ev-ver-mais-btn" *ngIf="(analysis.extraFlaggedDays ?? []).length > 0" (click)="toggleDateExpanded('Retorno Base', analysis.team, '__extra__')">
                          {{ isDateExpanded('Retorno Base', analysis.team, '__extra__') ? '▲ Ver menos' : '▼ Ver mais ' + (analysis.extraFlaggedDays ?? []).length + ' dia(s)...' }}
                        </button>
                      </div>
                      <ng-template #noRetornoEvidence>
                        <p class="rpt-no-data">Nenhum dia com Retorno Base acima da meta.</p>
                      </ng-template>
                    </div>
                  </div>
                </ng-container>
                <!-- Retorno Base: all teams at meta -->
                <ng-container *ngIf="kpi.kpi === 'Retorno Base' && (!kpi.retornoBaseAnalysis || kpi.retornoBaseAnalysis.length === 0)">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Dias com Retorno Base Acima da Meta
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.0 CE - M300</span>
                  </div>
                  <p class="kpi-meta-ok">✅ Todas as equipes atingiram a meta esperada.</p>
                </ng-container>
              </section>
            </ng-container>

            <!-- Scorecard por Equipe -->
            <section class="rpt-section anim-el" *ngIf="report.teamScorecard && report.teamScorecard.length > 0">
              <h2 class="rpt-section-title">🏅 Scorecard por Equipe</h2>
              <p class="rpt-section-desc">Todos os KPIs de cada equipe em uma visão única. Verde = meta atingida, vermelho = abaixo da meta.</p>
              <div class="scorecard-scroll-wrap">
                <table class="scorecard-table">
                  <thead>
                    <tr>
                      <th class="sc-th sc-th-team">Equipe</th>
                      <th class="sc-th sc-th-rank">Rank</th>
                      <th class="sc-th">Dias</th>
                      <th class="sc-th">OS/Dia<br><span class="sc-meta">meta 4,4</span></th>
                      <th class="sc-th">Eficiência<br><span class="sc-meta">meta 100%</span></th>
                      <th class="sc-th">Utilização<br><span class="sc-meta">meta 85%</span></th>
                      <th class="sc-th">TME IMP<br><span class="sc-meta">meta 20</span></th>
                      <th class="sc-th">1º Login<br><span class="sc-meta">meta 8min</span></th>
                      <th class="sc-th">1º Desloc.<br><span class="sc-meta">meta 25min</span></th>
                      <th class="sc-th">Ret. Base<br><span class="sc-meta">meta 40min</span></th>
                      <th class="sc-th">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr class="sc-row"
                        *ngFor="let row of report.teamScorecard"
                        [class.sc-row--critical]="row.kpisBelowMeta >= 4"
                        [class.sc-row--warning]="row.kpisBelowMeta === 3">
                      <td class="sc-td sc-td-team">{{ row.team }}</td>
                      <td class="sc-td sc-td-center">{{ row.classificacao ?? '—' }}</td>
                      <td class="sc-td sc-td-center">{{ row.diasTrabalhados ?? '—' }}</td>
                      <td class="sc-td sc-td-kpi" [class.sc-kpi--above]="row.kpiStatus.osDia === 'above'" [class.sc-kpi--below]="row.kpiStatus.osDia === 'below'">
                        {{ row.kpis.osDia != null ? (row.kpis.osDia | number:'1.1-1') : '—' }}
                      </td>
                      <td class="sc-td sc-td-kpi" [class.sc-kpi--above]="row.kpiStatus.eficiencia === 'above'" [class.sc-kpi--below]="row.kpiStatus.eficiencia === 'below'">
                        {{ row.kpis.eficiencia != null ? (row.kpis.eficiencia | number:'1.0-0') + '%' : '—' }}
                      </td>
                      <td class="sc-td sc-td-kpi" [class.sc-kpi--above]="row.kpiStatus.utilizacao === 'above'" [class.sc-kpi--below]="row.kpiStatus.utilizacao === 'below'">
                        {{ row.kpis.utilizacao != null ? (row.kpis.utilizacao | number:'1.0-0') + '%' : '—' }}
                      </td>
                      <td class="sc-td sc-td-kpi" [class.sc-kpi--above]="row.kpiStatus.tmeImp === 'above'" [class.sc-kpi--below]="row.kpiStatus.tmeImp === 'below'">
                        {{ row.kpis.tmeImp != null ? (row.kpis.tmeImp | number:'1.0-0') : '—' }}
                      </td>
                      <td class="sc-td sc-td-kpi" [class.sc-kpi--above]="row.kpiStatus.primeiroLogin === 'above'" [class.sc-kpi--below]="row.kpiStatus.primeiroLogin === 'below'">
                        {{ row.kpis.primeiroLogin != null ? (row.kpis.primeiroLogin | number:'1.0-0') : '—' }}
                      </td>
                      <td class="sc-td sc-td-kpi" [class.sc-kpi--above]="row.kpiStatus.primeiroDesloc === 'above'" [class.sc-kpi--below]="row.kpiStatus.primeiroDesloc === 'below'">
                        {{ row.kpis.primeiroDesloc != null ? (row.kpis.primeiroDesloc | number:'1.0-0') : '—' }}
                      </td>
                      <td class="sc-td sc-td-kpi" [class.sc-kpi--above]="row.kpiStatus.retornoBase === 'above'" [class.sc-kpi--below]="row.kpiStatus.retornoBase === 'below'">
                        {{ row.kpis.retornoBase != null ? (row.kpis.retornoBase | number:'1.0-0') : '—' }}
                      </td>
                      <td class="sc-td sc-td-score" [class.sc-score--good]="row.score >= 6" [class.sc-score--mid]="row.score >= 4 && row.score < 6" [class.sc-score--bad]="row.score < 4">
                        {{ row.score }}/7
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <!-- Desvios -->
            <section class="rpt-section anim-el" *ngIf="report.deviations.mostRecurring.length > 0">
              <h2 class="rpt-section-title">⚠️ Desvios de Padrão Operacional</h2>
              <div class="rpt-devs-layout">
                <div class="rpt-glass-card">
                  <h3 class="rpt-card-sub">Mais Recorrentes na Base</h3>
                  <div class="rpt-dev-list">
                    <div class="rpt-dev-row" *ngFor="let d of report.deviations.mostRecurring">
                      <span class="rpt-dev-name">{{ d.category }}</span>
                      <span class="rpt-dev-count">{{ d.occurrences }}</span>
                    </div>
                  </div>
                </div>
                <div class="rpt-glass-card" *ngIf="report.deviations.teamBreakdown.length > 0">
                  <h3 class="rpt-card-sub">Por Equipe</h3>
                  <div class="rpt-dev-team-list">
                    <div class="rpt-dev-team-row" *ngFor="let td of report.deviations.teamBreakdown">
                      <span class="rpt-dev-team-name">{{ td.team }}</span>
                      <span class="rpt-dev-team-devs">{{ td.deviations.join(' · ') }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>
            <!-- Plano de Ação -->
            <section class="rpt-section anim-el" *ngIf="report.specialAnalysis.actionPlan.length > 0">
              <h2 class="rpt-section-title">📋 Plano de Ação por Equipe</h2>
              <div class="rpt-action-grid">
                <div class="rpt-action-card" *ngFor="let plan of report.specialAnalysis.actionPlan">
                  <h3 class="rpt-action-team">{{ plan.team }}</h3>
                  <div class="rpt-action-issues">
                    <div class="rpt-action-issue" *ngFor="let issue of plan.issues">⚠ {{ issue }}</div>
                  </div>
                  <div class="rpt-action-recs" *ngIf="plan.recommendations.length > 0">
                    <div class="rpt-action-rec" *ngFor="let rec of plan.recommendations">→ {{ rec }}</div>
                  </div>
                </div>
              </div>
            </section>

            </ng-container><!-- /operacional -->

            <!-- ======= MODO ANALÍTICO ======= -->
            <ng-container *ngIf="reportType() === 'analitico'">

              <!-- TOC sidebar — mesmo sistema do modo operacional -->
              <app-toc-nav [kpis]="report.kpis" />

              <!-- Gráfico de Tendência Macro por KPI -->
              <section class="analytic-kpi-section anim-el" [id]="'kpi-' + i" *ngFor="let kpi of report.kpis; let i = index">
                <ng-container *ngIf="analyticChartData(kpi) as cd">
                  <div class="analytic-kpi-header">
                    <div class="analytic-kpi-title-row">
                      <h2 class="analytic-kpi-title">{{ kpi.kpi }}</h2>
                      <span class="analytic-kpi-dir-badge"
                            [class.analytic-kpi-dir-badge--up]="kpi.direction === 'higher-is-better'"
                            [class.analytic-kpi-dir-badge--down]="kpi.direction !== 'higher-is-better'">
                        {{ kpi.direction === 'higher-is-better' ? '↑ Maior é melhor' : '↓ Menor é melhor' }}
                      </span>
                    </div>
                    <div class="analytic-kpi-meta-row">
                      <div class="analytic-kpi-chips">
                        <span class="analytic-kpi-chip">Meta <strong>{{ kpi.metaTarget | number:'1.0-1' }}</strong></span>
                        <span class="analytic-kpi-chip">Média Global <strong>{{ kpi.average | number:'1.0-1' }}</strong></span>
                        <span class="analytic-kpi-chip">Acima da meta <strong>{{ kpi.topTeams.length }}/{{ kpi.scores.length }}</strong></span>
                      </div>
                    </div>
                  </div>

                  <div class="ac-macro-row">
                    <!-- Gráfico de Tendência (Média da Base) -->
                    <div class="ac-macro-chart-wrap">
                      <h3 class="ac-macro-subtitle">Tendência Diária da Base</h3>
                      <svg class="analytic-chart-svg" [attr.viewBox]="cd.viewBox" preserveAspectRatio="xMidYMid meet">
                        <!-- Grid + Y axis -->
                        <ng-container *ngFor="let tick of cd.yTicks">
                          <line [attr.x1]="cd.padLeft" [attr.y1]="tick.y" [attr.x2]="cd.chartRight" [attr.y2]="tick.y" class="ac-grid" />
                          <text [attr.x]="cd.padLeft - 6" [attr.y]="tick.y + 4" class="ac-y-label" text-anchor="end">{{ tick.label }}</text>
                        </ng-container>
                        <!-- X axis day labels -->
                        <ng-container *ngFor="let day of cd.days">
                          <text [attr.x]="day.x" [attr.y]="cd.labelBaseY" class="ac-x-label" text-anchor="middle">{{ day.label }}</text>
                        </ng-container>
                        <!-- Meta line dashed -->
                        <line [attr.x1]="cd.padLeft" [attr.y1]="cd.metaY" [attr.x2]="cd.chartRight" [attr.y2]="cd.metaY" class="ac-meta-line" />
                        <text [attr.x]="cd.chartRight + 6" [attr.y]="cd.metaY + 4" class="ac-meta-label">Meta</text>
                        <!-- Overall average horizontal line -->
                        <line [attr.x1]="cd.padLeft" [attr.y1]="cd.avgY" [attr.x2]="cd.chartRight" [attr.y2]="cd.avgY" class="ac-avg-line" />
                        <text [attr.x]="cd.chartRight + 6" [attr.y]="cd.avgY + 4" class="ac-avg-label">Méd.</text>

                        <!-- Area Chart para a Tendência Global (fundo) -->
                        <ng-container *ngIf="cd.trendArea && cd.trendLines.length === 0">
                          <polygon [attr.points]="cd.trendArea" class="ac-trend-area" />
                        </ng-container>

                        <!-- Linhas de Tendência por Base -->
                        <ng-container *ngFor="let tl of cd.trendLines">
                          <polyline class="ac-trend-line" [attr.points]="tl.polyline" fill="none" [attr.stroke]="tl.color" stroke-width="2.5"
                                [style.opacity]="selectedTrendLine() && selectedTrendLine() !== (tl.base + '|' + tl.teamType) ? 0.1 : 1"
                                [style.transition]="'opacity 0.2s'"
                                style="cursor:pointer"
                                (click)="toggleKpiDay(kpi.kpi, null, tl.base, tl.teamType)" />
                          <ng-container *ngFor="let pt of tl.points">
                            <circle [attr.cx]="pt.cx" [attr.cy]="pt.cy" r="6" fill="transparent" stroke="transparent" class="ac-pt-hit"
                                    style="cursor:pointer"
                                    (click)="toggleKpiDay(kpi.kpi, pt.label, tl.base, tl.teamType)" />
                            <circle [attr.cx]="pt.cx" [attr.cy]="pt.cy" r="2.5" class="ac-trend-dot" [attr.fill]="tl.color"
                                    [style.opacity]="selectedTrendLine() && selectedTrendLine() !== (tl.base + '|' + tl.teamType) ? 0.1 : 1"
                                    [style.stroke]="selectedDayPerKpi()[kpi.kpi] === pt.label ? 'var(--text)' : 'none'"
                                    [style.stroke-width]="selectedDayPerKpi()[kpi.kpi] === pt.label ? '2px' : '0'"
                                    [style.transition]="'all 0.2s'">
                              <title>{{ tl.base }} ({{ tl.teamType }}) dia {{ pt.label }}: {{ pt.value | number:'1.0-1' }}</title>
                            </circle>
                          </ng-container>
                        </ng-container>

                        <text *ngIf="!cd.trendArea" [attr.x]="(cd.padLeft + cd.chartRight) / 2" [attr.y]="(cd.metaY + cd.avgY) / 2" text-anchor="middle" class="ac-no-data-text" fill="#94a3b8" font-size="12px">Sem dados de tendência diária disponíveis</text>
                      </svg>
                      <div class="ac-trend-legend" *ngIf="cd.trendLines.length > 0">
                        <div class="ac-legend-item" *ngFor="let tl of cd.trendLines"
                             [class.ac-legend-item--hidden]="selectedTrendLine() && selectedTrendLine() !== (tl.base + '|' + tl.teamType)"
                             (click)="toggleTrendLine(tl.base, tl.teamType)"
                             style="cursor: pointer; transition: opacity 0.2s;">
                          <span class="ac-legend-color" [style.background]="selectedTrendLine() && selectedTrendLine() !== (tl.base + '|' + tl.teamType) ? '#ccc' : tl.color"></span>
                          <span class="ac-legend-label" [style.opacity]="selectedTrendLine() && selectedTrendLine() !== (tl.base + '|' + tl.teamType) ? '0.5' : '1'">
                            {{ tl.base }} {{ tl.teamType !== 'All' ? '(' + tl.teamType + ')' : '' }} - <b>{{ tl.averageValue | number:'1.0-1' }}</b>
                          </span>
                        </div>
                      </div>
                    </div>

                    <!-- Destaques (Top / Bottom) -->
                    <div class="ac-macro-highlights">
                      <div class="ac-macro-card">
                        <div class="ac-macro-card-head">
                          <span class="ac-macro-card-title">🏆 Top Melhores {{ getFilteredDestaques(kpi, cd).selectedDay ? '(Dia ' + getFilteredDestaques(kpi, cd).selectedDay + (getFilteredDestaques(kpi, cd).selectedDayAvg !== null ? ' - Média: ' + (getFilteredDestaques(kpi, cd).selectedDayAvg | number:'1.0-1') : '') + ')' : '' }}</span>
                        </div>
                        <div class="ac-macro-list">
                          <div class="ac-macro-item-wrap" *ngFor="let t of getFilteredDestaques(kpi, cd).top | slice:0:3">
                            <div class="ac-macro-item" style="cursor:pointer" (click)="toggleTeamDetails(t.team, kpi)">
                              <span class="ac-macro-team">{{ t.team }}</span>
                              <span class="ac-macro-val ac-macro-val--good">{{ t.value | number:'1.0-1' }}</span>
                            </div>
                            <div class="ac-macro-item-details" *ngIf="expandedTeamDetails()?.team === t.team && expandedTeamDetails()?.kpi === kpi.kpi">
                              <p class="ac-macro-details-hint">Clique na data para abrir o Operacional</p>
                              <div class="team-details-day-item" *ngFor="let item of getTeamDailyDetails(expandedTeamDetails())" (click)="redirectFromExpandedToOperacional(item.date)">
                                <span class="team-details-day-label">{{ item.date }}</span>
                                <span class="team-details-day-val">{{ item.value | number:'1.0-1' }}</span>
                              </div>
                              <div class="ac-macro-empty" *ngIf="getTeamDailyDetails(expandedTeamDetails()).length === 0">Sem dados diários.</div>
                            </div>
                          </div>
                          <div class="ac-macro-empty" *ngIf="getFilteredDestaques(kpi, cd).top.length === 0">Nenhuma equipe encontrada.</div>
                        </div>
                      </div>

                      <div class="ac-macro-card">
                        <div class="ac-macro-card-head">
                          <span class="ac-macro-card-title">⚠️ Maiores Oportunidades {{ getFilteredDestaques(kpi, cd).selectedDay ? '(Dia ' + getFilteredDestaques(kpi, cd).selectedDay + (getFilteredDestaques(kpi, cd).selectedDayAvg !== null ? ' - Média: ' + (getFilteredDestaques(kpi, cd).selectedDayAvg | number:'1.0-1') : '') + ')' : '' }}</span>
                        </div>
                        <div class="ac-macro-list">
                          <div class="ac-macro-item-wrap" *ngFor="let t of getFilteredDestaques(kpi, cd).bottom | slice:0:3">
                            <div class="ac-macro-item" style="cursor:pointer" (click)="toggleTeamDetails(t.team, kpi)">
                              <span class="ac-macro-team">{{ t.team }}</span>
                              <span class="ac-macro-val ac-macro-val--bad">{{ t.value | number:'1.0-1' }}</span>
                            </div>
                            <div class="ac-macro-item-details" *ngIf="expandedTeamDetails()?.team === t.team && expandedTeamDetails()?.kpi === kpi.kpi">
                              <p class="ac-macro-details-hint">Clique na data para abrir o Operacional</p>
                              <div class="team-details-day-item" *ngFor="let item of getTeamDailyDetails(expandedTeamDetails())" (click)="redirectFromExpandedToOperacional(item.date)">
                                <span class="team-details-day-label">{{ item.date }}</span>
                                <span class="team-details-day-val">{{ item.value | number:'1.0-1' }}</span>
                              </div>
                              <div class="ac-macro-empty" *ngIf="getTeamDailyDetails(expandedTeamDetails()).length === 0">Sem dados diários.</div>
                            </div>
                          </div>
                          <div class="ac-macro-empty" *ngIf="getFilteredDestaques(kpi, cd).bottom.length === 0">Nenhuma equipe encontrada.</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </ng-container>
              </section>

              <!-- Ranking gerencial -->
              <section class="analytic-ranking anim-el" *ngIf="report.teamScorecard && report.teamScorecard.length > 0">
                <h2 class="analytic-section-title">Ranking Gerencial de Equipes</h2>
                <p class="analytic-section-desc">Consolidação de todos os KPIs por equipe no período. Status derivado do número de indicadores abaixo da meta.</p>
                <div class="analytic-table-wrap">
                  <table class="analytic-table">
                    <thead>
                      <tr>
                        <th class="an-th an-th-rank">Rank</th>
                        <th class="an-th an-th-team">Equipe / Supervisor</th>
                        <th class="an-th">Dias</th>
                        <th class="an-th">Score</th>
                        <th class="an-th">KPIs &lt; Meta</th>
                        <th class="an-th">Status Gerencial</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr class="an-row"
                          *ngFor="let row of report.teamScorecard"
                          [class.an-row--ok]="row.kpisBelowMeta === 0"
                          [class.an-row--warn]="row.kpisBelowMeta > 0 && row.kpisBelowMeta <= 2"
                          [class.an-row--critical]="row.kpisBelowMeta >= 3">
                        <td class="an-td an-td-center">{{ row.classificacao ?? '—' }}</td>
                        <td class="an-td an-td-team">{{ row.team }}</td>
                        <td class="an-td an-td-center">{{ row.diasTrabalhados ?? '—' }}</td>
                        <td class="an-td an-td-center an-td-score"
                            [class.an-score--good]="row.score >= 6"
                            [class.an-score--mid]="row.score >= 4 && row.score < 6"
                            [class.an-score--bad]="row.score < 4">
                          {{ row.score }}/7
                        </td>
                        <td class="an-td an-td-center">{{ row.kpisBelowMeta }}</td>
                        <td class="an-td">
                          <span class="an-status"
                                [class.an-status--ok]="row.kpisBelowMeta === 0"
                                [class.an-status--warn]="row.kpisBelowMeta > 0 && row.kpisBelowMeta <= 2"
                                [class.an-status--critical]="row.kpisBelowMeta >= 3">
                            {{ row.kpisBelowMeta === 0 ? '▲ Estável' : row.kpisBelowMeta <= 2 ? '▬ Oscilante' : '▼ Crítico' }}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

            </ng-container><!-- /analitico -->

          </ng-container>

          <div class="rpt-empty" *ngIf="!reportData() && !loading()">
            <p>Aplique os filtros e clique em <strong>Filtrar</strong> para gerar o relatório analítico.</p>
          </div>
        </section>
      </ng-container>
    </main>
  `,
  styles: [
    `
      .shell {
        --accent: #c0122d;
        --accent-glow: rgba(192, 18, 45, 0.18);
        --accent-2: #2563eb;
        --bg: #f5f4f0;
        --bg-2: #eeede8;
        --glass: rgba(255, 255, 255, 0.72);
        --glass-hover: rgba(255, 255, 255, 0.88);
        --border: rgba(60, 40, 30, 0.1);
        --text: #1e1a17;
        --muted: rgba(40, 30, 20, 0.45);
        --green: #16a34a;
        --green-bg: rgba(22, 163, 74, 0.08);
        --red-bg: rgba(192, 18, 45, 0.07);
        --surface: rgba(255, 255, 255, 0.72);
        --surface-strong: rgba(255, 255, 255, 0.92);
        --line: rgba(60, 40, 30, 0.1);
        --muted-strong: rgba(40, 30, 20, 0.55);
        min-height: 100vh;
        position: relative;
        overflow-x: hidden;
        background: radial-gradient(ellipse 80% 50% at 50% -8%, rgba(192,18,45,0.07) 0%, transparent 55%),
                    linear-gradient(180deg, #f5f4f0 0%, #efede8 100%);
        color: var(--text);
      }

      .shell::before {
        content: '';
        position: fixed;
        inset: 0;
        background:
          radial-gradient(circle 500px at 85% 5%, rgba(37,99,235,0.04), transparent),
          radial-gradient(circle 400px at 5% 85%, rgba(192,18,45,0.04), transparent);
        pointer-events: none;
        z-index: 0;
      }

      .report-filter-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 1105;
        display: flex;
        justify-content: center;
        padding: 14px 18px 0;
        background: transparent;
        border: none;
        box-shadow: none;
        transition: transform 0.22s ease;
        pointer-events: none;
      }

      .report-filter-bar-hidden {
        transform: translateY(-105%);
      }

      .report-filter-groups {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        width: min(1480px, 100%);
        pointer-events: auto;
      }

      /* ── Chip trigger ── */
      .rf-chip {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px 6px 14px;
        border-radius: 20px;
        background: rgba(255,255,255,0.82);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: none;
        box-shadow: 0 1px 4px rgba(0,0,0,0.06);
        cursor: pointer;
        user-select: none;
        transition: box-shadow 0.15s, background 0.15s;
        white-space: nowrap;
      }
      .rf-chip:hover {
        border-color: rgba(60,40,30,0.22);
        box-shadow: 0 2px 8px rgba(0,0,0,0.09);
      }
      .rf-chip-label {
        font-size: 0.66rem;
        font-weight: 700;
        color: var(--muted-strong);
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .rf-chip-value {
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--text);
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rf-chip-arrow {
        width: 10px;
        height: 10px;
        color: var(--muted-strong);
        transition: transform 0.18s;
        flex-shrink: 0;
      }

      /* ── Dropdown panel ── */
      .rf-dropdown {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        min-width: 200px;
        max-height: 320px;
        display: flex;
        flex-direction: column;
        background: rgba(255,255,255,0.96);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: none;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);
        padding: 6px;
        z-index: 1200;
        animation: rfDropIn 0.14s ease;
      }
      @keyframes rfDropIn {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .rf-dropdown-search {
        width: 100%;
        border: none;
        border-bottom: 1px solid rgba(60,40,30,0.10);
        background: transparent;
        padding: 7px 10px;
        font: inherit;
        font-size: 0.82rem;
        color: var(--text);
        outline: none;
        border-radius: 6px 6px 0 0;
      }
      .rf-dropdown-search::placeholder {
        color: var(--muted);
      }

      .rf-dropdown-list {
        overflow-y: auto;
        overscroll-behavior: contain;
        flex: 1;
      }

      .rf-dropdown-option {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        border: none;
        background: transparent;
        padding: 7px 10px;
        font: inherit;
        font-size: 0.82rem;
        color: var(--text);
        cursor: pointer;
        border-radius: 8px;
        transition: background 0.1s;
        text-align: left;
      }
      .rf-dropdown-option:hover {
        background: rgba(60,40,30,0.06);
      }
      .rf-dropdown-option-active {
        font-weight: 700;
        color: var(--accent);
      }
      .rf-opt-check {
        display: inline-flex;
        width: 14px;
        height: 14px;
        color: transparent;
        flex-shrink: 0;
        border: 1px solid var(--border);
        border-radius: 3px;
        align-items: center;
        justify-content: center;
        margin-right: 8px;
        transition: all 0.2s;
      }
      .rf-dropdown-option-active .rf-opt-check {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .rf-opt-check svg {
        width: 100%;
        height: 100%;
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
        background: rgba(200, 190, 180, 0.35);
        backdrop-filter: blur(6px);
      }

      .report-loading p {
        margin: 0;
        color: var(--accent);
        font-size: 0.92rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .loading-retry-btn {
        background: var(--accent);
      }

      .loading-retry-btn:hover {
        background: #c0122e;
      }

      .loading-popup-backdrop,
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(200, 190, 180, 0.35);
        backdrop-filter: blur(6px);
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
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.96);
        border-radius: 24px;
        padding: 28px 24px;
        box-shadow: 0 24px 60px rgba(60, 40, 30, 0.12);
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

      .loading-success-icon {
        width: 56px;
        height: 56px;
        margin: 0 auto 14px;
      }

      .loading-success-icon svg {
        width: 56px;
        height: 56px;
        overflow: visible;
      }

      .loading-success-circle {
        stroke: var(--accent);
        stroke-dasharray: 145;
        stroke-dashoffset: 145;
        animation: success-circle 0.55s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      }

      .loading-success-check {
        stroke: var(--accent);
        stroke-dasharray: 40;
        stroke-dashoffset: 40;
        animation: success-check 0.35s 0.45s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      }

      @keyframes success-circle {
        to { stroke-dashoffset: 0; }
      }

      @keyframes success-check {
        to { stroke-dashoffset: 0; }
      }

      @keyframes loading-spin {
        to { transform: rotate(360deg); }
      }

      .filter-fab {
        position: fixed;
        top: 18px;
        right: 24px;
        z-index: 1102;
        width: 42px;
        height: 42px;
        border: 0;
        border-radius: 14px;
        padding: 0;
        display: grid;
        place-items: center;
        background: rgba(255, 255, 255, 0.88);
        border: 1px solid var(--border);
        box-shadow: 0 4px 18px rgba(60, 40, 30, 0.12), 0 0 0 1px rgba(192,18,45,0.12);
        color: var(--accent);
        cursor: pointer;
        transition: transform 0.18s ease, opacity 0.18s ease;
        backdrop-filter: blur(12px);
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
        background: rgba(245, 244, 240, 0.97);
        backdrop-filter: blur(24px);
        border-left: 1px solid var(--border);
        box-shadow: -12px 0 40px rgba(60, 40, 30, 0.12);
        transform: translateX(100%);
        transition: transform 0.24s ease;
        overflow: auto;
      }

      h2 { color: var(--text); }
      h3 { color: var(--text); }

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
        user-select: none;
        -webkit-user-select: none;
      }

      .drawer-body,
      .drawer-body * {
        cursor: default;
        caret-color: transparent;
      }

      .drawer-body .option-item {
        cursor: pointer;
      }

      .drawer-body .day-input {
        cursor: text;
        user-select: text;
        -webkit-user-select: text;
        caret-color: auto;
      }

      .drawer-card {
        padding: 9px 10px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--glass);
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

      .select-summary {
        font-size: 0.68rem;
        color: var(--muted-strong);
        min-height: 0.95rem;
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
        border: 1px solid var(--border);
        padding: 10px 12px;
        background: var(--glass);
        color: var(--text);
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
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.6);
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
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--glass);
        color: var(--text);
        padding: 5px 7px;
        font: inherit;
        font-size: 0.78rem;
        line-height: 1.05;
        text-align: left;
        cursor: pointer;
        transition: border-color 140ms ease, background-color 140ms ease;
      }

      .option-item:hover {
        border-color: rgba(230, 57, 80, 0.4);
        background: rgba(230, 57, 80, 0.08);
      }

      .option-item-active {
        border-color: rgba(230, 57, 80, 0.5);
        background: rgba(230, 57, 80, 0.14);
        color: var(--accent);
        font-weight: 600;
      }

      .day-range-shell {
        padding: 6px;
        border-radius: 12px;
        background: var(--glass);
        border: 1px solid var(--border);
        display: grid;
        gap: 4px;
      }

      .day-range-display {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
      }

      .day-range-display > div {
        padding: 2px 4px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.7);
        border: 1px solid var(--border);
      }

      .day-input {
        width: 100%;
        border: none;
        background: transparent;
        font-weight: 700;
        font-size: 0.78rem;
        text-align: center;
        color: inherit;
        outline: none;
        cursor: text;
        -moz-appearance: textfield;
      }

      .day-input::-webkit-inner-spin-button,
      .day-input::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }

      .day-input:focus {
        outline: 1.5px solid var(--accent);
        border-radius: 4px;
      }

      .dual-slider {
        position: relative;
        height: 28px;
        display: grid;
        align-items: center;
      }

      /* Inactive track base layer */
      .dual-slider::before {
        content: '';
        position: absolute;
        left: 3px;
        right: 3px;
        top: 50%;
        height: 6px;
        transform: translateY(-50%);
        border-radius: 999px;
        background: rgba(60, 40, 30, 0.12);
      }

      /* Red fill — driven directly by Angular [style] bindings for zero-lag updates */
      .dual-slider-fill {
        position: absolute;
        top: 50%;
        height: 6px;
        transform: translateY(-50%);
        border-radius: 999px;
        background: rgba(192, 18, 45, 0.75);
        pointer-events: none;
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
        .report-filter-groups {
          gap: 6px;
        }

        .workspace-stage {
          padding-top: 116px;
          padding-left: 14px;
          padding-right: 14px;
        }

        .filter-fab {
          top: 122px;
          right: 16px;
          width: 40px;
          height: 40px;
          border-radius: 12px;
        }

        .period-selects {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 560px) {
        .report-filter-bar {
          padding: 9px 12px;
        }

        .filter-drawer {
          width: calc(100vw - 8px);
          padding-top: 36px;
          padding-left: 14px;
          padding-right: 14px;
        }
      }

      /* ─── Report Display ─── */

      .workspace-stage {
        min-height: 100vh;
        padding: 72px 40px 80px;
        display: grid;
        gap: 28px;
        align-content: start;
        max-width: 1600px;
        margin: 0 auto;
      }

      /* ── Scroll animations ── */
      .anim-el {
        opacity: 0;
        transform: translateY(22px);
        transition: opacity 0.55s ease, transform 0.55s ease;
      }

      .anim-in {
        opacity: 1;
        transform: none;
      }

      /* ── Hero header ── */
      .rpt-hero {
        display: flex;
        align-items: center;
        gap: 24px;
        flex-wrap: wrap;
        padding: 20px 24px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.82);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        border: 1px solid var(--border);
        box-shadow: 0 2px 12px rgba(60, 40, 30, 0.07);
      }

      .rpt-hero-left {
        flex: 1;
        min-width: 180px;
        display: grid;
        gap: 4px;
      }

      .rpt-hero-title {
        margin: 0;
        font-size: 1.55rem;
        font-weight: 800;
        letter-spacing: -0.025em;
        color: var(--text);
      }

      .rpt-hero-meta {
        font-size: 0.74rem;
        color: var(--muted);
        font-weight: 500;
      }

      .rpt-hero-author {
        font-size: 0.72rem;
        color: var(--muted);
        font-style: italic;
        margin-top: 2px;
        display: block;
      }

      .rpt-hero-totals {
        display: flex;
        gap: 28px;
        flex-wrap: wrap;
      }

      .rpt-total-item {
        display: grid;
        gap: 2px;
      }

      .rpt-total-v {
        font-size: 1.55rem;
        font-weight: 800;
        color: var(--accent);
        line-height: 1;
        font-variant-numeric: tabular-nums;
      }

      .rpt-total-l {
        font-size: 0.6rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: var(--muted);
      }

      .rpt-export-btn {
        padding: 9px 18px;
        border-radius: 12px;
        border: 1px solid rgba(230, 57, 80, 0.35);
        background: rgba(230, 57, 80, 0.1);
        color: var(--accent);
        font-weight: 700;
        font-size: 0.82rem;
        cursor: pointer;
        transition: background 160ms ease, border-color 160ms ease;
        white-space: nowrap;
      }

      .rpt-export-btn:hover {
        background: rgba(230, 57, 80, 0.18);
        border-color: rgba(230, 57, 80, 0.6);
      }

      /* ── Export Modal ── */
      .export-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        backdrop-filter: blur(4px);
        z-index: 900;
        animation: fadeIn 150ms ease;
      }

      .export-modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 901;
        width: min(480px, 92vw);
        background: #fff;
        border-radius: 20px;
        box-shadow: 0 24px 60px rgba(0,0,0,0.2), 0 4px 16px rgba(0,0,0,0.1);
        padding: 24px;
        animation: slideUp 200ms ease;
      }

      @keyframes slideUp {
        from { opacity: 0; transform: translate(-50%, calc(-50% + 16px)); }
        to   { opacity: 1; transform: translate(-50%, -50%); }
      }

      @keyframes fadeIn {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      .export-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }

      .export-modal-title {
        font-size: 1.05rem;
        font-weight: 800;
        color: #1a202c;
      }

      .export-modal-close {
        width: 30px;
        height: 30px;
        border-radius: 8px;
        border: none;
        background: #f1f5f9;
        color: #64748b;
        font-size: 0.85rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms;
      }

      .export-modal-close:hover {
        background: #e2e8f0;
        color: #1a202c;
      }

      .export-modal-desc {
        font-size: 0.78rem;
        color: #94a3b8;
        margin-bottom: 18px;
      }

      .export-modal-options {
        display: grid;
        gap: 8px;
      }

      .export-modal-options--disabled {
        opacity: 0.5;
        pointer-events: none;
      }

      /* ── Linha de cada opção de exportação ── */
      .export-option-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1.5px solid #e2e8f0;
        background: #fff;
      }

      .export-option-info {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
        min-width: 0;
      }

      .export-option-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }

      .export-action-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px 12px;
        border-radius: 8px;
        border: 1.5px solid transparent;
        font-size: 0.78rem;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        transition: background 140ms, border-color 140ms, box-shadow 140ms;
      }

      .export-action-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .export-action-btn--download {
        background: #f1f5f9;
        border-color: #cbd5e1;
        color: #334155;
      }

      .export-action-btn--download:hover:not(:disabled) {
        background: #e2e8f0;
        border-color: #94a3b8;
      }

      .export-action-btn--share {
        background: #eff6ff;
        border-color: #bfdbfe;
        color: #1d4ed8;
      }

      .export-action-btn--share:hover:not(:disabled) {
        background: #dbeafe;
        border-color: #93c5fd;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
      }

      .export-loading-row {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 0.82rem;
        color: #2563eb;
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 8px;
        padding: 10px 14px;
        margin-bottom: 14px;
      }

      .export-loading-spinner {
        width: 16px;
        height: 16px;
        border: 2.5px solid #bfdbfe;
        border-top-color: #2563eb;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
        flex-shrink: 0;
      }

      @keyframes spin { to { transform: rotate(360deg); } }

      .export-error-row {
        font-size: 0.8rem;
        color: #dc2626;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 8px;
        padding: 10px 14px;
        margin-bottom: 14px;
      }

      .export-pending-share-row {
        display: none; /* removido */
      }

      .export-action-btn--share-ready {
        background: #16a34a !important;
        border-color: #15803d !important;
        color: #fff !important;
        animation: share-pulse 1.4s ease-in-out infinite;
      }

      @keyframes share-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(22,163,74,0.4); }
        50%       { box-shadow: 0 0 0 5px rgba(22,163,74,0); }
      }

      .export-option-card {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 14px 16px;
        border-radius: 14px;
        border: 1.5px solid #e2e8f0;
        background: #fff;
        cursor: pointer;
        text-align: left;
        transition: border-color 160ms, background 160ms, box-shadow 160ms;
        width: 100%;
      }

      .export-option-card:hover {
        border-color: #2563eb;
        background: #eff6ff;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.08);
      }

      .export-option-icon {
        font-size: 1.4rem;
        flex-shrink: 0;
        width: 36px;
        text-align: center;
      }

      .export-option-body {
        flex: 1;
        display: grid;
        gap: 2px;
      }

      .export-option-title {
        font-size: 0.88rem;
        font-weight: 700;
        color: #1a202c;
      }

      .export-option-sub {
        font-size: 0.72rem;
        color: #64748b;
        line-height: 1.4;
      }

      .export-option-arrow {
        font-size: 1rem;
        color: #cbd5e1;
        flex-shrink: 0;
        transition: color 160ms, transform 160ms;
      }

      .export-option-card:hover .export-option-arrow {
        color: #2563eb;
        transform: translateX(3px);
      }

      .export-modal-title-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .export-modal-back {
        background: none;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 4px 10px;
        font-size: 0.78rem;
        font-weight: 600;
        color: #64748b;
        cursor: pointer;
        white-space: nowrap;
        transition: background 140ms, color 140ms;
      }
      .export-modal-back:hover { background: #f1f5f9; color: #1a202c; }

      .export-base-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-top: 4px;
      }

      .export-base-card {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 14px 16px;
        background: #f8fafc;
        border: 1.5px solid #e2e8f0;
        border-radius: 12px;
        cursor: pointer;
        text-align: left;
        transition: background 150ms, border-color 150ms, box-shadow 150ms;
      }
      .export-base-card:hover {
        background: #eff6ff;
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37,99,235,0.08);
      }
      .export-base-card-top {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 6px;
      }
      .export-base-name {
        font-size: 0.9rem;
        font-weight: 700;
        color: #1a202c;
      }
      .export-base-prefix {
        font-size: 0.72rem;
        font-weight: 600;
        color: #64748b;
        background: #f1f5f9;
        padding: 2px 6px;
        border-radius: 4px;
        font-family: monospace;
      }
      .export-base-action {
        font-size: 0.75rem;
        font-weight: 600;
        color: #2563eb;
      }

      /* ── Executive Summary ── */
      .exec-summary {
        display: grid;
        gap: 0;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.88);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid var(--border);
        box-shadow: 0 2px 12px rgba(60, 40, 30, 0.07);
        overflow: hidden;
      }

      /* stat counters */
      .exec-stats-row {
        display: flex;
        align-items: center;
        padding: 18px 24px;
        gap: 0;
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }

      .exec-stat {
        display: grid;
        gap: 2px;
        padding: 0 24px 0 0;
      }

      .exec-stat:first-child {
        padding-left: 0;
      }

      .exec-stat-value {
        font-size: 1.65rem;
        font-weight: 800;
        color: var(--text);
        line-height: 1;
        font-variant-numeric: tabular-nums;
      }

      .exec-stat-value--alert {
        color: #ef4444;
      }

      .exec-stat-label {
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted);
      }

      .exec-stat-divider {
        width: 1px;
        height: 36px;
        background: var(--border);
        margin: 0 24px 0 0;
        flex-shrink: 0;
      }

      /* KPI alert rows */
      .exec-kpi-alerts {
        display: grid;
        gap: 0;
        padding: 8px 0;
        border-bottom: 1px solid var(--border);
      }

      .exec-kpi-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 24px;
        transition: background 120ms;
      }

      .exec-kpi-row:hover {
        background: rgba(0,0,0,0.02);
      }

      .exec-kpi-name {
        font-size: 0.78rem;
        font-weight: 700;
        color: var(--text);
        min-width: 110px;
        flex-shrink: 0;
      }

      .exec-kpi-bar-wrap {
        flex: 1;
        height: 6px;
        border-radius: 99px;
        background: #f0f2f5;
        overflow: hidden;
        min-width: 60px;
      }

      .exec-kpi-bar {
        height: 100%;
        border-radius: 99px;
        background: #ef4444;
        transition: width 400ms ease;
      }

      .exec-kpi-count {
        font-size: 0.75rem;
        font-weight: 700;
        color: #ef4444;
        min-width: 36px;
        text-align: right;
        flex-shrink: 0;
      }

      .exec-kpi-worst {
        font-size: 0.72rem;
        color: var(--muted);
        min-width: 180px;
        flex-shrink: 0;
      }

      .exec-kpi-worst strong {
        color: var(--text);
        font-weight: 600;
      }

      /* footer row */
      .exec-footer-row {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 12px 24px;
        flex-wrap: wrap;
      }

      .exec-badges-horizontal {
        display: flex;
        align-items: center;
        flex: 1;
        min-width: 320px;
        gap: 12px;
      }
      .exec-badges-label {
        font-size: 0.65rem;
        font-weight: 700;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.1em;
        margin-right: 8px;
        min-width: 70px;
        text-align: right;
      }
      .exec-badges {
        display: flex;
        gap: 6px;
        flex-wrap: nowrap;
        flex: 1;
        min-width: 0;
        overflow: hidden;
      }

      .exec-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border-radius: 6px;
        font-size: 0.72rem;
        font-weight: 500;
        min-width: 0;
        flex: 0 1 auto;
        justify-content: flex-start;
        box-sizing: border-box;
        text-align: left;
        max-width: 100%;
        white-space: nowrap;
      }

      .exec-badge--yellow {
        background: rgba(251, 191, 36, 0.12);
        border: 1px solid rgba(251, 191, 36, 0.35);
        color: #92400e;
      }

      .exec-badge--red {
        background: rgba(239, 68, 68, 0.09);
        border: 1px solid rgba(239, 68, 68, 0.25);
        color: #b91c1c;
      }

      .report-loading-title {
        color: var(--text);
        font-weight: 500;
        font-size: 14px;
        margin-top: 12px;
      }

      .ac-macro-item-wrap {
        display: flex;
        flex-direction: column;
        gap: 4px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
      }

      .ac-macro-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 10px;
        font-size: 11px;
      }

      .ac-macro-item-details {
        padding: 6px 10px 10px 10px;
        background: var(--surface);
        border-top: 1px dashed var(--border);
        max-height: 200px;
        overflow-y: auto;
      }

      .ac-macro-details-hint {
        font-size: 10px;
        color: var(--text-muted);
        margin-bottom: 6px;
      }

      .team-details-day-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 8px;
        margin-bottom: 4px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 11px;
      }

      .team-details-day-item:hover {
        border-color: var(--primary);
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      }

      .team-details-day-label {
        font-weight: 500;
        color: var(--text);
      }

      .team-details-day-val {
        font-weight: 600;
        color: var(--accent);
      }

      .exec-top-issues {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }

      .exec-top-issues-label {
        font-size: 0.65rem;
        font-weight: 700;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.1em;
        flex-shrink: 0;
      }

      .exec-issue-tag {
        padding: 3px 10px;
        border-radius: 6px;
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        font-size: 0.72rem;
        color: var(--text);
        font-weight: 500;
      }

      /* ── Team Scorecard ── */
      .scorecard-scroll-wrap {
        overflow-x: auto;
        border-radius: 16px;
        border: 1px solid var(--border);
        box-shadow: 0 2px 12px rgba(60, 40, 30, 0.07);
        background: #fff;
      }

      .scorecard-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        font-size: 0.8rem;
      }

      .sc-th {
        padding: 11px 12px;
        background: #f5f7fa;
        font-size: 0.67rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: #8392a5;
        border-bottom: 2px solid #e4e9f0;
        white-space: nowrap;
        text-align: center;
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .sc-th:first-child {
        border-radius: 16px 0 0 0;
        text-align: left;
      }

      .sc-th:last-child {
        border-radius: 0 16px 0 0;
      }

      .sc-th-team {
        text-align: left;
        min-width: 170px;
        padding-left: 18px;
      }

      .sc-th-rank {
        min-width: 48px;
      }

      .sc-td {
        padding: 9px 12px;
        border-bottom: 1px solid #f0f2f5;
        color: #2d3748;
        vertical-align: middle;
      }

      .sc-row:last-child .sc-td {
        border-bottom: none;
      }

      .sc-row:hover .sc-td {
        background: #f8faff;
      }

      .sc-td-team {
        font-weight: 600;
        white-space: nowrap;
        padding-left: 18px;
        color: #1a202c;
      }

      .sc-td-center {
        text-align: center;
        color: #8392a5;
        font-size: 0.78rem;
      }

      .sc-td-kpi {
        text-align: center;
        font-variant-numeric: tabular-nums;
        padding: 6px 8px;
      }

      .sc-kpi--above {
        color: #2563eb;
        font-weight: 700;
      }

      .sc-kpi--below {
        color: #ef4444;
        font-weight: 700;
      }

      .sc-td-score {
        text-align: center;
        padding-right: 16px;
      }

      .sc-score--good {
        color: #2563eb;
        font-weight: 700;
      }

      .sc-score--mid {
        color: #f59e0b;
        font-weight: 700;
      }

      .sc-score--bad {
        color: #ef4444;
        font-weight: 700;
      }

      .sc-row--critical .sc-td {
        background: rgba(220, 38, 38, 0.025);
      }

      .sc-row--warning .sc-td {
        background: rgba(217, 119, 6, 0.025);
      }

      .sc-meta {
        font-size: 0.6rem;
        font-weight: 500;
        text-transform: none;
        letter-spacing: 0;
        color: #a0aec0;
        display: block;
        margin-top: 1px;
      }

      /* ── Shared glass card ── */
      .rpt-glass-card {
        padding: 16px 18px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.82);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        border: 1px solid var(--border);
        box-shadow: 0 2px 10px rgba(60, 40, 30, 0.06);
        display: grid;
        gap: 10px;
        align-content: start;
      }

      /* ── KPI sections ── */
      .kpi-section {
        padding: 20px 24px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.82);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        border: 1px solid var(--border);
        box-shadow: 0 2px 12px rgba(60, 40, 30, 0.07);
        display: grid;
        gap: 14px;
      }

      .kpi-section-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      .kpi-title-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .kpi-name {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 800;
        color: var(--text);
        letter-spacing: -0.01em;
      }

      .kpi-dir-badge {
        display: inline-flex;
        align-items: center;
        padding: 3px 9px;
        border-radius: 999px;
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.04em;
      }

      .kpi-dir-badge--up {
        background: rgba(22, 163, 74, 0.1);
        color: #16a34a;
        border: 1px solid rgba(22, 163, 74, 0.22);
      }

      .kpi-dir-badge--down {
        background: var(--red-bg);
        color: var(--accent);
        border: 1px solid rgba(192, 18, 45, 0.2);
      }

      .kpi-chips {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .kpi-chip {
        padding: 3px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.04);
        font-size: 0.72rem;
        color: var(--muted);
      }

      .kpi-chip strong {
        color: var(--text);
        font-weight: 700;
      }

      /* ── KPI chart rows ── */
      .kpi-chart-block {
        display: grid;
        gap: 6px;
      }

      .kpi-chart-group-label {
        font-size: 0.62rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        margin-top: 6px;
      }

      .kpi-group-good { color: #4ade80; }
      .kpi-group-opp  { color: var(--accent); }

      .kpi-cr {
        display: grid;
        grid-template-columns: 22px 220px 1fr 72px;
        align-items: center;
        gap: 10px;
        padding: 5px 8px;
        border-radius: 8px;
        transition: background 140ms ease;
      }

      .kpi-cr:hover { background: rgba(255, 255, 255, 0.04); }

      .kpi-cr--avg {
        background: rgba(60, 40, 30, 0.04);
        border: 1px solid rgba(60, 40, 30, 0.07);
      }

      .kpi-cr-pos {
        font-size: 0.72rem;
        font-weight: 700;
        color: var(--muted);
        text-align: center;
        font-variant-numeric: tabular-nums;
      }

      .kpi-cr-team {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .kpi-cr-team--avg {
        color: var(--muted);
        font-style: italic;
        font-weight: 500;
      }

      .kpi-cr-track {
        position: relative;
        height: 8px;
        border-radius: 4px;
        background: rgba(60, 40, 30, 0.09);
        overflow: visible;
      }

      .kpi-cr-fill {
        height: 100%;
        border-radius: 4px;
        transition: width 0.85s cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      .kpi-cr-fill--good { background: linear-gradient(90deg, #16a34a, #22c55e); }
      .kpi-cr-fill--bad  { background: linear-gradient(90deg, #c0122d, #e63950); }
      .kpi-cr-fill--avg  { background: var(--accent-2); opacity: 0.55; }

      .kpi-cr-meta-line {
        position: absolute;
        top: -4px;
        bottom: -4px;
        width: 2px;
        border-radius: 1px;
        background: rgba(60, 40, 30, 0.3);
        pointer-events: none;
      }

      .kpi-cr-val {
        font-size: 0.8rem;
        font-weight: 800;
        color: var(--text);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      .kpi-cr-val--avg { color: var(--accent-2); }
      .kpi-cr-val--opp { color: var(--accent); }

      /* ── Generic section ── */
      .rpt-section {
        display: grid;
        gap: 14px;
      }

      .rpt-section-title {
        margin: 0;
        font-size: 1.0rem;
        font-weight: 800;
        letter-spacing: -0.01em;
        color: var(--text);
      }

      .rpt-section-note {
        font-size: 0.7rem;
        font-weight: 500;
        color: var(--muted);
        margin-left: 6px;
      }

      .rpt-card-sub {
        margin: 0;
        font-size: 0.64rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: var(--muted);
      }

      /* ── Desvios ── */
      .rpt-devs-layout {
        display: grid;
        grid-template-columns: minmax(240px, 340px) 1fr;
        gap: 12px;
      }

      .rpt-dev-list { display: grid; gap: 4px; }

      .rpt-dev-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        font-size: 0.8rem;
        padding: 5px 7px;
        border-radius: 7px;
        border: 1px solid transparent;
        color: var(--text);
      }

      .rpt-dev-row:nth-child(1) { background: var(--red-bg); border-color: rgba(230, 57, 80, 0.22); }
      .rpt-dev-row:nth-child(2) { background: rgba(230, 57, 80, 0.06); }

      .rpt-dev-name { flex: 1; font-weight: 500; }
      .rpt-dev-count { font-weight: 800; font-variant-numeric: tabular-nums; color: var(--accent); }

      .rpt-dev-team-list { display: grid; gap: 4px; max-height: 280px; overflow-y: auto; }

      .rpt-dev-team-row {
        display: grid; gap: 2px; padding: 5px 7px;
        border-radius: 8px; border: 1px solid var(--border); font-size: 0.74rem;
      }

      .rpt-dev-team-name { font-weight: 700; color: var(--text); }
      .rpt-dev-team-devs { color: var(--muted); font-size: 0.7rem; }

      /* ── Table ── */
      .rpt-table-wrap {
        overflow-x: auto;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.82);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        box-shadow: 0 2px 10px rgba(60, 40, 30, 0.06);
      }

      .rpt-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.8rem;
      }

      .rpt-table th {
        padding: 10px 14px;
        text-align: left;
        font-size: 0.62rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: var(--muted);
        border-bottom: 1px solid var(--border);
      }

      .rpt-table td {
        padding: 8px 14px;
        border-bottom: 1px solid rgba(60, 40, 30, 0.06);
        font-weight: 500;
        color: var(--text);
      }

      .rpt-table tr:last-child td { border-bottom: none; }
      .rpt-table tbody tr:hover td { background: rgba(60, 40, 30, 0.03); }

      .rpt-td-num { text-align: right; font-variant-numeric: tabular-nums; }
      .rpt-td-high { color: var(--accent); font-weight: 800; }

      /* ── Cruzamentos ── */
      .rpt-cross-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 12px;
      }

      .rpt-cross-desc {
        margin: 0;
        font-size: 0.76rem;
        color: var(--muted);
        line-height: 1.5;
      }

      .rpt-cross-rows { display: grid; gap: 5px; }

      .rpt-cross-row {
        display: flex; flex-wrap: wrap; gap: 8px;
        padding: 5px 7px; border-radius: 8px;
        background: rgba(60, 40, 30, 0.04);
        border: 1px solid var(--border); font-size: 0.74rem;
      }

      .rpt-cross-cell { display: grid; gap: 1px; }

      .rpt-cross-key {
        font-size: 0.58rem; text-transform: uppercase;
        letter-spacing: 0.12em; color: var(--muted); font-weight: 700;
      }

      .rpt-cross-val { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }

      .rpt-no-data { margin: 0; font-size: 0.76rem; color: var(--muted); font-style: italic; }
      .kpi-meta-ok { margin: 8px 0 0; font-size: 0.82rem; color: #16a34a; font-weight: 600; }

      /* ── Idle notice (equipe com poucas ordens sem alertas) ── */
      .osdia-idle-notice {
        margin-top: 10px;
        padding: 14px 16px;
        border-radius: 12px;
        background: rgba(234, 179, 8, 0.07);
        border: 1px solid rgba(234, 179, 8, 0.28);
        display: grid;
        gap: 8px;
      }

      .osdia-idle-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.82rem;
        font-weight: 700;
        color: #92400e;
      }

      .osdia-idle-icon { font-size: 1rem; line-height: 1; }

      .osdia-idle-desc {
        margin: 0;
        font-size: 0.76rem;
        color: #78350f;
        line-height: 1.45;
      }

      .osdia-idle-metrics {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .osdia-idle-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 9px;
        border-radius: 20px;
        font-size: 0.7rem;
        font-weight: 600;
      }

      .osdia-idle-chip--hd {
        background: rgba(37, 99, 235, 0.1);
        color: #1e40af;
      }

      .osdia-idle-chip--prep {
        background: rgba(234, 179, 8, 0.1);
        color: #92400e;
      }

      .osdia-idle-chip--sem {
        background: rgba(249, 115, 22, 0.1);
        color: #9a3412;
      }

      .osdia-idle-chip--idle {
        background: rgba(234, 179, 8, 0.15);
        color: #92400e;
      }

      .osdia-idle-chip--he {
        background: rgba(168, 85, 247, 0.12);
        color: #6b21a8;
      }

      /* ── Plano de Ação ── */
      .rpt-action-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 12px;
      }

      .rpt-action-card {
        padding: 16px 18px;
        border-radius: 16px;
        border: 1px solid rgba(192, 18, 45, 0.18);
        background: rgba(255, 245, 246, 0.9);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        display: grid;
        gap: 8px;
        align-content: start;
      }

      .rpt-action-team {
        margin: 0; font-size: 0.88rem; font-weight: 800; color: var(--accent);
      }

      .rpt-action-issues { display: grid; gap: 3px; }

      .rpt-action-issue {
        font-size: 0.76rem; font-weight: 600; color: #b91c3a; padding: 2px 0;
      }

      .rpt-action-recs {
        display: grid; gap: 4px; padding-top: 6px;
        border-top: 1px solid rgba(192, 18, 45, 0.14);
      }

      .rpt-action-rec { font-size: 0.74rem; color: var(--text); line-height: 1.45; }

      /* ── OS/Dia Drill-down ── */
      .kpi-osdia-drill-head {
        margin-top: 18px;
        padding: 8px 0 6px;
        border-top: 1px solid var(--border);
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--text);
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .rpt-osdia-src-inline {
        font-weight: 400;
        font-size: 0.71rem;
        color: var(--muted);
      }

      .rpt-osdia-src {
        margin: -4px 0 12px;
        font-size: 0.74rem;
        color: var(--muted);
      }

      .rpt-osdia-grid {
        display: grid;
        gap: 18px;
      }

      .rpt-osdia-card {
        background: var(--glass);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px 18px;
        display: grid;
        gap: 10px;
      }

      .rpt-osdia-card-head {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .export-png-btn {
        margin-left: auto;
        background: transparent;
        border: 1px solid var(--border);
        cursor: pointer;
        padding: 4px 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        border-radius: 6px;
        transition: all 0.2s;
      }
      .export-png-btn:hover {
        background: rgba(255,255,255,0.1);
        color: var(--text);
      }

      .rpt-osdia-team {
        font-weight: 700;
        font-size: 0.95rem;
        color: var(--text);
      }

      .rpt-osdia-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 9px;
        border-radius: 20px;
        font-size: 0.72rem;
        font-weight: 700;
      }

      .rpt-osdia-badge--gap {
        background: rgba(192, 18, 45, 0.1);
        color: #b91c3a;
        border: 1px solid rgba(192, 18, 45, 0.25);
      }

      .rpt-osdia-badge--first {
        background: rgba(37, 99, 235, 0.1);
        color: #1d4ed8;
        border: 1px solid rgba(37, 99, 235, 0.3);
        font-size: 0.7rem;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 4px;
      }

      .rpt-osdia-badge--good {
        background: rgba(22, 163, 74, 0.1);
        color: #16a34a;
        border: 1px solid rgba(22, 163, 74, 0.25);
      }

      .rpt-osdia-card-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .rpt-osdia-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 10px;
        border-radius: 20px;
        font-size: 0.72rem;
        background: var(--bg-2);
        border: 1px solid var(--border);
        color: var(--muted-strong);
      }

      .rpt-osdia-chip strong { color: var(--text); }

      /* Evidence prose cards */
      .osdia-ev-list {
        display: grid;
        gap: 10px;
        margin-top: 8px;
      }

      .osdia-ev-item {
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-left: 3px solid #b91c3a;
        border-radius: 8px;
        padding: 10px 14px;
        display: grid;
        gap: 6px;
      }

      .osdia-ev-item--extra {
        border-left-color: #3b82f6;
        opacity: 0.9;
      }

      .ev-date-group-header {
        font-size: 0.72rem;
        font-weight: 700;
        color: var(--muted-strong, #6b7280);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 6px 8px 2px;
        border-top: 1px solid var(--border, #e5e7eb);
        margin-top: 4px;
      }

      .ev-ver-mais-btn {
        display: block;
        width: 100%;
        padding: 5px 12px;
        font-size: 0.75rem;
        color: #3b82f6;
        background: transparent;
        border: 1px dashed #3b82f6;
        border-radius: 4px;
        cursor: pointer;
        text-align: center;
        margin-top: 2px;
        transition: background 0.15s;
      }

      .ev-ver-mais-btn:hover {
        background: rgba(59, 130, 246, 0.08);
      }

      .osdia-ev-header {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .osdia-ev-ordem {
        font-weight: 700;
        font-size: 0.85rem;
        color: var(--text);
      }

      .osdia-ev-classe {
        font-size: 0.72rem;
        padding: 1px 7px;
        border-radius: 20px;
        background: var(--glass);
        border: 1px solid var(--border);
        color: var(--muted-strong);
        font-weight: 600;
      }

      .osdia-ev-causa {
        margin: 0;
        font-size: 0.78rem;
        color: var(--muted-strong);
        font-style: italic;
      }

      .osdia-ev-timeline {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 6px;
        font-size: 0.73rem;
      }

      .osdia-ev-ts-label {
        color: var(--muted);
        font-weight: 600;
      }

      .osdia-ev-ts-first {
        color: var(--accent-2);
      }

      .osdia-ev-ts-val {
        color: var(--text);
      }

      .osdia-ev-ts-sep {
        color: var(--muted);
      }

      .osdia-ev-interval {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 6px;
        font-size: 0.72rem;
        padding: 3px 6px;
        background: rgba(37, 99, 235, 0.06);
        border: 1px solid rgba(37, 99, 235, 0.15);
        border-radius: 5px;
        width: fit-content;
      }

      .osdia-ev-int-icon  { color: var(--accent-2); }
      .osdia-ev-int-label { color: var(--accent-2); font-weight: 600; }
      .osdia-ev-int-val   { color: var(--text); }
      .osdia-ev-int-sep   { color: var(--muted); }

      .osdia-ev-prev {
        margin: 0;
        font-size: 0.73rem;
        color: var(--muted-strong);
      }

      .osdia-ev-prev strong {
        color: var(--text);
      }

      .osdia-ev-alerts {
        margin: 4px 0 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 4px;
      }

      .osdia-ev-alert {
        font-size: 0.76rem;
        color: var(--text);
        line-height: 1.5;
        padding-left: 14px;
        position: relative;
      }

      .osdia-ev-alert::before {
        content: '⚠';
        position: absolute;
        left: 0;
        color: #b91c3a;
        font-size: 0.7rem;
        top: 2px;
      }

      .osdia-ev-alert--warn::before {
        color: #d97706;
      }

      .osdia-ev-alert.osdia-ev-alert--warn strong {
        color: #d97706;
      }

      .osdia-ev-obs-flag {
        background: #fef3c7;
        border: 1px solid #f59e0b;
        border-left: 4px solid #d97706;
        border-radius: 6px;
        color: #92400e;
        font-size: 0.74rem;
        line-height: 1.5;
        margin: 6px 0 4px;
        padding: 6px 10px;
      }

      /* KPI-specific event timelines (Login, Retorno Base, TME IMP) */
      .kpi-ev-timeline {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 6px;
        font-size: 0.73rem;
        margin: 4px 0;
      }

      .kpi-tl-node {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
      }

      .kpi-tl-label {
        color: var(--muted-strong);
        font-weight: 600;
        line-height: 1.2;
      }

      .kpi-tl-time {
        color: var(--text);
        font-variant-numeric: tabular-nums;
        line-height: 1.3;
      }

      .kpi-tl-arrow {
        color: var(--muted);
        font-size: 0.85rem;
        flex-shrink: 0;
        align-self: center;
      }

      .kpi-tl-sep {
        color: var(--border);
        font-size: 1rem;
        padding: 0 4px;
        flex-shrink: 0;
        align-self: center;
      }

      .kpi-tl-node--prev .kpi-tl-label,
      .kpi-tl-node--cur .kpi-tl-label {
        font-weight: 700;
        color: var(--accent-2);
      }

      .kpi-tl-node--end .kpi-tl-time {
        color: #b91c3a;
        font-weight: 600;
      }

      .osdia-ev-alert strong {
        color: #b91c3a;
      }

      .osdia-sem-os-list {
        margin: 2px 0 0 6px;
        padding: 0 0 0 18px;
        list-style: decimal;
        font-size: 0.74rem;
        color: var(--text);
        line-height: 1.5;
      }

      .osdia-sem-os-label {
        color: #b91c3a;
        font-style: italic;
      }

      .osdia-sem-os-list li::marker {
        color: #b91c3a;
        font-style: italic;
      }

      .rpt-td-flag {
        color: #b91c3a;
        font-weight: 700;
      }

      .rpt-osdia-flag {
        display: inline-block;
        background: rgba(192, 18, 45, 0.1);
        color: #b91c3a;
        border: 1px solid rgba(192, 18, 45, 0.25);
        border-radius: 4px;
        font-size: 0.66rem;
        font-weight: 700;
        padding: 1px 5px;
        margin-right: 3px;
        white-space: nowrap;
      }

      /* ── Empty state ── */
      .rpt-empty {
        display: grid;
        place-items: center;
        min-height: 40vh;
        color: var(--muted);
        font-size: 0.92rem;
        text-align: center;
        padding: 40px;
      }

      @media (max-width: 720px) {
        .rpt-devs-layout { grid-template-columns: 1fr; }
        .rpt-cross-grid { grid-template-columns: 1fr; }
        .rpt-action-grid { grid-template-columns: 1fr; }
        .kpi-cr { grid-template-columns: 18px 1fr 60px; }
        .kpi-cr-team { display: none; }
      }

      /* ======================================
         ANALYTIC VIEW
         ====================================== */

      .analytic-kpi-section {
        background: var(--glass);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 20px 22px 18px;
        margin-bottom: 24px;
        backdrop-filter: blur(8px);
      }

      .analytic-kpi-header {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 14px;
      }

      .analytic-kpi-title-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .analytic-kpi-title {
        font-size: 16px;
        font-weight: 700;
        color: var(--text);
        margin: 0;
      }

      .analytic-kpi-dir-badge {
        font-size: 11px;
        font-weight: 700;
        padding: 2px 9px;
        border-radius: 20px;
        letter-spacing: .03em;
      }

      .analytic-kpi-dir-badge--up   { background: var(--green-bg); color: var(--green); }
      .analytic-kpi-dir-badge--down { background: var(--red-bg);   color: var(--accent); }

      .analytic-kpi-meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        position: relative;
      }

      .analytic-kpi-chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
      }

      .analytic-kpi-chip {
        font-size: 12px;
        color: var(--muted-strong);
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 3px 10px;
      }

      .analytic-kpi-chip--trend {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #111;
        border-color: #11111144;
        background: #11111110;
      }

      .ac-trend-legend-dot {
        display: inline-block;
        width: 12px;
        height: 3px;
        background: #111;
        border-radius: 2px;
        flex-shrink: 0;
      }

      /* ── Drawer de equipes (popover) ── */
      .ac-drawer {
        position: relative;
        flex-shrink: 0;
        width: 160px;
      }

      .ac-drawer-toggle {
        display: flex;
        align-items: center;
        gap: 5px;
        width: 100%;
        box-sizing: border-box;
        padding: 4px 8px;
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-radius: 7px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        font-family: inherit;
        color: var(--muted-strong);
        transition: background .12s, border-color .12s, border-radius .12s;
        user-select: none;
        white-space: nowrap;
      }

      .ac-drawer-toggle:hover { background: var(--glass-hover); border-color: var(--muted); }

      .ac-drawer--open .ac-drawer-toggle {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-2));
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
        border-bottom-color: transparent;
      }

      .ac-drawer-toggle-label { flex: 1; text-align: left; color: var(--text); }

      .ac-drawer-toggle-icon {
        width: 9px;
        height: 5px;
        flex-shrink: 0;
        transition: transform .18s ease;
        color: var(--muted);
      }

      .ac-drawer--open .ac-drawer-toggle-icon { transform: rotate(180deg); }

      .ac-drawer-count {
        font-size: 10px;
        background: var(--border);
        border-radius: 20px;
        padding: 1px 5px;
        font-weight: 700;
        color: var(--muted-strong);
        line-height: 1.4;
      }

      .ac-drawer-body {
        display: none;
        position: absolute;
        top: 100%;
        right: 0;
        left: 0;
        z-index: 200;
        background: var(--bg-2);
        border: 1px solid var(--accent);
        border-top: none;
        border-radius: 0 0 7px 7px;
        box-shadow: 0 8px 24px rgba(0,0,0,.12);
        padding: 6px 6px 7px;
      }

      .ac-drawer--open .ac-drawer-body { display: block; }

      /* ── Search ── */
      .ac-drawer-search-wrap {
        position: relative;
        margin-bottom: 5px;
      }

      .ac-drawer-search-icon {
        position: absolute;
        left: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 10px;
        height: 10px;
        color: var(--muted);
        pointer-events: none;
      }

      .ac-drawer-search {
        width: 100%;
        box-sizing: border-box;
        padding: 3px 6px 3px 20px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--bg);
        color: var(--text);
        font-size: 11px;
        font-family: inherit;
        outline: none;
        transition: border-color .15s;
      }

      .ac-drawer-search::placeholder { color: var(--muted); }
      .ac-drawer-search:focus { border-color: var(--accent); }

      /* ── Scrollable list ── */
      .ac-legend-scroll {
        max-height: calc(7 * 24px);
        overflow-y: auto;
        overflow-x: hidden;
        scrollbar-width: thin;
        scrollbar-color: var(--border) transparent;
      }

      .ac-legend-empty {
        font-size: 11px;
        color: var(--muted);
        padding: 3px 2px 0;
        margin: 0;
      }

      /* ── Legend rows ── */
      .ac-legend {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }

      .ac-legend-item {
        display: flex;
        align-items: center;
        width: 100%;
        box-sizing: border-box;
        border-radius: 4px;
        border: none;
        border-left: 2.5px solid var(--lc, #888);
        padding: 3px 6px;
        height: 23px;
        gap: 5px;
        background: transparent;
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
        color: var(--text);
        transition: opacity .15s, background .15s;
      }

      .ac-legend-item:hover         { background: rgba(0,0,0,.05); }
      .ac-legend-item--active       { background: color-mix(in srgb, var(--lc, #888) 12%, transparent); }
      .ac-legend-item--faded        { opacity: .28; }

      .ac-legend-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--lc, #888);
        flex-shrink: 0;
      }

      .ac-legend-name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
      }

      .ac-legend-val {
        font-size: 10px;
        font-weight: 700;
        padding: 1px 4px;
        border-radius: 10px;
      }

      .ac-legend-val--above { background: var(--green-bg);  color: var(--green); }
      .ac-legend-val--below { background: var(--red-bg);    color: var(--accent); }

      /* ── Macro Layout (Analítico) ── */
      .ac-macro-row {
        display: flex;
        gap: 16px;
        align-items: stretch;
      }

      .ac-macro-chart-wrap {
        flex: 2;
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
      }

      .ac-trend-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        justify-content: center;
        margin-top: 8px;
      }

      .ac-legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--text-2);
      }

      .ac-legend-color {
        width: 12px;
        height: 12px;
        border-radius: 3px;
        display: inline-block;
      }

      .ac-macro-subtitle {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--muted-strong);
        margin-bottom: 8px;
        letter-spacing: 0.05em;
      }

      .ac-macro-highlights {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .ac-macro-card {
        flex: 1;
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
        display: flex;
        flex-direction: column;
      }

      .ac-macro-card-head {
        margin-bottom: 10px;
      }

      .ac-macro-card-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--text);
        letter-spacing: 0.05em;
      }

      .ac-macro-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }



      .ac-macro-team {
        font-weight: 600;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ac-macro-val {
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 10px;
      }

      .ac-macro-val--good { background: var(--green-bg); color: var(--green); }
      .ac-macro-val--bad { background: var(--red-bg); color: var(--accent); }

      .ac-macro-empty {
        font-size: 11px;
        color: var(--muted-strong);
        font-style: italic;
        padding: 8px 4px;
      }

      .ac-trend-area {
        fill: rgba(37, 99, 235, 0.1);
      }

      /* ── Persistent legend panel ── */
      .ac-legend-panel {
        flex-shrink: 0;
        width: 176px;
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 5px;
        max-height: 230px;
        overflow: hidden;
      }

      .ac-legend-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 5px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }

      .ac-legend-panel-title {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted-strong);
      }

      .ac-legend-panel-count {
        font-size: 9px;
        background: var(--border);
        border-radius: 20px;
        padding: 1px 5px;
        font-weight: 700;
        color: var(--muted-strong);
        line-height: 1.4;
      }

      .ac-legend-search-wrap {
        position: relative;
        flex-shrink: 0;
      }

      .ac-legend-panel .ac-legend-scroll {
        flex: 1;
        overflow-y: auto;
      }

      .ac-legend-panel .ac-flag-list {
        overflow-y: auto;
        flex: 1;
      }

      .analytic-chart-svg {
        display: block;
        width: 100%;
        min-width: 420px;
        height: auto;
      }

      .ac-grid {
        stroke: var(--border);
        stroke-width: 1;
        fill: none;
      }

      .ac-y-label, .ac-x-label {
        font-size: 9px;
        fill: var(--muted-strong);
        font-family: inherit;
      }

      .ac-meta-line {
        stroke: var(--accent);
        stroke-width: 1.5;
        stroke-dasharray: 5 3;
        fill: none;
      }

      .ac-meta-label {
        font-size: 9px;
        fill: var(--accent);
        font-weight: 700;
        font-family: inherit;
      }

      .ac-avg-line {
        stroke: var(--muted-strong);
        stroke-width: 1.2;
        stroke-dasharray: 3 3;
        fill: none;
      }

      .ac-avg-label {
        font-size: 9px;
        fill: var(--muted-strong);
        font-weight: 600;
        font-family: inherit;
      }

      /* Daily trend line — bold coloured line showing global average per day */
      .ac-trend-line {
        fill: none;
        stroke-width: 1.5;
        stroke-linejoin: round;
        stroke-linecap: round;
      }

      .ac-trend-dot {
        stroke: none;
        stroke-width: 0;
      }

      .ac-line {
        fill: none;
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
        cursor: pointer;
        transition: opacity .15s, stroke-width .15s;
      }

      .ac-line--active { stroke-width: 3; }
      .ac-line--faded  { opacity: .18; }

      .ac-line-hit {
        fill: none;
        stroke: transparent;
        stroke-width: 14;
        cursor: pointer;
        pointer-events: all;
      }

      .ac-pt {
        stroke: white;
        stroke-width: 1.5;
        cursor: pointer;
        transition: opacity .15s, r .1s;
      }

      .ac-pt--flagged {
        stroke: white;
        stroke-width: 2;
        filter: drop-shadow(0 0 3px currentColor);
      }

      .ac-pt--faded { opacity: .18; }

      .ac-pt--selected-day {
        stroke: white;
        stroke-width: 3;
        filter: drop-shadow(0 0 6px currentColor);
      }

      .ac-pt-hit {
        fill: transparent;
        stroke: transparent;
        stroke-width: 0;
        cursor: pointer;
      }

      /* ── Deviation panel ── */
      .ac-deviation-panel {
        margin-top: 14px;
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
        background: var(--surface-strong);
      }

      .ac-dev-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: var(--bg-2);
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }

      .ac-dev-team {
        font-weight: 700;
        font-size: 13px;
        border-left: 4px solid;
        padding-left: 8px;
      }

      .ac-dev-kpi-val {
        font-size: 13px;
        color: var(--muted-strong);
      }

      .ac-dev-kpi-val--above strong { color: var(--green); }
      .ac-dev-kpi-val--below strong { color: var(--accent); }

      .ac-dev-meta {
        font-size: 11px;
        color: var(--muted);
      }

      .ac-dev-close {
        margin-left: auto;
        background: transparent;
        border: none;
        cursor: pointer;
        font-size: 14px;
        color: var(--muted);
        padding: 2px 6px;
        border-radius: 6px;
        transition: background .12s;
      }

      .ac-dev-close:hover { background: var(--border); }

      .ac-dev-day-back {
        background: transparent;
        border: 1px solid var(--border);
        cursor: pointer;
        font-size: 11px;
        color: var(--accent);
        padding: 2px 8px;
        border-radius: 6px;
        transition: background .12s;
      }

      .ac-dev-day-back:hover { background: var(--border); }

      .ac-dev-list {
        display: flex;
        flex-direction: column;
        gap: 0;
      }

      .ac-dev-item {
        padding: 9px 14px;
        border-bottom: 1px solid var(--border);
      }

      .ac-dev-item:last-child { border-bottom: none; }

      .ac-dev-item-head {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        margin-bottom: 3px;
      }

      .ac-dev-day {
        font-weight: 600;
        font-size: 12px;
        color: var(--text);
      }

      .ac-dev-flag {
        font-size: 10px;
        font-weight: 700;
        background: var(--red-bg);
        color: var(--accent);
        border-radius: 8px;
        padding: 1px 7px;
      }

      .ac-dev-item-detail {
        font-size: 11px;
        color: var(--muted-strong);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ac-dev-ok {
        padding: 12px 14px;
        font-size: 13px;
        color: var(--green);
        margin: 0;
      }

      /* ── Breadcrumb drill-down header ── */
      .ac-breadcrumb-back {
        background: transparent;
        border: none;
        cursor: pointer;
        font-size: 18px;
        font-weight: 700;
        color: var(--muted-strong);
        padding: 0;
        font-family: inherit;
        text-decoration: underline dotted;
        transition: color .15s;
      }

      .ac-breadcrumb-back:hover { color: var(--text); }

      .ac-breadcrumb-sep {
        font-size: 18px;
        font-weight: 300;
        color: var(--muted);
        margin: 0 6px;
      }

      .ac-breadcrumb-team {
        font-size: 16px;
        font-weight: 700;
        color: var(--text);
      }

      .ac-breadcrumb-day {
        font-size: 14px;
        font-weight: 600;
        color: var(--accent);
      }

      /* ── Flag legend (drawer when team selected) ── */
      .ac-flag-legend {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .ac-flag-back-btn {
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        color: var(--accent);
        padding: 4px 6px 6px;
        font-family: inherit;
        text-align: left;
        transition: color .12s;
      }

      .ac-flag-back-btn:hover { color: var(--text); }

      .ac-flag-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding-top: 2px;
      }

      .ac-flag-row {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 3px 6px;
        border-radius: 4px;
        border-left: 3px solid var(--fc, #888);
        font-size: 11px;
      }

      .ac-flag-row--sub {
        margin-left: 10px;
        border-left-width: 2px;
        font-size: 10px;
        opacity: .85;
      }

      .ac-flag-row-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--fc, #888);
        flex-shrink: 0;
      }

      .ac-flag-row-label {
        flex: 1;
        font-weight: 600;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ac-flag-row-count {
        font-weight: 700;
        color: var(--fc, #888);
        font-size: 10px;
        background: color-mix(in srgb, var(--fc, #888) 12%, transparent);
        border-radius: 8px;
        padding: 1px 5px;
      }

      .ac-flag-row-min {
        font-size: 10px;
        font-weight: 600;
        color: var(--text-2, #888);
        opacity: 0.85;
        white-space: nowrap;
      }

      .ac-flag-empty {
        font-size: 11px;
        color: var(--green);
        padding: 4px 6px;
        margin: 0;
      }

      /* ── Deviation panel: context label + flag summary section ── */
      .ac-dev-context {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .ac-dev-context-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .1em;
        color: var(--muted);
      }

      .ac-dev-flags-section {
        padding: 10px 14px 8px;
        border-bottom: 1px solid var(--border);
      }

      .ac-dev-flags-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .08em;
        color: var(--muted-strong);
        margin: 0 0 6px;
      }

      .ac-dev-flags-list {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .ac-dev-flag-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 10px;
        border-radius: 6px;
        border-left: 3px solid var(--fc, #888);
        background: color-mix(in srgb, var(--fc, #888) 6%, transparent);
        font-size: 12px;
      }

      .ac-dev-flag-row--sub {
        margin-left: 16px;
        font-size: 11px;
        border-left-width: 2px;
        opacity: .88;
      }

      .ac-dev-flag-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--fc, #888);
        flex-shrink: 0;
      }

      .ac-dev-flag-name {
        flex: 1;
        font-weight: 600;
        color: var(--text);
      }

      .ac-dev-flag-count {
        font-weight: 700;
        font-size: 11px;
        color: var(--fc, #888);
        background: color-mix(in srgb, var(--fc, #888) 12%, transparent);
        border-radius: 10px;
        padding: 1px 7px;
      }

      .ac-dev-flag-min {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-2, #888);
        opacity: 0.85;
        white-space: nowrap;
      }

      .ac-dev-events-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .08em;
        color: var(--muted-strong);
        padding: 8px 14px 4px;
      }

      /* Ranking table */
      .analytic-ranking { margin-bottom: 32px; }

      .analytic-section-title {
        font-size: 17px;
        font-weight: 700;
        color: var(--text);
        margin: 0 0 4px;
      }

      .analytic-section-desc {
        font-size: 13px;
        color: var(--muted);
        margin: 0 0 14px;
      }

      .analytic-table-wrap {
        overflow-x: auto;
        border-radius: 12px;
        box-shadow: 0 1px 8px rgba(0,0,0,.06);
        border: 1px solid var(--border);
      }

      .analytic-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }

      .an-th {
        background: rgba(255,255,255,.55);
        padding: 10px 14px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .05em;
        color: var(--muted-strong);
        white-space: nowrap;
        border-bottom: 1px solid var(--border);
        text-align: left;
      }

      .an-th-rank  { width: 54px; text-align: center; }
      .an-th-team  { min-width: 160px; }

      .an-row {
        border-bottom: 1px solid var(--border);
        transition: background .12s;
      }

      .an-row:last-child { border-bottom: none; }
      .an-row:hover { background: var(--glass-hover); }

      .an-row--ok       { border-left: 3px solid var(--green); }
      .an-row--warn     { border-left: 3px solid #d97706; }
      .an-row--critical { border-left: 3px solid var(--accent); }

      .an-td {
        padding: 10px 14px;
        color: var(--text);
        background: transparent;
      }

      .an-td-center { text-align: center; }
      .an-td-team   { font-weight: 600; }
      .an-td-score  { font-weight: 700; }

      .an-score--good { color: var(--green); }
      .an-score--mid  { color: #d97706; }
      .an-score--bad  { color: var(--accent); }

      .an-status {
        display: inline-block;
        padding: 3px 10px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
      }

      .an-status--ok       { background: var(--green-bg);      color: var(--green); }
      .an-status--warn     { background: rgba(217,119,6,.1);   color: #b45309; }
      .an-status--critical { background: var(--red-bg);        color: var(--accent); }

      /* ====================================== */

      @media print {
        .filter-drawer, .filter-fab, .report-filter-bar,
        .rpt-export-btn, .drawer-backdrop,
        .export-modal-backdrop, .export-modal,
        app-toc-nav, .toc-nav,
        .report-loading { display: none !important; }
        .shell {
          background: #fff !important;
          min-height: unset !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        .anim-el { opacity: 1 !important; transform: none !important; }
        .kpi-cr-fill { transition: none !important; }
        .kpi-section { break-inside: avoid; page-break-inside: avoid; }
        .rpt-section { break-inside: avoid; page-break-inside: avoid; }
        .exec-summary { break-inside: avoid; page-break-inside: avoid; }
        .rpt-action-card { break-inside: avoid; page-break-inside: avoid; }
        .rpt-osdia-grid, .rpt-eficiencia-grid { break-inside: avoid; page-break-inside: avoid; }
      }
    `,
  ],
})
export class DashboardComponent implements OnInit, OnDestroy, AfterViewInit {
  protected readonly api = inject(ScannerApiService);
  private readonly zone = inject(NgZone);
  private readonly pdfService = inject(DashboardPdfService);
  private readonly chartService = inject(DashboardChartService);
  private readonly sanitizer = inject(DomSanitizer);
  protected readonly allOption = ALL_OPTION;

  @ViewChild('sliderFill') private sliderFillRef?: ElementRef<HTMLDivElement>;
  @ViewChild('sliderThumbMin') private sliderThumbMinRef?: ElementRef<HTMLInputElement>;
  @ViewChild('sliderThumbMax') private sliderThumbMaxRef?: ElementRef<HTMLInputElement>;
  @ViewChild('minNumInput') private minNumInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('maxNumInput') private maxNumInputRef?: ElementRef<HTMLInputElement>;

  protected readonly loading = signal(false);
  protected readonly progressMessage = signal('');
  protected readonly progressLog = signal<string[]>([]);
  protected readonly latestFilterLog = computed(() => {
    const log = this.progressLog();
    return log.length > 0 ? log[log.length - 1] : '';
  });
  protected readonly generatingReport = computed(() => this.progressMessage().toLowerCase().startsWith('gerando relat'));
  protected readonly errorMessage = signal('');
  protected readonly filterDrawerOpen = signal(false);
  protected readonly selectedTrendLine = signal<string | null>(null);

  toggleTrendLine(base: string, teamType: string) {
    const id = `${base}|${teamType}`;
    if (this.selectedTrendLine() === id) {
      this.selectedTrendLine.set(null);
    } else {
      this.selectedTrendLine.set(id);
    }
  }
  protected readonly exportModalOpen = signal(false);
  protected readonly exportModalStep = signal<'mode' | 'bases'>('mode');
  protected readonly exportModeType = signal<'proprias' | 'parceiras'>('proprias');
  protected readonly exportLoading = signal(false);
  protected readonly exportError = signal('');
  protected readonly includeAttentionMessage = signal(true);
  /** Arquivos prontos aguardando gesto do usuário para navigator.share. */
  protected readonly pendingShareFiles = signal<File[] | null>(null);
  protected readonly pendingShareText = signal<string | null>(null);
  protected readonly selectedDayPerKpi = signal<Record<string, string | null>>({});
  protected readonly expandedTeamDetails = signal<{ team: string; kpi: string; perTeamDailyData?: any } | null>(null);
  protected readonly kpiStates = signal<Record<string, { expanded: boolean }>>({});
  protected readonly pendingShareMode = signal<'current' | 'proprias' | 'parceiras' | null>(null);
  /** Modo cujo botão Compartilhar está carregando no momento. */
  protected readonly shareModeLoading = signal<'current' | 'proprias' | 'parceiras' | null>(null);
  protected reportBaseOptions: string[] = [];
  protected availablePropriasBases: string[] = [];
  protected availableParceirasBases: string[] = [];
  protected reportBasePrefixMap: Record<string, { own: string; partner: string }> = {};
  protected basesConfig: BasesConfig | null = null;
  protected availableDates: string[] = [];
  protected readonly reportBarHidden = signal(true);
  protected readonly reportData = signal<GeneratedReport | null>(null);
  protected readonly reportTitle = signal(DEFAULT_REPORT_TITLE);
  protected readonly reportType = signal<ReportTypeValue>('operacional');
  protected readonly selectFilters = signal<SelectFilterState[]>([]);
  protected readonly analiticoFilters = signal<ReportSelectFilterState[]>([]);
  protected readonly operacionalFilters = signal<ReportSelectFilterState[]>([]);
  protected readonly reportFilterStates = computed(() => this.reportType() === 'analitico' ? this.analiticoFilters() : this.operacionalFilters());
  protected readonly pendingScrollToKpi = signal<string | null>(null);

  protected setReportFilterStates(newState: ReportSelectFilterState[], mode?: ReportTypeValue): void {
    const targetMode = mode ?? this.reportType();
    if (targetMode === 'analitico') {
      this.analiticoFilters.set(newState);
    } else {
      this.operacionalFilters.set(newState);
    }
  }
  protected readonly openDropdownKey = signal<string | null>(null);
  protected readonly dropdownSearch = signal('');
  protected readonly dayRange = signal({ min: 1, max: 31 });
  protected readonly resolvedDayRange = computed(() => {
    const r = this.dayRange();
    // When multiple months are selected we allow the day-range to span across
    // month boundaries (e.g. 29 .. 2 to mean 29 of first month → 2 of next).
    // In that case we must preserve the raw values and NOT reorder them.
    const monthFilter = this.periodFilters().find((f) => f.key === 'mes');
    const activeMonths = (monthFilter?.value ?? []).filter((m) => m !== ALL_OPTION);
    if (activeMonths.length > 1) {
      return { min: r.min, max: r.max };
    }

    return { min: Math.min(r.min, r.max), max: Math.max(r.min, r.max) };
  });
  protected readonly reportTypeOptions = REPORT_TYPE_OPTIONS;
  protected readonly reportTypeLabel = computed(() => {
    const opt = this.reportTypeOptions.find((o) => o.value === this.reportType());
    return opt ? opt.label : 'Operacional';
  });
  protected readonly filtersVisible = computed(() => this.selectFilters().length > 0);
  protected readonly periodFilters = computed(() => this.selectFilters().filter((filter) => filter.key === 'ano' || filter.key === 'mes'));
  protected readonly secondaryFilters = computed(() => this.selectFilters().filter((filter) => filter.key !== 'ano' && filter.key !== 'mes'));
  protected readonly dayLimit = computed(() => {
    const year = this.periodFilters().find((filter) => filter.key === 'ano')?.value ?? [];
    const month = this.periodFilters().find((filter) => filter.key === 'mes')?.value ?? [];
    return this.dayLimitForMonthPosition(year, month, 'last');
  });
  // Upper bound for the MIN (start) slider — max day of the FIRST selected month
  protected readonly dayLimitMin = computed(() => {
    const year = this.periodFilters().find((filter) => filter.key === 'ano')?.value ?? [];
    const month = this.periodFilters().find((filter) => filter.key === 'mes')?.value ?? [];
    return this.dayLimitForMonthPosition(year, month, 'first');
  });
  protected readonly periodRangeLabel = computed(() => {
    // Prefer the actual date range from the downloaded file data over the filter selection
    const dataRange = this.reportData()?.dataDateRange;
    if (dataRange) {
      return dataRange.min === dataRange.max ? dataRange.min : `${dataRange.min} a ${dataRange.max}`;
    }

    const monthAbbrevToNum: Record<string, string> = {
      jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06',
      jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
    };
    const monthFilter = this.periodFilters().find((f) => f.key === 'mes');
    const yearFilter = this.periodFilters().find((f) => f.key === 'ano');
    const activeMonths = (monthFilter?.value ?? [])
      .filter((m) => m !== ALL_OPTION)
      .map((m) => ({ abbr: m, num: monthAbbrevToNum[m] ?? '??' }))
      .sort((a, b) => parseInt(a.num) - parseInt(b.num));
    const activeYears = (yearFilter?.value ?? []).filter((y) => y !== ALL_OPTION).sort();
    if (activeMonths.length === 0) return '';
    const range = this.resolvedDayRange();
    const pad = (n: number) => String(n).padStart(2, '0');
    const firstYear = activeYears[0] ?? String(new Date().getFullYear());
    const lastYear = activeYears[activeYears.length - 1] ?? firstYear;
    const startFull = `${pad(range.min)}/${activeMonths[0].num}/${firstYear}`;
    const endFull = `${pad(range.max)}/${activeMonths[activeMonths.length - 1].num}/${lastYear}`;
    return startFull === endFull ? startFull : `${startFull} a ${endFull}`;
  });

  // True when more than one month is selected — triggers dd/mm mode
  protected readonly multiMonthSelected = computed(() => {
    const monthFilter = this.periodFilters().find((f) => f.key === 'mes');
    return (monthFilter?.value ?? []).filter((m) => m !== ALL_OPTION).length > 1;
  });
  private readonly sortedActiveMonthIndexes = computed(() => {
    const monthFilter = this.periodFilters().find((f) => f.key === 'mes');
    return (monthFilter?.value ?? [])
      .filter((m) => m !== ALL_OPTION)
      .map((m) => MONTH_OPTIONS.indexOf(m))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b);
  });
  // Days available per selected month (in order), respecting D-2 cap on current month
  protected readonly monthDayCounts = computed(() => {
    const year = this.periodFilters().find((f) => f.key === 'ano')?.value ?? [];
    const indexes = this.sortedActiveMonthIndexes();
    if (indexes.length === 0) return [];
    const currentDate = new Date();
    const normalizedYears = year.filter((v) => v !== ALL_OPTION).map(Number).filter(Number.isFinite);
    const resolvedYear = normalizedYears.length > 0 ? Math.max(...normalizedYears) : currentDate.getFullYear();
    return indexes.map((idx) => {
      const maxDay = new Date(resolvedYear, idx + 1, 0).getDate();
      const isCurrentPeriod = resolvedYear === currentDate.getFullYear() && idx === currentDate.getMonth();
      const days = isCurrentPeriod ? Math.max(Math.min(maxDay, currentDate.getDate() - 2), 1) : maxDay;
      return { monthIndex: idx, days };
    });
  });
  // Total days across all selected months (slider max in multi-month mode)
  protected readonly sliderTotal = computed(() => {
    if (!this.multiMonthSelected()) return this.dayLimit();
    return this.monthDayCounts().reduce((sum, m) => sum + m.days, 0);
  });
  // Raw position of the left thumb (thumb 1) — may be > sliderMax when thumbs cross
  protected readonly sliderMin = computed(() => this.dayRange().min);
  // Raw absolute position of the right thumb (thumb 2)
  protected readonly sliderMax = computed(() => {
    if (!this.multiMonthSelected()) return this.dayRange().max;
    const counts = this.monthDayCounts();
    const daysBeforeLast = counts.slice(0, -1).reduce((sum, m) => sum + m.days, 0);
    return daysBeforeLast + this.dayRange().max;
  });
  // Display label for the start day input (e.g. "29/04" in multi-month mode)
  protected readonly dayMinLabel = computed(() => {
    const indexes = this.sortedActiveMonthIndexes();
    if (indexes.length <= 1) return String(this.resolvedDayRange().min);
    const monthNum = String(indexes[0] + 1).padStart(2, '0');
    const day = String(this.resolvedDayRange().min).padStart(2, '0');
    return `${day}/${monthNum}`;
  });
  // Display label for the end day input (e.g. "02/05" in multi-month mode)
  protected readonly dayMaxLabel = computed(() => {
    const indexes = this.sortedActiveMonthIndexes();
    if (indexes.length <= 1) return String(this.resolvedDayRange().max);
    const monthNum = String(indexes[indexes.length - 1] + 1).padStart(2, '0');
    const day = String(this.resolvedDayRange().max).padStart(2, '0');
    return `${day}/${monthNum}`;
  });
  // Left edge of the red fill as a percentage of the track (0-100)
  protected readonly fillLeft = computed(() => {
    const total = this.sliderTotal();
    const lo = Math.min(this.sliderMin(), this.sliderMax());
    return total > 1 ? ((lo - 1) / (total - 1)) * 100 : 0;
  });
  // Width of the red fill as a percentage
  protected readonly fillWidth = computed(() => {
    const total = this.sliderTotal();
    const lo = Math.min(this.sliderMin(), this.sliderMax());
    const hi = Math.max(this.sliderMin(), this.sliderMax());
    if (total <= 1) return 100;
    return ((hi - lo) / (total - 1)) * 100;
  });
  // Legacy aliases used by periodRangeLabel and buildPeriodSelection
  protected readonly dayRangeStart = this.fillLeft;
  protected readonly dayRangeEnd = computed(() => {
    const total = this.sliderTotal();
    const hi = Math.max(this.sliderMin(), this.sliderMax());
    return total > 1 ? ((hi - 1) / (total - 1)) * 100 : 100;
  });
  // Swap z-index when thumb 1 is at or past thumb 2 so both remain clickable
  protected readonly dayRangeMinOnTop = computed(() => {
    return this.dayRange().min >= this.dayRange().max || this.sliderMin() >= this.sliderTotal();
  });

  private scrollObserver?: IntersectionObserver;

  private activeDownloadRequest?: Subscription;
  private activeDownloadAbort?: AbortController;
  private reportRefreshSubscription?: Subscription;
  private reportApplyTimer: ReturnType<typeof setTimeout> | null = null;
  private reportBarHideTimer: ReturnType<typeof setTimeout> | null = null;
  private isPointerInTopRevealZone = false;
  private hasLoadedDownloadData = false;
  private availableTeams: string[] = [];
  private dragSelectionState: { key: FilterKey; mode: 'add' | 'remove'; anchorIndex: number; baseline: Set<string> } | null = null;
  private dragScrollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly boundEndFilterDrag = () => {
    this.dragSelectionState = null;
    this.dragScrollTimer = null;
  };
  private readonly boundKeyDown = (_event: KeyboardEvent) => {
    // F5 reloads the page normally, which triggers submit() via ngOnInit
  };
  private readonly boundCloseDropdown = (event: MouseEvent) => {
    if (this.openDropdownKey() !== null) {
      const target = event.target as HTMLElement;
      if (!target.closest('.rf-chip')) {
        this.zone.run(() => {
          this.openDropdownKey.set(null);
          this.dropdownSearch.set('');
        });
      }
    }
  };
  private readonly boundWindowMouseMove = (event: MouseEvent) => {
    const topRevealZonePx = 42;
    const isInTopZone = event.clientY <= topRevealZonePx;

    if (isInTopZone) {
      this.isPointerInTopRevealZone = true;
      if (this.reportBarHideTimer) {
        clearTimeout(this.reportBarHideTimer);
        this.reportBarHideTimer = null;
      }
      this.reportBarHidden.set(false);
      return;
    }

    if (this.isPointerInTopRevealZone) {
      this.isPointerInTopRevealZone = false;

      if (this.reportBarHideTimer) {
        clearTimeout(this.reportBarHideTimer);
      }

      this.reportBarHideTimer = setTimeout(() => {
        this.reportBarHidden.set(true);
        this.reportBarHideTimer = null;
      }, 7000);
    }
  };

  public ngOnInit(): void {
    this.api.getBasesConfig().subscribe(config => {
      this.basesConfig = config;
      const options: string[] = [];
      const prefixMap: Record<string, { own: string; partner: string }> = {};
      for (const polo of config.polos) {
        for (const base of polo.bases) {
          options.push(base.name);
          if (polo.matchType === 'direct_prefix') {
            prefixMap[base.name] = {
              own: base.propria?.[0] || '',
              partner: base.parceira?.[0] || ''
            };
          } else if (polo.matchType === 'infix_type_with_base_prefix') {
            prefixMap[base.name] = {
              own: (base.prefixes?.[0] || '') + (polo.typeIdentifiers?.propria[0] || ''),
              partner: (base.prefixes?.[0] || '') + (polo.typeIdentifiers?.parceira[0] || '')
            };
          }
        }
      }
      this.reportBaseOptions = options;
      this.reportBasePrefixMap = prefixMap;

      const updateFilters = (filters: ReportSelectFilterState[], mode: ReportTypeValue) => {
        const baseFilter = filters.find(f => f.key === 'reportBase');
        if (baseFilter) {
          baseFilter.options = mode === 'analitico'
            ? this.withAllOption(['Média Global', ...options])
            : this.withAllOption(options);
        }
        return this.cascadeReportFilters(filters, mode);
      };

      this.analiticoFilters.set(updateFilters(this.analiticoFilters(), 'analitico'));
      this.operacionalFilters.set(updateFilters(this.operacionalFilters(), 'operacional'));
    });

    const saved = this.loadFromStorage();
    // Restore extraction filters (ano, mes, etc.) only for context — not used on F5
    const overrides = saved ? new Map(Object.entries(saved.filters) as [FilterKey, string[]][]) : undefined;
    const builtFilters = this.buildSelectFilters(overrides);
    this.selectFilters.set(builtFilters);

    // Restore report filters (Base, Tipo Equipe, Equipe) from storage
    const baseAnaliticoFilters = this.buildReportFilterStates('analitico');
    const baseOperacionalFilters = this.buildReportFilterStates('operacional');

    if (saved?.analiticoFilters && saved?.operacionalFilters) {
      const restoredA = baseAnaliticoFilters.map((f) => {
        const savedVal = saved.analiticoFilters![f.key];
        return savedVal ? { ...f, value: savedVal } : f;
      });
      const restoredO = baseOperacionalFilters.map((f) => {
        const savedVal = saved.operacionalFilters![f.key];
        return savedVal ? { ...f, value: savedVal } : f;
      });
      this.analiticoFilters.set(this.cascadeReportFilters(restoredA, 'analitico'));
      this.operacionalFilters.set(this.cascadeReportFilters(restoredO, 'operacional'));
    } else if (saved?.reportFilters) {
      const restoredA = baseAnaliticoFilters.map((f) => {
        const savedVal = saved.reportFilters![f.key];
        return savedVal ? { ...f, value: savedVal } : f;
      });
      const restoredO = baseOperacionalFilters.map((f) => {
        const savedVal = saved.reportFilters![f.key];
        return savedVal ? { ...f, value: savedVal } : f;
      });
      this.analiticoFilters.set(this.cascadeReportFilters(restoredA, 'analitico'));
      this.operacionalFilters.set(this.cascadeReportFilters(restoredO, 'operacional'));
    } else {
      this.analiticoFilters.set(baseAnaliticoFilters);
      this.operacionalFilters.set(baseOperacionalFilters);
    }

    if (saved) {
      this.reportType.set(saved.reportType);
      if (saved.dayRange) {
        this.dayRange.set(saved.dayRange);
      } else {
        this.dayRange.set(this.buildDayRange(new Map(builtFilters.map((filter) => [filter.key, filter.value]))));
      }
    } else {
      this.dayRange.set(this.buildDayRange(new Map(builtFilters.map((filter) => [filter.key, filter.value]))));
    }
    window.addEventListener('mouseup', this.boundEndFilterDrag);
    window.addEventListener('mousemove', this.boundWindowMouseMove, { passive: true });
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('click', this.boundCloseDropdown, true);

    // Auto-regenerate report on page load (including F5 reload) using backend-cached data
    setTimeout(() => this.regenerateReport(), 0);
  }

  public ngOnDestroy(): void {
    window.removeEventListener('mouseup', this.boundEndFilterDrag);
    window.removeEventListener('mousemove', this.boundWindowMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('click', this.boundCloseDropdown, true);
    if (this.reportApplyTimer) {
      clearTimeout(this.reportApplyTimer);
      this.reportApplyTimer = null;
    }
    if (this.reportBarHideTimer) {
      clearTimeout(this.reportBarHideTimer);
      this.reportBarHideTimer = null;
    }
    this.reportRefreshSubscription?.unsubscribe();
    this.cancelActiveDownloadRequest();
    this.scrollObserver?.disconnect();
  }

  public ngAfterViewInit(): void {
    if (!('IntersectionObserver' in window)) return;
    this.scrollObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('anim-in');
            this.scrollObserver?.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.06 },
    );
  }

  private setupAnimations(): void {
    setTimeout(() => {
      document.querySelectorAll('.anim-el').forEach((el) => this.scrollObserver?.observe(el));
    }, 60);
  }

  private executePendingScroll(): void {
    const kpi = this.pendingScrollToKpi();
    if (kpi) {
      setTimeout(() => {
        const kpiEl = document.getElementById(`kpi-${kpi}`);
        if (kpiEl) {
          kpiEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          this.pendingScrollToKpi.set(null);
        }
      }, 150);
    }
  }

  protected barWidthPct(value: number, kpiName: string, kpi?: { chartConfig?: { worst: number; best: number; direction: 'h' | 'l' } }): number {
    const cfg = kpi?.chartConfig;
    if (!cfg || !Number.isFinite(value)) return 0;
    const pct = cfg.direction === 'h'
      ? (value - cfg.worst) / (cfg.best - cfg.worst) * 100
      : (cfg.worst - value) / (cfg.worst - cfg.best) * 100;
    return Math.max(2, Math.min(100, pct));
  }

  protected kpiMetaPct(kpiName: string, metaTarget: number, kpi?: { chartConfig?: { worst: number; best: number; direction: 'h' | 'l' } }): number {
    return this.barWidthPct(metaTarget, kpiName, kpi);
  }

  protected exportPdf(): void {
    this.openExportModal();
  }

  protected openExportModal(): void {
    this.exportModalStep.set('mode');
    this.exportError.set('');
    this.exportLoading.set(false);
    this.shareModeLoading.set(null);
    this.pendingShareFiles.set(null);
    this.pendingShareText.set(null);
    this.pendingShareMode.set(null);
    this.exportModalOpen.set(true);
  }

  protected closeExportModal(): void {
    this.exportModalOpen.set(false);
    this.shareModeLoading.set(null);
    this.pendingShareFiles.set(null);
    this.pendingShareText.set(null);
    this.pendingShareMode.set(null);
  }

  /**
   * Chamado quando o botão "Compartilhar" já tem arquivos prontos (pendingShareMode).
   * Nesse ponto temos um gesto fresco do usuário → navigator.share funciona.
   */
  protected async triggerPendingShare(): Promise<void> {
    const files = this.pendingShareFiles();
    if (!files) return;
    const text = this.pendingShareText() ?? '';
    await this.tryShare(files, text);
    this.pendingShareFiles.set(null);
    this.pendingShareText.set(null);
    this.pendingShareMode.set(null);
    this.exportModalOpen.set(false);
  }

  /**
   * Handler do botão Compartilhar — tudo em 1 clique:
   * busca dados no backend, gera PDFs, baixa e abre o Windows Share
   * tudo dentro da cadeia de Promise do gesto do usuário.
   */
  protected async shareMode(mode: 'current' | 'proprias' | 'parceiras'): Promise<void> {
    if (this.shareModeLoading()) return;
    this.shareModeLoading.set(mode);
    this.exportError.set('');
    try {
      const { files, sections } = await this.fetchAndBuildFiles(mode);
      const text = this.includeAttentionMessage() ? this.buildShareText(sections) : '';
      files.forEach(f => this.downloadFileFromMemory(f));
      await this.tryShare(files, text);
      this.exportModalOpen.set(false);
    } catch {
      this.exportError.set('Falha ao gerar o PDF. Tente novamente.');
    } finally {
      this.shareModeLoading.set(null);
    }
  }

  /** Busca dados no backend e gera File[] de PDF para o modo pedido. */
  private async fetchAndBuildFiles(mode: 'current' | 'proprias' | 'parceiras'): Promise<{ files: File[]; sections: { report: GeneratedReport; title: string }[] }> {
    if (mode === 'current') {
      const filters = this.buildReportFiltersPayload();
      const result = await firstValueFrom(
        this.api.exportData({
          reportFilters: { bases: filters.bases ?? [], teamTypes: filters.teamTypes ?? [], teams: filters.teams, dates: filters.dates },
        })
      );
      const hasTeams = filters.teams && filters.teams.length > 0;
      const subtitle = hasTeams
        ? filters.teams!.join(', ')
        : [
          filters.bases?.join(', ') || 'Todas as Bases',
          filters.teamTypes?.map(t => t === 'propria' ? 'Próprias' : 'Parceiras').join(', ') || 'Proprias e Parceiras',
        ].join(' · ');
      const section = { report: result.generatedReport, title: 'Relatório Atual', subtitle };
      const files = [await this.buildPdfFileForShare(section, 'atual')];
      return { files, sections: [section] };
    } else {
      const teamType: 'propria' | 'parceira' = mode === 'proprias' ? 'propria' : 'parceira';
      const typeLabel = mode === 'proprias' ? 'Equipes Próprias' : 'Equipes Parceiras';
      const et = mode as 'proprias' | 'parceiras';
      const basesToExport = et === 'proprias' ? this.availablePropriasBases : this.availableParceirasBases;
      const currentFilters = this.buildReportFiltersPayload();
      const results = await firstValueFrom(
        forkJoin(basesToExport.map(base =>
          this.api.exportData({ reportFilters: { bases: [base], teamTypes: [teamType], dates: currentFilters.dates } })
        ))
      );
      const sections = results.map((r, i) => ({
        report: r.generatedReport,
        title: basesToExport[i],
        subtitle: typeLabel,
      }));
      const files = await Promise.all(sections.map(s => this.buildPdfFileForShare(s, et)));
      return { files, sections };
    }
  }

  private buildShareText(sections: { report: GeneratedReport; title: string }[]): string {
    const periodStr = this.periodRangeLabel();
    const periodInfo = periodStr ? `*Período analisado: ${periodStr}*\n` : '';
    let text = `Bom dia/Boa tarde.\n${periodInfo}Segue o destaque dos principais pontos de atenção e desvios operacionais das equipes. Para a análise completa de cada técnico e seus respectivos gargalos, consulte o relatório da sua base em anexo.\n\n`;
    let hasAttentionTeams = false;

    for (const s of sections) {
      const scorecard = s.report.teamScorecard ?? [];
      const actionPlanMap = new Map((s.report.specialAnalysis?.actionPlan ?? []).map(ap => [ap.team, ap]));

      const osDiaMap = new Map((s.report.specialAnalysis?.osDiaAnalysis ?? []).map(a => [a.team, a]));

      const attentionTeams = scorecard.filter(team => {
        const utilizacao = team.kpis?.utilizacao ?? 100;
        const ociosidade = osDiaMap.get(team.team)?.idleAnalysis?.idlePct ?? 0;
        return team.kpisBelowMeta >= 4 || utilizacao < 50 || ociosidade >= 15;
      });

      if (attentionTeams.length === 0) continue;

      attentionTeams.sort((a, b) => {
        const utilA = (a.kpis?.utilizacao ?? 100) < 50 ? 1 : 0;
        const utilB = (b.kpis?.utilizacao ?? 100) < 50 ? 1 : 0;
        const idleA = (osDiaMap.get(a.team)?.idleAnalysis?.idlePct ?? 0) >= 15 ? 1 : 0;
        const idleB = (osDiaMap.get(b.team)?.idleAnalysis?.idlePct ?? 0) >= 15 ? 1 : 0;

        if (utilA !== utilB) return utilB - utilA;
        if (idleA !== idleB) return idleB - idleA;
        return (b.kpisBelowMeta || 0) - (a.kpisBelowMeta || 0);
      });

      hasAttentionTeams = true;
      text += `📍 Base ${s.title}:\n`;
      text += `⚠️ Equipes que merecem atenção:\n`;

      const topTeams = attentionTeams.slice(0, 3);
      for (const team of topTeams) {
        const util = team.kpis?.utilizacao ?? 100;
        const actionPlan = actionPlanMap.get(team.team);

        const kpisMap: Array<{ key: keyof TeamKpiScorecard['kpis'], statusKey: keyof TeamKpiScorecard['kpiStatus'], label: string, fmt: (v: any) => string }> = [
          { key: 'osDia', statusKey: 'osDia', label: 'OS Dia', fmt: v => v?.toFixed(1) },
          { key: 'eficiencia', statusKey: 'eficiencia', label: 'Eficiência', fmt: v => `${v?.toFixed(1)}%` },
          { key: 'utilizacao', statusKey: 'utilizacao', label: 'Utilização', fmt: v => `${v?.toFixed(1)}%` },
          { key: 'tmeImp', statusKey: 'tmeImp', label: 'TME IMP', fmt: v => `${v?.toFixed(0)}m` },
          { key: 'primeiroLogin', statusKey: 'primeiroLogin', label: '1º Login', fmt: v => `${v?.toFixed(0)}m` },
          { key: 'primeiroDesloc', statusKey: 'primeiroDesloc', label: '1º Desloc. da Base', fmt: v => `${v?.toFixed(0)}m` },
          { key: 'retornoBase', statusKey: 'retornoBase', label: 'Retorno Base', fmt: v => `${v?.toFixed(0)}m` },
        ];

        let kpisImpactados: string[] = [];
        kpisMap.forEach(k => {
          if (team.kpiStatus[k.statusKey] === 'below') {
            const val = team.kpis[k.key];
            if (val !== undefined) {
              kpisImpactados.push(`_${k.label}:_ *${k.fmt(val)}*`);
            }
          }
        });

        const utilAnalysis = s.report.specialAnalysis?.utilizacaoAnalysis?.find(a => a.team === team.team);
        const osDiaAnalysis = s.report.specialAnalysis?.osDiaAnalysis?.find(a => a.team === team.team);

        const allOrders = [...(utilAnalysis?.flaggedOrders || []), ...(utilAnalysis?.extraFlaggedOrders || [])];
        const flaggedOrders = utilAnalysis?.flaggedOrders || osDiaAnalysis?.flaggedOrders || [];

        let sumPrep = 0, countPrep = 0, maxPrep = 0;
        let sumSemOs = 0, countSemOs = 0, maxSemOs = 0;
        let teveIntervalo4a6 = false;

        for (const order of allOrders) {
          if (order.inicio_calendario && order.inicio_intervalo && order.inicio_intervalo.length > 10) {
            const parseDt = (dtStr: string) => {
              if (!dtStr) return 0;
              const [date, time] = dtStr.split(' ');
              if (!time) return 0;
              const [d, m, y] = date.split('/');
              const [h, min, sec] = time.split(':');
              const year = y.length === 2 ? 2000 + Number(y) : Number(y);
              return new Date(year, Number(m) - 1, Number(d), Number(h), Number(min), Number(sec || 0)).getTime();
            };
            const start = parseDt(order.inicio_calendario);
            const inter = parseDt(order.inicio_intervalo);
            if (start > 0 && inter > 0 && inter > start) {
              const diffH = (inter - start) / (1000 * 60 * 60);
              if (diffH >= 4 && diffH <= 6) teveIntervalo4a6 = true;
            }
          }
        }

        for (const order of flaggedOrders) {
          if (order.flags?.includes('temp_prep_alto') && order.temp_prep_os_min) {
            sumPrep += order.temp_prep_os_min;
            countPrep++;
            if (order.temp_prep_os_min > maxPrep) maxPrep = order.temp_prep_os_min;
          }
          if (order.flags?.includes('sem_os_alto') && order.sem_os_total_min) {
            sumSemOs += order.sem_os_total_min;
            countSemOs++;
            if (order.sem_os_total_min > maxSemOs) maxSemOs = order.sem_os_total_min;
          }
        }

        const motivos: string[] = [];
        if (util < 50) motivos.push('Utilização < 50%');
        if ((osDiaMap.get(team.team)?.idleAnalysis?.idlePct ?? 0) >= 15) motivos.push('Ociosidade ≥ 15%');
        if (team.kpisBelowMeta >= 4) motivos.push('4+ KPIs abaixo da meta');

        let desviosText = '';
        const infos = [];
        if (countPrep > 0 && maxPrep > 15) {
          infos.push(`_Partida Média:_ *${Math.round(sumPrep / countPrep)}m* (Max: *${Math.round(maxPrep)}m*)`);
        }
        if (countSemOs > 0 && maxSemOs > 15) {
          infos.push(`_Sem Ordem de Serviço Média:_ *${Math.round(sumSemOs / countSemOs)}m* (Max: *${Math.round(maxSemOs)}m*)`);
        }

        if (infos.length > 0) desviosText += infos.join(' | ');

        if (!teveIntervalo4a6) {
          desviosText += (desviosText ? ' | ' : '') + '*Intervalo NÃO declarado* (ou fora de 4h-6h)';
        }

        let linha = `• ${team.team} (Motivo: ${motivos.join(', ')}):\n`;
        if (kpisImpactados.length > 0) linha += `    ↳ KPIs Impactados: ${kpisImpactados.join(', ')}\n`;
        if (desviosText) linha += `    ↳ Desvios: ${desviosText}\n`;

        text += linha;
      }
      text += '\n';
    }

    if (!hasAttentionTeams) {
      return 'Bom dia/Boa tarde.\nSegue o destaque dos principais pontos de atenção e desvios operacionais das equipes. Para a análise completa de cada técnico e seus respectivos gargalos, consultem os PDFs em anexo.';
    }

    text += `*Obs: O tempo ocioso listado não é necessariamente de responsabilidade integral da equipe, sendo muitas vezes um reflexo do comportamento da operação como um todo (disponibilidade de ordens, priorização, atrasos em despachos, etc), sendo necessária uma investigação de cada supervisor.*`;

    return text.trim();
  }

  /**
   * Step 1: mode selection.
   * shareAfter = false → baixa direto para Downloads (pdfmake.download).
   * shareAfter = true  → gera Files em memória, baixa automaticamente e exibe
   *                      botão de compartilhamento no modal (fresh user-gesture
   *                      para navigator.share).
   */
  protected exportWithMode(mode: 'current' | 'proprias' | 'parceiras', shareAfter = false): void {
    const report = this.reportData();
    if (!report) return;

    const exportType = mode === 'current' ? 'atual' : mode;

    if (mode === 'current') {
      const filters = this.buildReportFiltersPayload();
      this.exportLoading.set(true);
      this.exportError.set('');
      this.api.exportData({ reportFilters: { bases: filters.bases ?? [], teamTypes: filters.teamTypes ?? [], teams: filters.teams, dates: filters.dates } }).subscribe({
        next: async (result) => {
          const hasTeams = filters.teams && filters.teams.length > 0;
          const subtitle = hasTeams
            ? filters.teams!.join(', ')
            : [
              filters.bases?.join(', ') || 'Todas as Bases',
              filters.teamTypes?.map((t) => t === 'propria' ? 'Próprias' : 'Parceiras').join(', ') || 'Proprias e Parceiras',
            ].join(' · ');
          const section = { report: result.generatedReport, title: 'Relatório Atual', subtitle };
          if (!shareAfter) {
            this.downloadPdfDirect(section, 'atual');
            this.zone.run(() => {
              this.exportLoading.set(false);
              this.exportModalOpen.set(false);
            });
          } else {
            try {
              const file = await this.buildPdfFileForShare(section, 'atual');
              this.downloadFileFromMemory(file);
              const text = this.includeAttentionMessage() ? this.buildShareText([section]) : '';
              const shared = await this.tryShare([file], text);
              this.zone.run(() => {
                this.exportLoading.set(false);
                if (shared) {
                  this.exportModalOpen.set(false);
                } else {
                  this.pendingShareFiles.set([file]);
                  this.pendingShareText.set(text);
                  this.pendingShareMode.set('current');
                }
              });
            } catch (pdfErr) {
              console.error('[PDF] Falha ao gerar PDF para compartilhamento:', pdfErr);
              this.zone.run(() => {
                this.exportLoading.set(false);
                this.exportError.set('Falha ao gerar o PDF. Tente novamente.');
              });
            }
          }
        },
        error: () => {
          this.exportLoading.set(false);
          this.exportError.set('Falha ao gerar dados de exportação. Verifique se o backend está disponível.');
        },
      });
      return;
    }

    const teamType: 'propria' | 'parceira' = mode === 'proprias' ? 'propria' : 'parceira';
    const typeLabel = mode === 'proprias' ? 'Equipes Próprias' : 'Equipes Parceiras';
    const et = exportType as 'proprias' | 'parceiras';

    const basesToExport = et === 'proprias' ? this.availablePropriasBases : this.availableParceirasBases;

    this.exportLoading.set(true);
    this.exportError.set('');

    const currentFilters = this.buildReportFiltersPayload();
    const requests = basesToExport.map((base) =>
      this.api.exportData({ reportFilters: { bases: [base], teamTypes: [teamType], dates: currentFilters.dates } })
    );

    forkJoin(requests).subscribe({
      next: async (results) => {
        const sections = results.map((result, i) => ({
          report: result.generatedReport,
          title: basesToExport[i],
          subtitle: typeLabel,
        }));
        if (!shareAfter) {
          sections.forEach((s) => this.downloadPdfDirect(s, et));
          this.zone.run(() => {
            this.exportLoading.set(false);
            this.exportModalOpen.set(false);
          });
        } else {
          try {
            const files = await Promise.all(sections.map((s) => this.buildPdfFileForShare(s, et)));
            files.forEach((f) => this.downloadFileFromMemory(f));
            const text = this.includeAttentionMessage() ? this.buildShareText(sections) : '';
            const shared = await this.tryShare(files, text);
            this.zone.run(() => {
              this.exportLoading.set(false);
              if (shared) {
                this.exportModalOpen.set(false);
              } else {
                this.pendingShareFiles.set(files);
                this.pendingShareText.set(text);
                this.pendingShareMode.set(mode as 'proprias' | 'parceiras');
              }
            });
          } catch (pdfErr) {
            console.error('[PDF] Falha ao gerar PDFs para compartilhamento:', pdfErr);
            this.zone.run(() => {
              this.exportLoading.set(false);
              this.exportError.set('Falha ao gerar os PDFs. Tente novamente.');
            });
          }
        }
      },
      error: () => {
        this.exportLoading.set(false);
        this.exportError.set('Falha ao gerar dados de exportação. Verifique se o backend está disponível.');
      },
    });
  }

  /** Dispara download de um File em memória (equivalente ao que pdfmake.download() faz internamente). */
  private downloadFileFromMemory(file: File): void {
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /**
   * Tenta abrir o Windows Share UI com os arquivos gerados.
   * Retorna true se navigator.share foi invocado com sucesso, false caso contrário.
   */
  private async tryShare(files: File[], text?: string | null): Promise<boolean> {
    if (!navigator.share) return false;
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files })) {
      console.warn('[Share] canShare({ files }) retornou false:', files.map(f => `${f.name} (${f.type})`));
      return false;
    }
    try {
      await navigator.share({
        title: 'Relatórios de Campo',
        text: text ?? 'Segue em anexo o(s) relatório(s) analítico(s).',
        files,
      });
      return true;
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.warn('[Share] falhou:', e);
      return false;
    }
  }

  /**
   * @deprecated use exportWithMode; kept for template compatibility
   */
  protected exportBase(base: string): void {
    const mode = this.exportModeType();
    const exportType: 'proprias' | 'parceiras' = mode === 'proprias' ? 'proprias' : 'parceiras';
    const teamType: 'propria' | 'parceira' = mode === 'proprias' ? 'propria' : 'parceira';
    const typeLabel = mode === 'proprias' ? 'Equipes Próprias' : 'Equipes Parceiras';

    this.exportLoading.set(true);
    this.exportError.set('');

    this.api.exportData({ reportFilters: { bases: [base], teamTypes: [teamType] } }).subscribe({
      next: (result) => {
        const section = { report: result.generatedReport, title: base, subtitle: typeLabel };
        this.downloadPdfDirect(section, exportType);
        this.exportLoading.set(false);
        this.exportModalOpen.set(false);
      },
      error: () => {
        this.exportLoading.set(false);
        this.exportError.set('Falha ao gerar dados de exportação. Verifique se o backend está disponível.');
      },
    });
  }

  private filterReportByTeamPrefix(report: GeneratedReport, prefix: string): GeneratedReport {
    return this.pdfService.filterReportByTeamPrefix(report, prefix);
  }

  private renderEmojiDataUrl(emoji: string, pxSize: number): string {
    return this.pdfService.renderEmojiDataUrl(emoji, pxSize);
  }

  private renderSymbolDataUrl(symbol: string, pxSize: number, color: string): string {
    return this.pdfService.renderSymbolDataUrl(symbol, pxSize, color);
  }

  private stripEmojiForPdf(text: string): string {
    return this.pdfService.stripEmojiForPdf(text);
  }

  /**
   * Constrói o nome seguro e o label de período para um PDF a partir do section + exportType.
   */
  private buildPdfFileName(
    section: { report: GeneratedReport; title: string; subtitle: string },
    exportType: 'atual' | 'proprias' | 'parceiras',
  ): { safeName: string; dateRangeLabel: string } {
    const monthAbbrevToNum: Record<string, string> = {
      jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06',
      jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
    };
    const monthFilter = this.periodFilters().find((f) => f.key === 'mes');
    const yearFilter = this.periodFilters().find((f) => f.key === 'ano');
    const activeMonths = (monthFilter?.value ?? [])
      .filter((m) => m !== ALL_OPTION)
      .map((m) => ({ abbr: m, num: monthAbbrevToNum[m] ?? '??' }))
      .sort((a, b) => parseInt(a.num) - parseInt(b.num));
    const activeYears = (yearFilter?.value ?? []).filter((y) => y !== ALL_OPTION).sort();

    const range = this.resolvedDayRange();
    const pad = (n: number): string => String(n).padStart(2, '0');

    let dateSuffix = '';
    let dateRangeLabel = '';

    const dataRange = section.report.dataDateRange;
    if (dataRange) {
      dateRangeLabel = dataRange.min === dataRange.max ? dataRange.min : `${dataRange.min} a ${dataRange.max}`;
      const parsePart = (s: string, i: number) => s.split('/')[i] ?? '';
      const startSuffix = `${parsePart(dataRange.min, 0)}-${parsePart(dataRange.min, 1)}`;
      const endSuffix = `${parsePart(dataRange.max, 0)}-${parsePart(dataRange.max, 1)}`;
      dateSuffix = ` ${startSuffix === endSuffix ? startSuffix : `${startSuffix} ao ${endSuffix}`}`;
    } else if (activeMonths.length > 0 && activeYears.length > 0) {
      const firstMonth = activeMonths[0].num;
      const lastMonth = activeMonths[activeMonths.length - 1].num;
      const firstYear = activeYears[0] ?? String(new Date().getFullYear());
      const lastYear = activeYears[activeYears.length - 1] ?? firstYear;
      const startDate = `${pad(range.min)}-${firstMonth}`;
      const endDate = `${pad(range.max)}-${lastMonth}`;
      dateSuffix = ` ${startDate === endDate ? startDate : `${startDate} ao ${endDate}`}`;
      const startFull = `${pad(range.min)}/${firstMonth}/${firstYear}`;
      const endFull = `${pad(range.max)}/${lastMonth}/${lastYear}`;
      dateRangeLabel = startFull === endFull ? startFull : `${startFull} a ${endFull}`;
    }

    const typePrefix = exportType === 'atual' ? 'Atual_'
      : exportType === 'proprias' ? 'Proprias_'
        : 'Parceiras_';

    // Remove termos redundantes: o prefixo já indica o tipo.
    // atual: título "Relatório Atual" é redundante → usar só o subtítulo (bases/equipes filtradas)
    // proprias/parceiras: subtítulo "Equipes Próprias/Parceiras" é redundante → usar só o título (nome da base)
    const namePart = exportType === 'atual' ? section.subtitle : section.title;

    const safeName = (typePrefix + `${namePart}${dateSuffix}`)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s-]/g, '').trim();

    return { safeName, dateRangeLabel };
  }

  /**
   * Baixa o PDF direto para Downloads via pdfmake.download() — não requer gesto de usuário.
   */
  private downloadPdfDirect(
    section: { report: GeneratedReport; title: string; subtitle: string },
    exportType: 'atual' | 'proprias' | 'parceiras',
  ): void {
    const { safeName, dateRangeLabel } = this.buildPdfFileName(section, exportType);
    const expandedKeys = exportType === 'atual' ? this.getExpandedEvidenceKeysSet() : undefined;
    this.pdfService.downloadPdf({ ...section, dateRangeLabel }, safeName, this.buildPdfHelpers(), expandedKeys, this.reportType());
  }

  /**
   * Gera o PDF como File em memória (para navigator.share). Não baixa automaticamente.
   */
  private buildPdfFileForShare(
    section: { report: GeneratedReport; title: string; subtitle: string },
    exportType: 'atual' | 'proprias' | 'parceiras',
  ): Promise<File> {
    const { safeName, dateRangeLabel } = this.buildPdfFileName(section, exportType);
    const expandedKeys = exportType === 'atual' ? this.getExpandedEvidenceKeysSet() : undefined;
    return this.pdfService.generatePdfFile({ ...section, dateRangeLabel }, safeName, this.buildPdfHelpers(), expandedKeys, this.reportType());
  }


  private buildPdfHelpers() {
    return {
      renderEmojiDataUrl: (e: string, s: number) => this.pdfService.renderEmojiDataUrl(e, s),
      renderSymbolDataUrl: (sym: string, s: number, c: string) => this.pdfService.renderSymbolDataUrl(sym, s, c),
      stripEmojiForPdf: (t: string) => this.pdfService.stripEmojiForPdf(t),
      semOsDetailLabel: (d: any, nrOrdemDespachoAnterior?: string) => this.semOsDetailLabel(d, nrOrdemDespachoAnterior),
      semOsDetailBody: (d: any, nrOrdemDespachoAnterior?: string) => this.semOsDetailBody(d, nrOrdemDespachoAnterior),
      osDiaFlagLabel: (f: string) => this.osDiaFlagLabel(f),
      eficienciaFlagLabel: (f: string) => this.eficienciaFlagLabel(f),
      tmeImpFlagLabel: (f: string) => this.tmeImpFlagLabel(f),
      loginFlagLabel: (f: string) => this.loginFlagLabel(f),
      deslocFlagLabel: (f: string) => this.deslocFlagLabel(f),
      retornoFlagLabel: (f: string) => this.retornoFlagLabel(f),
      analyticChartData: (kpi: any) => this.analyticChartData(kpi),
      osDiaAlertBody: (flag: string, ev: any) => this.osDiaAlertBody(flag, ev),
      eficienciaAlertBody: (flag: string, ev: any) => this.eficienciaAlertBody(flag, ev),
      tmeImpAlertBody: (flag: string, ev: any) => this.tmeImpAlertBody(flag, ev),
      loginAlertBody: (flag: string, ev: any) => this.loginAlertBody(flag, ev),
      deslocAlertBody: (flag: string, ev: any) => this.deslocAlertBody(flag, ev),
      retornoAlertBody: (flag: string, ev: any) => this.retornoAlertBody(flag, ev),
    };
  }

  protected openFilterDrawer(): void {
    this.filterDrawerOpen.set(true);
  }

  protected closeFilterDrawer(): void {
    this.filterDrawerOpen.set(false);
  }

  protected updateReportType(value: ReportTypeValue | string): void {
    if (!value) {
      return;
    }

    this.reportType.set(value as ReportTypeValue);

    // Update report filters to reflect changes in available options for 'analitico' mode
    // and re-evaluate valid combinations via cascadeReportFilters
    this.setReportFilterStates(this.cascadeReportFilters(this.reportFilterStates(), this.reportType()), this.reportType());

    this.saveToStorage();
    this.scheduleInstantReportRefresh();
    // Re-observe newly rendered anim-el elements after Angular renders the switched mode.
    setTimeout(() => this.setupAnimations(), 80);
  }

  // ─── Analytic mode state ───────────────────────────────────────────────────
  /** Per-KPI selected team (keyed by kpi section index so each KPI has its own independent selection). */
  protected readonly analyticSelectedTeam = signal<Record<number, string | null>>({});
  protected readonly analyticSelectedDay = signal<Record<number, string | null>>({});
  protected readonly analyticLegendOpen = signal<Record<number, boolean>>({});
  protected readonly analyticSearch = signal<Record<number, string>>({});

  // ─── "Ver mais..." per team state ────────────────────────────────
  /** Key format: `{kpiName}|{team}` — true when expanded. */
  protected readonly expandedEvidenceTeams = signal<Record<string, boolean>>({});

  /** Groups an array of evidence items by their date_ref field, sorted chronologically. */
  protected groupByDateRef<T extends { date_ref?: string }>(
    items: T[],
  ): Array<{ dateRef: string; items: T[] }> {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const key = (item.date_ref ?? '').trim() || '—';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    const parseDate = (s: string): number => {
      const p = s.split('/');
      return p.length >= 3 ? +p[2] * 10000 + +p[1] * 100 + +p[0] : 0;
    };
    return Array.from(map.entries())
      .map(([dateRef, grpItems]) => ({ dateRef, items: grpItems }))
      .sort((a, b) => parseDate(a.dateRef) - parseDate(b.dateRef));
  }

  /**
   * Returns date groups from both top flaggedOrders and extraFlaggedOrders.
   * Dates that only appear in extras get an empty items array so they still render.
   */
  protected allDateGroupsForKpi<T extends { date_ref?: string }>(
    top: T[],
    extra: T[] | undefined,
  ): Array<{ dateRef: string; items: T[] }> {
    const topGroups = this.groupByDateRef(top);
    const topDates = new Set(topGroups.map(g => g.dateRef));
    const extraOnlyDates = new Set(
      (extra ?? []).map(o => (o.date_ref ?? '').trim() || '—').filter(d => !topDates.has(d)),
    );
    const parseDate = (s: string): number => {
      const p = s.split('/');
      return p.length >= 3 ? +p[2] * 10000 + +p[1] * 100 + +p[0] : 0;
    };
    return [
      ...topGroups,
      ...[...extraOnlyDates].map(d => ({ dateRef: d, items: [] as T[] })),
    ].sort((a, b) => parseDate(a.dateRef) - parseDate(b.dateRef));
  }

  protected trackByDateRef(_: number, grp: { dateRef: string }): string {
    return grp.dateRef;
  }

  protected isTeamExpanded(kpiKey: string, team: string): boolean {
    return this.expandedEvidenceTeams()[`${kpiKey}|${team}`] ?? false;
  }

  protected toggleTeamExpanded(kpiKey: string, team: string): void {
    const key = `${kpiKey}|${team}`;
    this.expandedEvidenceTeams.update((cur) => ({ ...cur, [key]: !cur[key] }));
  }

  // ─── "Ver mais..." per date-ref group state (Legacy for Day-based KPIs) ───
  /** Key format: `{kpiName}|{team}|{dateRef}` — true when expanded. */
  protected readonly expandedEvidenceDates = signal<Record<string, boolean>>({});

  protected isDateExpanded(kpiKey: string, team: string, dateRef: string): boolean {
    return this.expandedEvidenceDates()[`${kpiKey}|${team}|${dateRef}`] ?? false;
  }

  protected toggleDateExpanded(kpiKey: string, team: string, dateRef: string): void {
    const key = `${kpiKey}|${team}|${dateRef}`;
    this.expandedEvidenceDates.update((cur) => ({ ...cur, [key]: !cur[key] }));
  }

  protected async exportTeamCardToPng(event: Event, teamName: string): Promise<void> {
    event.stopPropagation();
    try {
      const button = event.currentTarget as HTMLElement;
      // The card is the closest container for the team evidence
      const card = button.closest('.rpt-osdia-card') as HTMLElement;
      if (!card) return;

      // Temporarily hide the export button itself so it doesn't appear in the PNG
      const originalDisplay = button.style.display;
      button.style.display = 'none';

      // Função para exibir um aviso visual menor próximo ao botão
      const showToast = (msg: string, isError = false) => {
        const toast = document.createElement('div');
        toast.innerText = msg;
        toast.style.position = 'fixed';
        
        // Posição próxima ao botão
        const rect = button.getBoundingClientRect();
        toast.style.top = `${Math.max(10, rect.top - 36)}px`;
        toast.style.left = `${Math.max(10, rect.left - 130)}px`;
        
        toast.style.backgroundColor = isError ? '#ef4444' : '#10b981'; // Vermelho ou Verde
        toast.style.color = '#fff';
        toast.style.padding = '6px 12px';
        toast.style.borderRadius = '4px';
        toast.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
        toast.style.zIndex = '99999';
        toast.style.fontFamily = 'system-ui, sans-serif';
        toast.style.fontSize = '12px';
        toast.style.fontWeight = '600';
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.2s ease-in-out';
        
        document.body.appendChild(toast);
        
        // Fade in
        requestAnimationFrame(() => toast.style.opacity = '1');
        
        // Fade out
        setTimeout(() => {
          toast.style.opacity = '0';
          setTimeout(() => toast.remove(), 200);
        }, 2000); // 2 segundos
      };

      // Capture the card in high definition
      const canvas = await html2canvas(card, {
        backgroundColor: null, // Captura o fundo real do elemento na tela
        scale: 2, // Retina HD - optimal balance of speed and quality
        useCORS: true,
        logging: false
      });

      // Restore button
      button.style.display = originalDisplay;

      // Convert to blob
      canvas.toBlob(async (blob: Blob | null) => {
        if (!blob) {
          showToast('Falha ao gerar', true);
          return;
        }

        // Copia a imagem para a área de transferência
        try {
          if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': blob })
            ]);
            showToast('Copiado em HD! (Ctrl+V)');
          } else {
            showToast('Navegador não suporta', true);
          }
        } catch (e) {
          console.warn('Falha ao copiar para a área de transferência:', e);
          showToast('Erro ao copiar', true);
        }
      }, 'image/png');
    } catch (err) {
      console.error('Erro ao exportar card:', err);
    }
  }

  protected getExtraForDate<T extends { date_ref?: string }>(
    extra: T[] | undefined,
    dateRef: string,
  ): T[] {
    return (extra ?? []).filter((o) => ((o.date_ref ?? '').trim() || '—') === dateRef);
  }

  protected hasExtraForDate<T extends { date_ref?: string }>(
    extra: T[] | undefined,
    dateRef: string,
  ): boolean {
    return (extra ?? []).some((o) => ((o.date_ref ?? '').trim() || '—') === dateRef);
  }

  /** Returns the set of expanded evidence keys for PDF injection.
   *  Since expansion is now per-team, this could map all team dates if expanded.
   *  We merge both team keys and date keys so the PDF service can handle them.
   */
  private getExpandedEvidenceKeysSet(): Set<string> {
    return new Set([
      ...Object.entries(this.expandedEvidenceTeams())
        .filter(([, v]) => v)
        .map(([k]) => k),
      ...Object.entries(this.expandedEvidenceDates())
        .filter(([, v]) => v)
        .map(([k]) => k)
    ]);
  }

  protected toggleAnalyticLegend(index: number): void {
    this.analyticLegendOpen.update((cur) => ({ ...cur, [index]: !cur[index] }));
  }

  protected setAnalyticSearch(index: number, value: string): void {
    this.analyticSearch.update((cur) => ({ ...cur, [index]: value }));
  }

  protected filterAnalyticLines(
    lines: Array<{ team: string; color: string; above: boolean; displayValue: string; polyline: string; points: Array<{ x: number; y: number; dayIndex: number; dayLabel: string; flagged: boolean }>; deviations: Array<{ dateRef: string; flags: string[]; detail: string }> }>,
    index: number,
  ) {
    const q = (this.analyticSearch()[index] ?? '').trim().toLowerCase();
    return q ? lines.filter((l) => l.team.toLowerCase().includes(q)) : lines;
  }

  protected getAnalyticSelectedTeam(kpiIndex: number): string | null {
    return this.analyticSelectedTeam()[kpiIndex] ?? null;
  }

  protected getAnalyticSelectedDay(kpiIndex: number): string | null {
    return this.analyticSelectedDay()[kpiIndex] ?? null;
  }

  protected clearAnalyticDay(kpiIndex: number): void {
    this.analyticSelectedDay.update((cur) => ({ ...cur, [kpiIndex]: null }));
  }

  protected toggleAnalyticTeam(team: string, kpiIndex: number): void {
    const wasSelected = (this.analyticSelectedTeam()[kpiIndex] ?? null) === team;
    this.analyticSelectedTeam.update((cur) => ({ ...cur, [kpiIndex]: wasSelected ? null : team }));
    this.analyticSelectedDay.update((cur) => ({ ...cur, [kpiIndex]: null }));
    if (!wasSelected) {
      this.analyticLegendOpen.update((cur) => ({ ...cur, [kpiIndex]: true }));
    }
  }

  protected clearAnalyticTeam(kpiIndex: number): void {
    this.analyticSelectedTeam.update((cur) => ({ ...cur, [kpiIndex]: null }));
    this.analyticSelectedDay.update((cur) => ({ ...cur, [kpiIndex]: null }));
  }

  protected selectAnalyticPoint(team: string, dayLabel: string, kpiIndex: number, ev: MouseEvent): void {
    ev.stopPropagation();
    const wasSelected = (this.analyticSelectedTeam()[kpiIndex] ?? null) === team;
    const wasSameDay = this.analyticSelectedDay()[kpiIndex] === dayLabel;
    if (wasSelected && wasSameDay) {
      // Clicou no mesmo ponto novamente → volta para visão de média (linha)
      this.analyticSelectedDay.update((cur) => ({ ...cur, [kpiIndex]: null }));
    } else {
      this.analyticSelectedTeam.update((cur) => ({ ...cur, [kpiIndex]: team }));
      this.analyticSelectedDay.update((cur) => ({ ...cur, [kpiIndex]: dayLabel }));
      this.analyticLegendOpen.update((cur) => ({ ...cur, [kpiIndex]: true }));
    }
  }

  protected getDeviationsForDay(
    deviations: Array<{ dateRef: string; flags: string[]; detail: string }>,
    day: string | null,
  ) {
    return this.chartService.getDeviationsForDay(deviations, day);
  }

  protected getTeamFlagSummary(
    kpi: GeneratedReport['kpis'][number],
    team: string,
    report: GeneratedReport,
  ) {
    return this.chartService.getTeamFlagSummary(kpi, team, report);
  }

  protected getDayFlagSummary(
    kpi: GeneratedReport['kpis'][number],
    team: string,
    day: string | null,
    report: GeneratedReport,
  ) {
    return this.chartService.getDayFlagSummary(kpi, team, day, report);
  }

  protected getDayKpiValue(
    lines: Array<{ team: string; points: Array<{ dayLabel: string; displayVal: string }> }>,
    team: string,
    day: string | null,
  ) {
    return this.chartService.getDayKpiValue(lines, team, day);
  }

  protected getDayDeviationTotal(dayFlags: Array<{ totalMin: number }>): number {
    return this.chartService.getDayDeviationTotal(dayFlags);
  }

  public parseTeamBase(teamName: string): { base: string; teamType: 'propria' | 'parceira' | null } | null {
    const config = this.basesConfig;
    if (!config) return null;
    const upper = teamName.toUpperCase();
    for (const polo of config.polos) {
      if (polo.matchType === 'direct_prefix') {
        for (const base of polo.bases) {
          if (base.propria?.some((p: string) => upper.startsWith(p.toUpperCase()))) return { base: base.name, teamType: 'propria' };
          if (base.parceira?.some((p: string) => upper.startsWith(p.toUpperCase()))) return { base: base.name, teamType: 'parceira' };
        }
      } else if (polo.matchType === 'infix_type_with_base_prefix') {
        for (const base of polo.bases) {
          if (base.prefixes?.some((p: string) => upper.startsWith(p.toUpperCase()))) {
            let tType: 'propria' | 'parceira' | null = null;
            if (polo.typeIdentifiers?.propria.some((inf: string) => upper.includes(inf.toUpperCase()))) tType = 'propria';
            else if (polo.typeIdentifiers?.parceira.some((inf: string) => upper.includes(inf.toUpperCase()))) tType = 'parceira';
            return { base: base.name, teamType: tType };
          }
        }
      }
    }
    return null;
  }

  protected toggleKpiDay(kpiId: string, day: string | null, base?: string, teamType?: string): void {
    const current = { ...this.selectedDayPerKpi() };
    if (day === null) {
      current[kpiId] = null;
      if (base && teamType) {
        if (this.selectedTrendLine() !== `${base}|${teamType}`) {
          this.selectedTrendLine.set(`${base}|${teamType}`);
        } else {
          this.selectedTrendLine.set(null);
        }
      }
    } else {
      if (current[kpiId] === day && this.selectedTrendLine() === `${base}|${teamType}`) {
        current[kpiId] = null;
        this.selectedTrendLine.set(null);
      } else {
        current[kpiId] = day;
        if (base && teamType) {
          this.selectedTrendLine.set(`${base}|${teamType}`);
        }
      }
    }
    this.selectedDayPerKpi.set(current);
  }

  protected redirectFromExpandedToOperacional(dateLabel: string): void {
    const data = this.expandedTeamDetails();
    if (!data) return;

    this.expandedTeamDetails.set(null);

    const fullDate = this.availableDates.find(d => d.startsWith(dateLabel)) || dateLabel;

    const currentOpFilters = this.operacionalFilters();
    const updatedOpFilters = currentOpFilters.map(filter => {
      if (filter.key === 'reportDataRef') return { ...filter, value: [fullDate] };
      if (filter.key === 'reportEquipe') return { ...filter, value: [data.team] };
      return filter;
    });

    this.operacionalFilters.set(this.cascadeReportFilters(updatedOpFilters, 'operacional'));
    this.updateReportType('operacional');
    this.pendingScrollToKpi.set(data.kpi);
    this.scheduleInstantReportRefresh();
  }

  protected toggleTeamDetails(team: string, kpi: any): void {
    const current = this.expandedTeamDetails();
    if (current && current.team === team && current.kpi === kpi.kpi) {
      this.expandedTeamDetails.set(null);
    } else {
      this.expandedTeamDetails.set({ team, kpi: kpi.kpi, perTeamDailyData: kpi.perTeamDailyData });
    }
  }

  protected getTeamDailyDetails(data: any): Array<{ date: string; value: number }> {
    if (!data || !data.perTeamDailyData) return [];
    const teamData = data.perTeamDailyData.find((t: any) => t.team === data.team);
    if (!teamData || !teamData.dailyPoints) return [];
    return teamData.dailyPoints.filter((p: any) => p.value !== undefined).map((p: any) => ({ date: p.date, value: p.value }));
  }

  protected isTeamInBottomOsDia(teamName: string): boolean {
    const report = this.reportData();
    if (!report || !report.kpis) return false;
    const osDiaKpi = report.kpis.find((k: any) => k.kpi === 'OS Dia');
    if (!osDiaKpi || !osDiaKpi.opportunityTeams) return false;
    return osDiaKpi.opportunityTeams.some((t: any) => t.team === teamName);
  }

  protected getFilteredDestaques(kpi: any, cd: any): { top: any[]; bottom: any[]; selectedDay: string | null; selectedDayAvg?: number | null } {
    const selectedDay = this.selectedDayPerKpi()[kpi.kpi] || null;

    let rawTop: any[] = [];
    let rawBottom: any[] = [];
    let selectedDayAvg: number | null = null;

    if (!cd || !cd.trendLines || cd.trendLines.length === 0) {
      rawTop = [...(kpi.topTeams || [])];
      rawBottom = [...(kpi.opportunityTeams || [])];
    } else {
      const selected = this.selectedTrendLine();
      const activeCombos = new Set<string>();
      if (selected) {
        for (const tl of cd.trendLines) {
          if (`${tl.base}|${tl.teamType}` === selected) {
            const normType = tl.teamType.toLowerCase() === 'própria' ? 'propria' : (tl.teamType.toLowerCase() === 'parceira' ? 'parceira' : tl.teamType);
            activeCombos.add(`${tl.base}|${normType}`);
          }
        }
      }

      const filterTeamByCombo = (teamName: string) => {
        if (!selected) return true;
        const info = this.parseTeamBase(teamName);
        if (!info) return false;
        if (activeCombos.has(`${info.base}|All`)) return true;
        if (activeCombos.has(`Média Global|${info.teamType}`)) return true;
        if (activeCombos.has(`Média Global|All`)) return true;
        return activeCombos.has(`${info.base}|${info.teamType}`);
      };

      let filteredScores: any[] = [];
      if (selectedDay && kpi.perTeamDailyData) {
        for (const t of kpi.perTeamDailyData) {
          if (!filterTeamByCombo(t.team)) continue;
          const pt = t.dailyPoints.find((p: any) => p.date === selectedDay || p.date.startsWith(selectedDay + '/') || selectedDay.startsWith(p.date + '/'));
          if (pt && pt.value !== undefined) {
            filteredScores.push({ team: t.team, rawValue: pt.value });
          }
        }
      } else {
        filteredScores = (kpi.scores || []).filter((s: any) => filterTeamByCombo(s.team));
      }

      const direction = kpi.direction || 'higher-is-better';
      filteredScores.sort((a: any, b: any) => direction === 'higher-is-better' ? b.rawValue - a.rawValue : a.rawValue - b.rawValue);

      const opportunityPool = filteredScores.filter((s: any) =>
        direction === 'higher-is-better' ? s.rawValue < kpi.metaTarget : s.rawValue > kpi.metaTarget
      );

      if (selectedDay) {
        const trendLine = cd.trendLines.find((tl: any) => selected ? `${tl.base}|${tl.teamType}` === selected : tl.base === 'Global');
        if (trendLine) {
          const pt = trendLine.points.find((p: any) => p.label === selectedDay);
          if (pt) selectedDayAvg = pt.value;
        }
      }

      rawTop = filteredScores.slice(0, 3).map((s: any) => ({ team: s.team, value: s.rawValue }));
      rawBottom = opportunityPool.slice(-3).reverse().map((s: any) => ({ team: s.team, value: s.rawValue }));
    }

    // Apply Evidence Coherence Filtering
    const report = this.reportData();
    if (report && report.specialAnalysis) {
      if (kpi.kpi === 'Eficiência' && kpi.evidenceAnalysis) {
        const filteredEvi = this.sortedEficienciaAnalysis(kpi.evidenceAnalysis);
        const validTopTeams = new Set(filteredEvi.filter(a => a.analysisType === 'top_performer').map(a => a.team));
        const validBottomTeams = new Set(filteredEvi.filter(a => a.analysisType === 'underperformer').map(a => a.team));
        rawTop = rawTop.filter(t => validTopTeams.has(t.team));
        rawBottom = rawBottom.filter(t => validBottomTeams.has(t.team));
      } else if (['OS Dia', 'Utilização', 'TME IMP', '1º Login', '1º Desloc.', 'Retorno Base'].includes(kpi.kpi)) {
        let validBottomTeams = new Set<string>();
        if (kpi.kpi === 'OS Dia' && report.specialAnalysis.osDiaAnalysis) {
          validBottomTeams = new Set(this.filterOsDiaEvidence(report.specialAnalysis.osDiaAnalysis as any).map((a: any) => a.team));
        } else if (kpi.kpi === 'Utilização' && report.specialAnalysis.utilizacaoAnalysis) {
          validBottomTeams = new Set(report.specialAnalysis.utilizacaoAnalysis.filter((a: any) => a.flaggedOrders && a.flaggedOrders.length > 0).map((a: any) => a.team));
        } else if (kpi.kpi === 'TME IMP' && report.specialAnalysis.tmeImpAnalysis) {
          validBottomTeams = new Set(this.filterTmeImpEvidence(report.specialAnalysis.tmeImpAnalysis).map((a: any) => a.team));
        } else if (kpi.kpi === '1º Login' && report.specialAnalysis.primeiroLoginAnalysis) {
          validBottomTeams = new Set(this.filterLoginEvidence(report.specialAnalysis.primeiroLoginAnalysis).map((a: any) => a.team));
        } else if (kpi.kpi === '1º Desloc.' && report.specialAnalysis.primeiroDeslocAnalysis) {
          validBottomTeams = new Set(this.filterDeslocEvidence(report.specialAnalysis.primeiroDeslocAnalysis).map((a: any) => a.team));
        } else if (kpi.kpi === 'Retorno Base' && report.specialAnalysis.retornoBaseAnalysis) {
          validBottomTeams = new Set(this.filterRetornoEvidence(report.specialAnalysis.retornoBaseAnalysis).map((a: any) => a.team));
        }

        rawBottom = rawBottom.filter(t => validBottomTeams.has(t.team));
      }
    }

    return {
      top: rawTop,
      bottom: rawBottom,
      selectedDay,
      selectedDayAvg
    };
  }

  protected analyticChartData(kpi: GeneratedReport['kpis'][number]) {
    return this.chartService.analyticChartData(kpi, this.reportData());
  }

  protected trackByFilterKey(_index: number, filter: SelectFilterState): string {
    return filter.key;
  }

  protected trackByReportFilterKey(_index: number, filter: ReportSelectFilterState): string {
    return filter.key;
  }

  protected trackByOption(_index: number, option: string): string {
    return option;
  }

  protected trackByTeam(_index: number, line: { team: string }): string {
    return line.team;
  }

  protected trackByDayIndex(_index: number, pt: { dayIndex: number }): number {
    return pt.dayIndex;
  }

  protected objectKeys(obj: Record<string, unknown>): string[] {
    return Object.keys(obj);
  }

  protected calcIdleMin(analysis: { tempPrepTotalMin: number; semOrdemTotalMin: number }): number {
    return analysis.tempPrepTotalMin + analysis.semOrdemTotalMin;
  }

  protected calcIdlePct(analysis: { hdTotalMin: number; tempPrepTotalMin: number; semOrdemTotalMin: number }): number {
    const idleMin = analysis.tempPrepTotalMin + analysis.semOrdemTotalMin;
    return analysis.hdTotalMin > 0 ? Math.round((idleMin / analysis.hdTotalMin) * 1000) / 10 : 0;
  }

  protected countIdleOrders(flaggedOrders: Array<{ flags: string[] }>): number {
    return flaggedOrders.filter(o => o.flags.includes('temp_prep_alto') || o.flags.includes('sem_os_alto')).length;
  }

  private extractEvTime(dtStr: string): string {
    if (!dtStr) return '';
    const parts = dtStr.split(' ');
    if (parts.length >= 2) {
      const tp = parts[1].split(':');
      const dp = parts[0].split('/');
      if (tp.length >= 2 && dp.length >= 2) return `${tp[0]}:${tp[1]} ${dp[0]}/${dp[1]}`;
    }
    return '';
  }

  private parseEvDt(dtStr: string): number {
    if (!dtStr) return 0;
    const [d, t] = dtStr.split(' ');
    if (!d || !t) return 0;
    const [day, mon, yr] = d.split('/');
    const [hr, min, sec] = t.split(':');
    return new Date(+yr, +mon - 1, +day, +hr, +min, +sec).getTime();
  }

  protected evPrevLiberadaTime(ev: any): string {
    return this.extractEvTime(ev.prev_liberada);
  }

  protected evDespAfterPrevLib(ev: any): string | null {
    const despachada = ev.despachada || ev.hora_primeiro_despacho;
    if (!despachada || !ev.prev_liberada) return null;
    const prevLibTs = this.parseEvDt(ev.prev_liberada);
    const despTs = this.parseEvDt(despachada);
    if (prevLibTs > 0 && despTs > 0 && prevLibTs > despTs) {
      return this.extractEvTime(despachada);
    }
    return null;
  }

  protected osDiaFlagLabel(flag: string): string {
    return this.reportData()?.flagMeta?.labels[flag] ?? flag;
  }

  protected getOciosoTotal(ev: any): number | null {
    const segs = buildTimelineSegments(ev, false);
    let total = 0;
    for (const seg of segs) {
      const lbl = seg.label;
      if (lbl === 'Retorno a base' || lbl === 'Retorno Vazio') {
        total += seg.excessMin ?? 0;
      } else if (
        lbl.startsWith('1º Despacho') ||
        lbl.startsWith('2º Desp. | Prioritário') ||
        lbl === 'Entre OS' ||
        lbl === 'Desl. Intervalo' ||
        lbl === 'Partida'
      ) {
        total += seg.durationMin;
      }
    }
    return total > 0 ? total : null;
  }

  /** Detecta janela Entre OS após intervalo — delegado ao backend via entreOsAfterIntervalo */
  protected entreOsAfterIntervalo(ev: { entreOsAfterIntervalo?: { min: number; from: string; to: string } }): { min: number; from: string; to: string } | null {
    return ev.entreOsAfterIntervalo ?? null;
  }

  protected filterOsDiaEvidence<T extends { idleAnalysis?: unknown; flaggedOrders: unknown[] }>(list: T[]): T[] {
    return list.filter((a) => a.idleAnalysis || a.flaggedOrders.length > 0);
  }

  protected filterTmeImpEvidence(list: TmeImpTeamAnalysis[]): TmeImpTeamAnalysis[] {
    return list.filter((a) => a.flaggedOrders.length > 0);
  }

  protected filterLoginEvidence(list: PrimeiroLoginTeamAnalysis[]): PrimeiroLoginTeamAnalysis[] {
    return list.filter((a) => a.flaggedDays.length > 0);
  }

  protected filterDeslocEvidence(list: PrimeiroDeslocTeamAnalysis[]): PrimeiroDeslocTeamAnalysis[] {
    return list.filter((a) => a.flaggedDays.length > 0);
  }

  protected filterRetornoEvidence(list: RetornoBaseTeamAnalysis[]): RetornoBaseTeamAnalysis[] {
    return list.filter((a) => a.flaggedDays.length > 0);
  }

  protected sortedEficienciaAnalysis(list: EficienciaTeamAnalysis[]): EficienciaTeamAnalysis[] {
    return [...list]
      .filter((a) => a.flaggedOrders.length > 0 || (a.tempoPadraoVazioOrders && a.tempoPadraoVazioOrders.length > 0))
      .sort((a, b) => {
        if (a.analysisType !== b.analysisType) {
          return a.analysisType === 'top_performer' ? -1 : 1;
        }
        return a.analysisType === 'top_performer'
          ? b.eficienciaValue - a.eficienciaValue
          : a.eficienciaValue - b.eficienciaValue;
      });
  }

  protected eficienciaFlagLabel(flag: string): string {
    return this.reportData()?.flagMeta?.labels[flag] ?? flag;
  }

  protected tmeImpFlagLabel(flag: string): string {
    return this.reportData()?.flagMeta?.labels[flag] ?? flag;
  }

  protected loginFlagLabel(flag: string): string {
    return this.reportData()?.flagMeta?.labels[flag] ?? flag;
  }

  protected deslocFlagLabel(flag: string): string {
    if (flag === 'desloc_lento' || flag === 'desloc_muito_lento') return '1º Desloc. ≥25min';
    return this.reportData()?.flagMeta?.labels[flag] ?? flag;
  }

  protected retornoFlagLabel(flag: string): string {
    return this.reportData()?.flagMeta?.labels[flag] ?? flag;
  }

  // ─── Alert body — delegates to pre-computed backend texts ────────────────

  private nf(v: number, minDec = 1, maxDec = 1): string {
    return v.toLocaleString('pt-BR', { minimumFractionDigits: minDec, maximumFractionDigits: maxDec });
  }

  protected osDiaAlertBody(flag: string, ev: { alertTexts?: Record<string, string> }): string {
    return ev.alertTexts?.[flag] ?? '';
  }

  protected semOsDetailText(d: { type: string; min: number; from?: string; to?: string; global_avg_min?: number; above_avg_pct?: number; interval_discounted?: boolean; retorno_base_discounted?: number; retorno_base_used_row?: boolean; desp_anterior?: string; from_label?: string; label?: string; body?: string }, nrOrdemDespachoAnterior?: string): string {
    // Always compute fresh (ignore pre-computed label/body) to ensure stats are always shown
    const SEM_OS_LIMIT = 10;
    const pctAbove = (min: number) => Math.round((min - SEM_OS_LIMIT) / SEM_OS_LIMIT * 100);
    const fmtAvg = (pct: number | undefined, avg: number | undefined): string => {
      if (!Number.isFinite(pct) || !Number.isFinite(avg) || (avg ?? 0) <= 0) return '';
      const dir = (pct! >= 0) ? 'acima' : 'abaixo';
      return ` | ${this.nf(Math.abs(pct!), 0, 1)}% ${dir} da média geral (${this.nf(avg!)} min)`;
    };
    switch (d.type) {
      case 'inicio_jornada': {
        return `1º Despacho: ${d.min} min do Início Calendário (${d.from ?? '—'}) até o primeiro despacho (${d.to ?? '—'}) — ${pctAbove(d.min)}% acima do limite (${SEM_OS_LIMIT} min)${fmtAvg(d.above_avg_pct, d.global_avg_min)}.`;
      }
      case 'entre_ordens': {
        const mEO = Math.round(d.min);
        return `Entre OS: ${mEO} min sem nova OS — Lib. Anterior (${d.from ?? '—'})${d.desp_anterior ? ' · Desp. Anterior (' + d.desp_anterior + ')' : ''} até Despachada (${d.to ?? '—'})${d.interval_discounted ? ' — intervalo descontado' : ''} — ${pctAbove(mEO)}% acima do limite (${SEM_OS_LIMIT} min)${fmtAvg(d.above_avg_pct, d.global_avg_min)}.`;
      }
      case 'fim_jornada': {
          const fromLabelFJ = d.from_label ?? 'Última Liberada';
          const excessFJ = (d as any).excess_min;
          
          if (excessFJ != null && excessFJ > 0) {
             return `Retorno Excedente: ${this.nf(excessFJ)} min acima do limite permitido de 70 min de retorno à base — Retorno a base totalizou ${this.nf(d.min)} min entre ${fromLabelFJ} (${d.from ?? '?'}) e Log Off (${d.to ?? '?'}).`;
          }
          return `Retorno a base: ${this.nf(d.min)} min entre ${fromLabelFJ} (${d.from ?? '?'}) e Log Off (${d.to ?? '?'}).`;
        }
        case 'intervalo_deslocamento': {
        const mID = Math.round(d.min);
        const fromLabel = d.from_label ?? 'Lib. Anterior';
        return `Desl. Intervalo: ${mID} min entre ${fromLabel} (${d.from ?? '—'}) e Início Intervalo (${d.to ?? '—'}) — ${pctAbove(mID)}% acima do limite (${SEM_OS_LIMIT} min)${fmtAvg(d.above_avg_pct, d.global_avg_min)}.`;
      }
      default:
        return `${d.type}: ${d.min} min (${d.from ?? '—'} → ${d.to ?? '—'})`;
    }
  }

  protected highlightMin(text: string): SafeHtml {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tagged = esc.replace(/(\d+(?:[.,]\d+)?) min\b/g, '<strong class="flag-min">$1 min</strong>');
    return this.sanitizer.bypassSecurityTrustHtml(tagged);
  }

  protected formatDespachoHora(hora: string | undefined): string {
    if (!hora) return '';
    const m = hora.match(/^(\d{2}\/\d{2})\/\d{4}\s+(\d{2}:\d{2})/);
    return m ? `${m[1]} ${m[2]}` : hora;
  }

  protected formatEntreOsText(eo: { min: number; from?: string; to?: string }): string {
    const m = Math.round(eo.min);
    return `${m} min sem nova OS — Fim Intervalo (${eo.from ?? '—'}) até Despachada (${eo.to ?? '—'}) — ${Math.round(((m - 10) / 10) * 100)}% acima do limite (10 min).`;
  }

  /** Filtra sem_os_details para exibição na lista de alertas.
   * Remove entradas fim_jornada com "Retorno a base" puro (sem excess_min),
   * pois são uma etapa de deslocamento, não uma flag de ociosidade. */
  protected alertSemOsDetails(details: any[] | undefined): any[] {
    if (!details) return [];
    return details.filter((d: any) => d.type !== 'fim_jornada' || d.excess_min != null);
  }

  protected semOsDetailLabel(d: { type: string; min: number; from?: string; to?: string; label?: string; body?: string;[key: string]: unknown }, nrOrdemDespachoAnterior?: string): string {
    const text = this.semOsDetailText(d, nrOrdemDespachoAnterior);
    const sep = text.indexOf(': ');
    return sep > -1 ? text.slice(0, sep) : text;
  }

  protected semOsDetailBody(d: { type: string; min: number; from?: string; to?: string; label?: string; body?: string;[key: string]: unknown }, nrOrdemDespachoAnterior?: string): string {
    // Always recompute fresh to ensure % stats are shown (ignore pre-computed d.body)
    const text = this.semOsDetailText(d, nrOrdemDespachoAnterior);
    const sep = text.indexOf(': ');
    return sep > -1 ? text.slice(sep + 2) : '';
  }

  protected tempPrepAltoText(ev: { temp_prep_os_min?: number; prev_liberada?: string; alertTexts?: Record<string, string> }): string {
    const val = ev.temp_prep_os_min;
    if (val == null || !Number.isFinite(val)) return ev.alertTexts?.['temp_prep_alto'] ?? '';
    const limit = 10;
    const pct = Math.round((val - limit) / limit * 100);
    const subject = ev.prev_liberada
      ? 'a Despachada e o registro de saída nesta OS'
      : 'a Despachada e o registro de saída desta 1ª OS';
    return `o técnico levou ${val} min entre ${subject} — ${pct}% acima do limite de ${limit} min. Esse tempo representa espera antes de se deslocar para o próximo atendimento.`;
  }

  protected triagemAltoText(ev: { triagem_min?: number; hora_despacho_anterior?: string; despachada?: string; triagem_global_avg_min?: number; alertTexts?: Record<string, string> }): string {
    const val = ev.triagem_min;
    if (val == null || !Number.isFinite(val)) return ev.alertTexts?.['triagem_alto'] ?? '';
    const limit = 10;
    const pct = Math.round((val - limit) / limit * 100);
    const horaAnterior = this.formatDespachoHora(ev.hora_despacho_anterior);
    const horaDesp = this.formatDespachoHora(ev.despachada);
    let text = `${this.nf(val)} min entre o Início da Jornada e o Despacho da 2ª OS (${horaDesp || '-'}) - ${pct}% acima do limite (${limit} min). O 1º Despacho ocorreu às ${horaAnterior || '-'}`;
    if (ev.triagem_global_avg_min && Number.isFinite(ev.triagem_global_avg_min) && ev.triagem_global_avg_min > 0) {
      const pctAvg = Math.round((val - ev.triagem_global_avg_min) / ev.triagem_global_avg_min * 100);
      const dir = pctAvg >= 0 ? 'acima' : 'abaixo';
      text += ` | ${this.nf(Math.abs(pctAvg), 0, 1)}% ${dir} da média geral (${this.nf(ev.triagem_global_avg_min)} min)`;
    }
    return text + '.';
  }

  protected eficienciaAlertBody(flag: string, ev: EficienciaOrderEvidence): string {
    return ev.alertTexts?.[flag] ?? '';
  }

  protected tmeImpAlertBody(flag: string, ev: TmeImpOrderEvidence): string {
    return ev.alertTexts?.[flag] ?? '';
  }

  protected loginAlertBody(flag: string, ev: PrimeiroLoginDayEvidence): string {
    return ev.alertTexts?.[flag] ?? '';
  }

  protected deslocAlertBody(flag: string, ev: PrimeiroDeslocDayEvidence): string {
    return ev.alertTexts?.[flag] ?? '';
  }

  protected retornoAlertBody(flag: string, ev: RetornoBaseDayEvidence): string {
    return ev.alertTexts?.[flag] ?? '';
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  protected getFimJornadaDetail(ev: OsDiaOrderEvidence): NonNullable<OsDiaOrderEvidence['sem_os_details']>[number] | null {
    return ev.sem_os_details?.find((d: NonNullable<OsDiaOrderEvidence['sem_os_details']>[number]) => d.type === 'fim_jornada') ?? null;
  }

  /** Returns the body text for the 'antes_log_off_alto' orange warn item. */
  protected antesLogOffAltoText(ev: OsDiaOrderEvidence): string {
    const fj = this.getFimJornadaDetail(ev);
    if (!fj) return '';
    return this.semOsDetailBody(fj as any);
  }

  protected isOptionSelected(filter: SelectFilterState, option: string): boolean {
    return filter.value.includes(option);
  }

  protected describeSelection(filter: SelectFilterState): string {
    if (filter.value.includes(ALL_OPTION)) {
      return 'Todos';
    }

    if (filter.value.length === 0) {
      return 'Nenhum valor selecionado';
    }

    return filter.value.join(', ');
  }

  protected isReportOptionSelected(filter: ReportSelectFilterState, option: string): boolean {
    return filter.value.includes(option);
  }

  protected describeReportSelection(filter: ReportSelectFilterState): string {
    if (filter.value.includes(ALL_OPTION)) {
      return 'Todos';
    }

    if (filter.value.length === 0) {
      return 'Nenhum valor selecionado';
    }

    if (filter.value.length === 1) {
      return filter.value[0];
    }

    return `${filter.value.length} selecionados`;
  }

  protected toggleReportFilterOption(key: ReportFilterKey, option: string, multiSelect = false): void {
    const filters = this.reportFilterStates();
    const updated = filters.map((filter) => {
      if (filter.key !== key) return filter;
      if (!multiSelect) {
        return { ...filter, value: [option] };
      }
      // Ctrl+click: toggle the option while keeping others
      if (option === ALL_OPTION) {
        return { ...filter, value: [ALL_OPTION] };
      }
      const current = filter.value.filter((v) => v !== ALL_OPTION);
      const idx = current.indexOf(option);
      const next = idx >= 0
        ? current.filter((v) => v !== option)
        : [...current, option];
      return { ...filter, value: next.length > 0 ? next : [ALL_OPTION] };
    });
    this.setReportFilterStates(this.cascadeReportFilters(updated, this.reportType()), this.reportType());
    this.saveToStorage();
    this.scheduleInstantReportRefresh();
  }

  protected onReportSelectChange(key: ReportFilterKey, event: Event): void {
    const value = String((event.target as HTMLSelectElement | null)?.value ?? ALL_OPTION);
    this.toggleReportFilterOption(key, value);
  }

  protected toggleDropdown(key: string, event: Event): void {
    event.stopPropagation();
    if (this.openDropdownKey() === key) {
      this.openDropdownKey.set(null);
      this.dropdownSearch.set('');
    } else {
      this.openDropdownKey.set(key);
      this.dropdownSearch.set('');
    }
  }

  protected onDropdownSearch(event: Event): void {
    this.dropdownSearch.set((event.target as HTMLInputElement).value);
  }

  protected filteredDropdownOptions(filter: ReportSelectFilterState): string[] {
    const q = this.dropdownSearch().toLowerCase().trim();
    if (!q) return filter.options;
    return filter.options.filter((o) => o.toLowerCase().includes(q));
  }

  protected selectDropdownOption(key: ReportFilterKey, option: string, event: Event): void {
    event.stopPropagation();
    // Always toggle option like a checkbox
    this.toggleReportFilterOption(key, option, true);
  }

  protected beginOptionSelection(key: FilterKey, value: string, event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    const filter = this.selectFilters().find((candidate) => candidate.key === key);
    if (!filter) {
      return;
    }

    const ctrlLike = event.ctrlKey || event.metaKey;
    const selected = new Set(filter.value.filter((entry) => entry !== ALL_OPTION));

    if (value === ALL_OPTION) {
      this.applyFilterSelection(key, [ALL_OPTION]);
      this.dragSelectionState = null;
      return;
    }

    const shouldSelect = ctrlLike ? !selected.has(value) : true;
    const nextSelected = ctrlLike ? selected : new Set<string>();

    if (shouldSelect) {
      nextSelected.add(value);
    } else {
      nextSelected.delete(value);
    }

    this.applyFilterSelection(key, this.orderSelection(filter.options, Array.from(nextSelected)));

    const anchorIndex = filter.options.indexOf(value);
    const baseline = new Set(ctrlLike ? filter.value.filter((entry) => entry !== ALL_OPTION) : []);
    if (shouldSelect) {
      baseline.delete(value);
    }
    this.dragSelectionState = { key, mode: shouldSelect ? 'add' : 'remove', anchorIndex, baseline };
  }

  protected continueOptionSelection(key: FilterKey, value: string, event: MouseEvent): void {
    if (!this.dragSelectionState || this.dragSelectionState.key !== key || (event.buttons & 1) !== 1 || value === ALL_OPTION) {
      return;
    }

    const filter = this.selectFilters().find((candidate) => candidate.key === key);
    if (!filter) {
      return;
    }

    this.applyDragRange(filter, value);
  }

  protected endFilterDrag(): void {
    this.dragSelectionState = null;
    this.dragScrollTimer = null;
  }

  protected dragScrollList(key: FilterKey, event: MouseEvent): void {
    if (!this.dragSelectionState || this.dragSelectionState.key !== key || (event.buttons & 1) !== 1) {
      return;
    }

    const list = (event.currentTarget as HTMLElement);
    const rect = list.getBoundingClientRect();
    const edgeZone = 40;
    const mouseY = event.clientY;

    let scrollDelta = 0;
    if (mouseY < rect.top + edgeZone) {
      const distance = rect.top + edgeZone - mouseY;
      const ratio = Math.min(distance / edgeZone, 1);
      scrollDelta = -Math.round(1 + ratio * ratio * 10);
    } else if (mouseY > rect.bottom - edgeZone) {
      const distance = mouseY - (rect.bottom - edgeZone);
      const ratio = Math.min(distance / edgeZone, 1);
      scrollDelta = Math.round(1 + ratio * ratio * 10);
    }

    if (scrollDelta === 0) {
      return;
    }

    list.scrollTop += scrollDelta;

    // Select the item now under the cursor after scrolling
    const itemUnderCursor = document.elementFromPoint(event.clientX, mouseY) as HTMLElement | null;
    const button = itemUnderCursor?.closest('.option-item') as HTMLElement | null;
    const value = button?.textContent?.trim();
    if (!value || value === ALL_OPTION) {
      return;
    }

    const filter = this.selectFilters().find((candidate) => candidate.key === key);
    if (!filter || !filter.options.includes(value)) {
      return;
    }

    this.applyDragRange(filter, value);
  }

  private applyDragRange(filter: SelectFilterState, currentValue: string): void {
    if (!this.dragSelectionState) return;

    const options = filter.options.filter((o) => o !== ALL_OPTION);
    const currentIndex = options.indexOf(currentValue);
    if (currentIndex === -1) return;

    const { anchorIndex: rawAnchor, mode, baseline } = this.dragSelectionState;
    const anchorIndex = Math.max(0, Math.min(rawAnchor - (filter.options[0] === ALL_OPTION ? 1 : 0), options.length - 1));

    const rangeStart = Math.min(anchorIndex, currentIndex);
    const rangeEnd = Math.max(anchorIndex, currentIndex);

    const result = new Set(baseline);
    for (let i = 0; i < options.length; i++) {
      if (i >= rangeStart && i <= rangeEnd) {
        if (mode === 'add') {
          result.add(options[i]);
        } else {
          result.delete(options[i]);
        }
      }
    }

    this.applyFilterSelection(this.dragSelectionState.key, this.orderSelection(filter.options, Array.from(result)));
  }

  private applyFilterSelection(key: FilterKey, value: string[]): void {
    const updatedFilters = this.selectFilters().map((filter) => filter.key === key ? { ...filter, value } : filter);

    if (key === 'ano' || key === 'mes') {
      const overrideValues = new Map(updatedFilters.map((filter) => [filter.key, filter.value]));
      const rebuiltFilters = this.buildSelectFilters(overrideValues);
      this.selectFilters.set(rebuiltFilters);
      this.dayRange.set(this.buildDayRange(new Map(rebuiltFilters.map((filter) => [filter.key, filter.value]))));
      this.saveToStorage();
      return;
    }

    this.selectFilters.set(updatedFilters);
    this.saveToStorage();
  }

  /**
   * Handles both single-month and multi-month slider input.
   * The slider always uses an "absolute" scale (1 → sliderTotal).
   * For single-month: absolute value = day number directly.
   * For multi-month: min thumb = day in first month; max thumb is converted
   * from absolute position back to a day in the last month.
   */
  /**
   * Syncs the fill div and the number-input labels imperatively so they update
   * on every slider frame without waiting for Angular's async change-detection.
   */
  private syncSliderDOM(): void {
    // Update fill div
    const fill = this.sliderFillRef?.nativeElement;
    if (fill) {
      const left = this.fillLeft();
      const width = this.fillWidth();
      fill.style.left = left + '%';
      fill.style.width = width + '%';
    }
    // Update slider thumb positions so they reflect signal value immediately
    const total = this.sliderTotal();
    const sMin = this.sliderMin();
    const sMax = this.sliderMax();
    if (this.sliderThumbMinRef?.nativeElement) this.sliderThumbMinRef.nativeElement.value = String(sMin);
    if (this.sliderThumbMaxRef?.nativeElement) this.sliderThumbMaxRef.nativeElement.value = String(sMax);
    // Update number inputs (single-month) with normalised resolved values
    if (!this.multiMonthSelected()) {
      const r = this.resolvedDayRange();
      if (this.minNumInputRef?.nativeElement) this.minNumInputRef.nativeElement.value = String(r.min);
      if (this.maxNumInputRef?.nativeElement) this.maxNumInputRef.nativeElement.value = String(r.max);
    }
    void total; // suppress unused-var lint
  }

  protected updateDayRangeSlider(boundary: 'min' | 'max', event: Event): void {
    const absolute = Number((event.target as HTMLInputElement | null)?.value ?? Number.NaN);
    if (Number.isNaN(absolute)) return;

    if (!this.multiMonthSelected()) {
      // Store raw thumb positions — thumbs can cross freely.
      // resolvedDayRange() normalises min≤max for display and submission.
      this.dayRange.update((range) => ({
        min: boundary === 'min' ? absolute : range.min,
        max: boundary === 'max' ? absolute : range.max,
      }));
      this.syncSliderDOM();
      this.saveToStorage();
      return;
    }

    const counts = this.monthDayCounts();
    if (boundary === 'min') {
      const firstMonthDays = counts[0]?.days ?? 1;
      const day = Math.max(1, Math.min(Math.round(absolute), firstMonthDays));
      this.dayRange.update((range) => ({ ...range, min: day }));
    } else {
      const lastIdx = counts.length - 1;
      const daysBeforeLast = counts.slice(0, lastIdx).reduce((s, m) => s + m.days, 0);
      const dayInLast = Math.max(1, Math.min(Math.round(absolute) - daysBeforeLast, counts[lastIdx]?.days ?? 1));
      this.dayRange.update((range) => ({ ...range, max: dayInLast }));
    }
    this.syncSliderDOM();
    this.saveToStorage();
  }

  protected updateDayRangeFromInput(boundary: 'min' | 'max', event: Event): void {
    // Only called in single-month mode (number input); both sides share the same dayLimit().
    const input = event.target as HTMLInputElement;
    const raw = Number(input.value);
    const limit = this.dayLimit();
    const clamped = Math.max(1, Math.min(Number.isFinite(raw) ? Math.round(raw) : 1, limit));
    this.dayRange.update((range) => {
      const a = boundary === 'min' ? clamped : range.min;
      const b = boundary === 'max' ? clamped : range.max;
      return { min: Math.min(a, b), max: Math.max(a, b) };
    });
    input.value = String(boundary === 'min' ? this.resolvedDayRange().min : this.resolvedDayRange().max);
    this.saveToStorage();
  }

  protected updateDayRangeFromText(boundary: 'min' | 'max', event: Event): void {
    // Called in multi-month mode (text input showing dd/mm).
    // Only the day part is parsed; the month is fixed by position (first/last selected month).
    const input = event.target as HTMLInputElement;
    const dayStr = input.value.split('/')[0].trim();
    const dayNum = parseInt(dayStr, 10);
    const limit = boundary === 'min' ? this.dayLimitMin() : this.dayLimit();
    const clamped = Number.isFinite(dayNum) ? Math.max(1, Math.min(dayNum, limit)) : (boundary === 'min' ? 1 : this.dayLimit());
    this.dayRange.update((range) => ({
      min: boundary === 'min' ? clamped : range.min,
      max: boundary === 'max' ? clamped : range.max,
    }));
    // Re-format display as dd/mm
    const indexes = this.sortedActiveMonthIndexes();
    const idx = boundary === 'min' ? 0 : indexes.length - 1;
    const monthNum = indexes[idx] !== undefined ? String(indexes[idx] + 1).padStart(2, '0') : '??';
    const finalDay = boundary === 'min' ? this.resolvedDayRange().min : this.resolvedDayRange().max;
    input.value = `${String(finalDay).padStart(2, '0')}/${monthNum}`;
    this.saveToStorage();
  }

  protected submit(): void {
    if (!this.filtersVisible()) {
      return;
    }

    this.filterDrawerOpen.set(false);
    this.cancelActiveDownloadRequest();
    this.loading.set(true);
    this.progressMessage.set('');
    this.progressLog.set([]);
    this.errorMessage.set('');

    const selectedFilters = this.buildSelectedFilters();
    const abortController = new AbortController();
    this.activeDownloadAbort = abortController;

    this.api.dataDownloadWithProgress(
      {
        reportTitle: this.reportTitle(),
        selectedFilters,
        periodSelection: this.buildPeriodSelection(),
      },
      {
        onProgress: (message) => {
          this.zone.run(() => {
            this.progressMessage.set(message);
            if (message.startsWith('✓ Filtro')) {
              this.progressLog.update((log) => [...log, message]);
            }
          });
        },
        onResult: () => {
          this.zone.run(() => {
            this.activeDownloadAbort = undefined;
            this.progressMessage.set('Gerando relatório analítico...');
          });

          this.api.generateReport({
            reportFilters: this.buildReportFiltersPayload(),
          }).subscribe({
            next: (result) => {
              this.hasLoadedDownloadData = true;
              this.updateReportDataAndDates(result.generatedReport);
              this.loading.set(false);
              this.progressMessage.set('');
              this.setupAnimations();
              this.executePendingScroll();
              this.fetchAndUpdateTeams();
              // Após o fluxo completo (download-data → generate → teams), apaga todos
              // os PDFs antigos de uma vez. Os próximos exports serão do relatório atualizado.
              this.api.cleanupExports('all').subscribe({
                next: (r) => console.log(`[Cleanup] ${r.deleted} PDF(s) antigo(s) removido(s) de ~/Downloads`),
                error: (e) => console.warn('[Cleanup] Não foi possível limpar PDFs anteriores:', e),
              });
            },
            error: () => {
              this.loading.set(false);
              this.progressMessage.set('');
              this.errorMessage.set('Falha ao gerar relatório após o download');
            },
          });
        },
        onError: (message) => {
          this.zone.run(() => {
            this.progressMessage.set('');
            this.errorMessage.set(message ?? 'Erro desconhecido ao processar filtros');
            this.activeDownloadAbort = undefined;
          });
        },
      },
      abortController.signal,
    ).catch((err) => {
      if (err?.name === 'AbortError') return;
      this.zone.run(() => {
        this.progressMessage.set('');
        this.errorMessage.set('Erro de conexão com o servidor');
        this.activeDownloadAbort = undefined;
      });
    });
  }

  protected dismissError(): void {
    this.loading.set(false);
    this.errorMessage.set('');
    this.progressMessage.set('');
  }

  private regenerateReport(): void {
    if (this.loading()) return;

    this.loading.set(true);
    this.progressMessage.set('Regenerando relatório analítico...');
    this.errorMessage.set('');

    this.reportRefreshSubscription?.unsubscribe();
    this.reportRefreshSubscription = this.api.generateReport({
      reportFilters: this.buildReportFiltersPayload(),
    }).subscribe({
      next: (result) => {
        this.hasLoadedDownloadData = true;
        this.updateReportDataAndDates(result.generatedReport);
        this.loading.set(false);
        this.progressMessage.set('');
        this.setupAnimations();
        this.executePendingScroll();
        this.fetchAndUpdateTeams();
      },
      error: () => {
        this.loading.set(false);
        this.progressMessage.set('');
        this.errorMessage.set('Falha ao regenerar relatório');
      },
    });
  }

  private cancelActiveDownloadRequest(): void {
    this.activeDownloadAbort?.abort();
    this.activeDownloadAbort = undefined;
    this.activeDownloadRequest?.unsubscribe();
    this.activeDownloadRequest = undefined;
  }

  private buildSelectFilters(overrideValues?: Map<FilterKey, string[]>): SelectFilterState[] {
    const previous = overrideValues ?? new Map(this.selectFilters().map((filter) => [filter.key, filter.value]));
    const availableYears = this.yearOptions();
    const fallbackYear = availableYears.includes(String(new Date().getFullYear())) ? [String(new Date().getFullYear())] : (availableYears[0] ? [availableYears[0]] : []);
    const anoValue = this.resolveValues(previous.get('ano'), this.withAllOption(availableYears), fallbackYear);

    const availableMonths = this.monthOptionsFromSelection(anoValue);
    const currentMonth = MONTH_OPTIONS[new Date().getMonth()];
    const fallbackMonth = availableMonths.includes(currentMonth) ? [currentMonth] : (availableMonths[0] ? [availableMonths[0]] : []);
    const mesValue = this.resolveValues(previous.get('mes'), this.withAllOption(availableMonths), fallbackMonth);

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
        value: this.resolveValues(previous.get('atuacaoHd'), this.withAllOption(ATUACAO_HD_OPTIONS), []),
        options: this.withAllOption(ATUACAO_HD_OPTIONS),
        sourceTitle: FILTER_SOURCE_MAP.atuacaoHd.sourceTitle,
        sourceKind: FILTER_SOURCE_MAP.atuacaoHd.sourceKind,
        enabled: true,
      },
      {
        key: 'base',
        title: 'Base',
        value: this.resolveValues(previous.get('base'), this.withAllOption(BASE_OPTIONS), []),
        options: this.withAllOption(BASE_OPTIONS),
        sourceTitle: FILTER_SOURCE_MAP.base.sourceTitle,
        sourceKind: FILTER_SOURCE_MAP.base.sourceKind,
        enabled: true,
      },
    ];
  }

  private buildReportFilterStates(mode: ReportTypeValue): ReportSelectFilterState[] {
    return [
      {
        key: 'reportDataRef',
        title: 'Data',
        value: [ALL_OPTION],
        options: this.withAllOption(this.availableDates),
        enabled: true,
      },
      {
        key: 'reportBase',
        title: 'Base (Relatório)',
        value: [ALL_OPTION],
        options: mode === 'analitico'
          ? this.withAllOption(['Média Global', ...this.reportBaseOptions])
          : this.withAllOption(this.reportBaseOptions),
        enabled: true,
      },
      {
        key: 'reportTipoEquipe',
        title: 'Tipo de Equipe (Relatório)',
        value: [ALL_OPTION],
        options: this.reportType() === 'analitico'
          ? this.withAllOption(['Contrastar', ...REPORT_TEAM_TYPE_OPTIONS])
          : this.withAllOption(REPORT_TEAM_TYPE_OPTIONS),
        enabled: true,
      },
      {
        key: 'reportEquipe',
        title: 'Equipe',
        value: [ALL_OPTION],
        options: this.withAllOption(this.availableTeams),
        enabled: true,
      },
    ];
  }

  private buildReportFiltersPayload(): {
    bases?: string[];
    teamTypes?: Array<'propria' | 'parceira'>;
    teams?: string[];
    includeExtraTags: boolean;
    dates?: string[];
  } {
    const baseFilter = this.reportFilterStates().find((filter) => filter.key === 'reportBase');
    const teamTypeFilter = this.reportFilterStates().find((filter) => filter.key === 'reportTipoEquipe');
    const equipeFilter = this.reportFilterStates().find((filter) => filter.key === 'reportEquipe');
    const dateFilter = this.reportFilterStates().find((filter) => filter.key === 'reportDataRef');

    const normalize = (filter: ReportSelectFilterState | undefined): string[] => {
      if (!filter || filter.value.includes(ALL_OPTION)) {
        return [];
      }
      return filter.value;
    };

    const selectedTypes = normalize(teamTypeFilter)
      .map((value) => {
        if (value === 'Própria') return ['propria'];
        if (value === 'Parceira') return ['parceira'];
        if (value === 'Contrastar') return ['propria', 'parceira'];
        return [];
      })
      .flat()
      .filter((value): value is 'propria' | 'parceira' => value !== null);

    const selectedBases = normalize(baseFilter);
    const selectedTeams = normalize(equipeFilter);
    const selectedDates = normalize(dateFilter);

    return {
      bases: selectedBases.length > 0 ? selectedBases : undefined,
      teamTypes: selectedTypes.length > 0 ? selectedTypes : undefined,
      teams: selectedTeams.length > 0 ? selectedTeams : undefined,
      includeExtraTags: true,
      dates: selectedDates.length > 0 ? selectedDates : undefined,
    };
  }

  private cascadeReportFilters(filters: ReportSelectFilterState[], mode: ReportTypeValue): ReportSelectFilterState[] {
    const dataF = filters.find((f) => f.key === 'reportDataRef');
    const baseF = filters.find((f) => f.key === 'reportBase');
    const tipoF = filters.find((f) => f.key === 'reportTipoEquipe');
    const equipeF = filters.find((f) => f.key === 'reportEquipe');

    const selectedDates = dataF && !dataF.value.includes(ALL_OPTION) ? dataF.value : [];
    const selectedBases = baseF && !baseF.value.includes(ALL_OPTION) ? baseF.value : [];
    const selectedTipos = tipoF && !tipoF.value.includes(ALL_OPTION) ? tipoF.value : [];
    const selectedEquipes = equipeF && !equipeF.value.includes(ALL_OPTION) ? equipeF.value : [];

    const effectiveBases = selectedBases.filter(b => b !== 'Média Global');
    const effectiveTipos = selectedTipos.filter(t => t !== 'Contrastar');

    const config = this.basesConfig;
    if (!config) return filters; // Not loaded yet

    const activeBases = selectedBases.length > 0 ? selectedBases : this.reportBaseOptions;

    const teamMetadata = new Map<string, { base: string, type: string }>();

    for (const team of this.availableTeams) {
      const upper = team.toUpperCase();
      let matchedBase: string | null = null;
      let matchedType: string | null = null;
      for (const polo of config.polos) {
        if (polo.matchType === 'direct_prefix') {
          for (const base of polo.bases) {
            if (base.propria?.some((p: string) => upper.startsWith(p.toUpperCase()))) {
              matchedBase = base.name; matchedType = 'Própria'; break;
            }
            if (base.parceira?.some((p: string) => upper.startsWith(p.toUpperCase()))) {
              matchedBase = base.name; matchedType = 'Parceira'; break;
            }
          }
        } else if (polo.matchType === 'infix_type_with_base_prefix') {
          for (const base of polo.bases) {
            if (base.prefixes?.some((p: string) => upper.startsWith(p.toUpperCase()))) {
              matchedBase = base.name;
              if (polo.typeIdentifiers?.propria.some((inf: string) => upper.includes(inf.toUpperCase()))) matchedType = 'Própria';
              else if (polo.typeIdentifiers?.parceira.some((inf: string) => upper.includes(inf.toUpperCase()))) matchedType = 'Parceira';
              break;
            }
          }
        }
        if (matchedBase) break;
      }
      if (matchedBase && matchedType) {
        teamMetadata.set(team, { base: matchedBase, type: matchedType });
      }
    }

    // Filter equipe options based on selected bases and tipos
    const filteredTeams = this.availableTeams.filter((team) => {
      const meta = teamMetadata.get(team);
      if (!meta) return true; // Keep unknown teams if no filters applied? Actually, let's keep them if no filters.
      if (effectiveBases.length > 0 && !effectiveBases.includes(meta.base)) return false;
      if (effectiveTipos.length > 0 && !effectiveTipos.includes(meta.type)) return false;
      return true;
    });

    // Retain only selected equipes still present in filtered list
    const validEquipes = selectedEquipes.filter((e) => filteredTeams.includes(e));

    // Reverse: if equipes are selected, narrow Base and Tipo options
    let filteredBases: string[] = [];
    let filteredTypes: string[] = [];

    if (validEquipes.length > 0) {
      const basesSet = new Set<string>();
      const typesSet = new Set<string>();
      for (const e of validEquipes) {
        const meta = teamMetadata.get(e);
        if (meta) {
          basesSet.add(meta.base);
          typesSet.add(meta.type);
        }
      }
      filteredBases = Array.from(basesSet);
      filteredTypes = Array.from(typesSet);
    } else {
      const basesSet = new Set<string>();
      const typesSet = new Set<string>();
      for (const team of this.availableTeams) {
        const meta = teamMetadata.get(team);
        if (meta) {
          if (effectiveTipos.length === 0 || effectiveTipos.includes(meta.type)) basesSet.add(meta.base);
          if (effectiveBases.length === 0 || effectiveBases.includes(meta.base)) typesSet.add(meta.type);
        }
      }
      filteredBases = Array.from(basesSet);
      filteredTypes = Array.from(typesSet);
    }

    return filters.map((f) => {
      if (f.key === 'reportEquipe') {
        return {
          ...f,
          options: this.withAllOption(filteredTeams),
          value: validEquipes.length > 0 ? validEquipes : [ALL_OPTION],
        };
      }
      if (f.key === 'reportBase') {
        if (mode === 'analitico') {
          if (!filteredBases.includes('Média Global')) {
            filteredBases.unshift('Média Global');
          }
        }
        const validBases = selectedBases.filter((b) => filteredBases.includes(b));
        return {
          ...f,
          options: this.withAllOption(filteredBases),
          value: validBases.length > 0 ? validBases : (selectedBases.length > 0 ? [ALL_OPTION] : f.value),
        };
      }
      if (f.key === 'reportTipoEquipe') {
        if (mode === 'analitico') {
          if (!filteredTypes.includes('Contrastar')) {
            filteredTypes.unshift('Contrastar');
          }
        }
        const validTipos = selectedTipos.filter((t) => filteredTypes.includes(t));
        return {
          ...f,
          options: this.withAllOption(filteredTypes),
          value: validTipos.length > 0 ? validTipos : (selectedTipos.length > 0 ? [ALL_OPTION] : f.value),
        };
      }
      return f;
    });
  }

  private fetchAndUpdateTeams(): void {
    this.api.getTeams().subscribe({
      next: (result) => {
        this.availableTeams = result.teams;
        this.updateAvailableBasesForExport();
        const current = this.reportFilterStates();
        this.setReportFilterStates(this.cascadeReportFilters(this.reportFilterStates(), this.reportType()), this.reportType());
      },
    });
  }

  private updateAvailableBasesForExport(): void {
    const config = this.basesConfig;
    if (!config) return;
    const proprias = new Set<string>();
    const parceiras = new Set<string>();
    for (const team of this.availableTeams) {
      const upper = team.toUpperCase();
      let matchedBase: string | null = null;
      let matchedType: string | null = null;
      for (const polo of config.polos) {
        if (polo.matchType === 'direct_prefix') {
          for (const base of polo.bases) {
            if (base.propria?.some((p: string) => upper.startsWith(p.toUpperCase()))) {
              matchedBase = base.name; matchedType = 'Própria'; break;
            }
            if (base.parceira?.some((p: string) => upper.startsWith(p.toUpperCase()))) {
              matchedBase = base.name; matchedType = 'Parceira'; break;
            }
          }
        } else if (polo.matchType === 'infix_type_with_base_prefix') {
          for (const base of polo.bases) {
            if (base.prefixes?.some((p: string) => upper.startsWith(p.toUpperCase()))) {
              matchedBase = base.name;
              if (polo.typeIdentifiers?.propria.some((inf: string) => upper.includes(inf.toUpperCase()))) matchedType = 'Própria';
              else if (polo.typeIdentifiers?.parceira.some((inf: string) => upper.includes(inf.toUpperCase()))) matchedType = 'Parceira';
              break;
            }
          }
        }
        if (matchedBase) break;
      }
      if (matchedBase) {
        if (matchedType === 'Própria') proprias.add(matchedBase);
        else if (matchedType === 'Parceira') parceiras.add(matchedBase);
      }
    }
    this.availablePropriasBases = Array.from(proprias);
    this.availableParceirasBases = Array.from(parceiras);
  }

  private scheduleInstantReportRefresh(): void {
    if (!this.hasLoadedDownloadData) {
      return;
    }

    if (this.reportApplyTimer) {
      clearTimeout(this.reportApplyTimer);
    }

    this.reportApplyTimer = setTimeout(() => {
      this.reportRefreshSubscription?.unsubscribe();
      this.reportRefreshSubscription = this.api.generateReport({
        reportFilters: this.buildReportFiltersPayload(),
      }).subscribe({
        next: (result) => {
          this.updateReportDataAndDates(result.generatedReport);
          this.errorMessage.set('');
          this.setupAnimations();
          this.executePendingScroll();
        },
        error: (error) => {
          const message = error?.error?.message ?? 'Falha ao atualizar relatório';
          this.errorMessage.set(message);
        },
      });
    }, 300);
  }

  private updateReportDataAndDates(report: GeneratedReport) {
    this.availableDates = report.availableDates || [];
    this.reportData.set(report);

    // Clear any interactive UI state to avoid remnants from the previous report
    this.expandedEvidenceTeams.set({});
    this.expandedEvidenceDates.set({});
    this.analyticSelectedTeam.set({});
    this.analyticSelectedDay.set({});

    const updateFilters = (filters: ReportSelectFilterState[], mode: ReportTypeValue) => {
      const updated = filters.map(f => {
        if (f.key === 'reportDataRef') {
          const validOptions = this.withAllOption(this.availableDates);
          let validValues = f.value.filter(v => v === ALL_OPTION || this.availableDates.includes(v));
          if (validValues.length === 0) validValues = [ALL_OPTION];
          return { ...f, options: validOptions, value: validValues };
        }
        return f;
      });
      return this.cascadeReportFilters(updated, mode);
    };

    this.analiticoFilters.set(updateFilters(this.analiticoFilters(), 'analitico'));
    this.operacionalFilters.set(updateFilters(this.operacionalFilters(), 'operacional'));
  }
  private buildDayRange(overrideValues?: Map<FilterKey, string[]>): { min: number; max: number } {
    const values = overrideValues ?? new Map(this.selectFilters().map((filter) => [filter.key, filter.value]));
    const days = this.dayOptionsFromSelection(values.get('ano') ?? [], values.get('mes') ?? []);
    const minDay = days[0] ?? 1;
    const maxDay = days[days.length - 1] ?? 31;

    // If the current month+year is in the selection, default to D-2
    const currentDate = new Date();
    const selectedYears = (values.get('ano') ?? []).filter((v) => v !== ALL_OPTION);
    const selectedMonths = (values.get('mes') ?? []).filter((v) => v !== ALL_OPTION);
    const currentYearStr = String(currentDate.getFullYear());
    const currentMonthStr = MONTH_OPTIONS[currentDate.getMonth()];

    const includesCurrentYear = selectedYears.length === 0 || selectedYears.includes(currentYearStr);
    const includesCurrentMonth = selectedMonths.length === 0 || selectedMonths.includes(currentMonthStr);

    if (includesCurrentYear && includesCurrentMonth) {
      const d2 = currentDate.getDate() - 2;
      if (selectedMonths.length > 1) {
        // Multi-month crossing current: start at first available day, end at D-2 of current month
        return { min: minDay, max: Math.max(Math.min(d2, maxDay), 1) };
      }
      // Single current month: default both boundaries to D-2
      const clamped = Math.max(Math.min(d2, maxDay), minDay);
      return { min: clamped, max: clamped };
    }

    return { min: minDay, max: maxDay };
  }

  private yearOptions(): string[] {
    const currentYear = new Date().getFullYear();
    return [String(currentYear), String(currentYear - 1)];
  }

  private monthOptionsFromSelection(selectedYear: string[]): string[] {
    const normalizedYears = selectedYear.filter((value) => value !== ALL_OPTION);
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();

    if (normalizedYears.length === 0) {
      return MONTH_OPTIONS;
    }

    const includesPastYear = normalizedYears.some((value) => {
      const year = Number(value);
      return Number.isFinite(year) && year < currentYear;
    });

    if (includesPastYear) {
      return MONTH_OPTIONS;
    }

    // Current year only: limit to months that have scanner data (up to D-2)
    // If today is day 2 or earlier, D-2 is in the previous month so current
    // month has no data up to D-2 yet.
    const lastAvailableMonth = currentDate.getDate() <= 2
      ? currentDate.getMonth() - 1
      : currentDate.getMonth();

    return MONTH_OPTIONS.slice(0, Math.max(lastAvailableMonth + 1, 1));
  }

  private dayOptionsFromSelection(selectedYear: string[], selectedMonth: string[]): number[] {
    // The slider max is the last day available in the LAST selected month (capped D-2 if current)
    const limit = this.dayLimitForMonthPosition(selectedYear, selectedMonth, 'last');
    return Array.from({ length: limit }, (_, i) => i + 1);
  }

  /**
   * Returns the maximum available day for either the first or last selected month
   * (sorted chronologically). Caps to D-2 if that month is the current month/year.
   */
  private dayLimitForMonthPosition(selectedYear: string[], selectedMonth: string[], position: 'first' | 'last'): number {
    const normalizedYears = selectedYear.filter((v) => v !== ALL_OPTION);
    const normalizedMonths = selectedMonth.filter((v) => v !== ALL_OPTION);
    const sortedIndexes = normalizedMonths
      .map((v) => MONTH_OPTIONS.indexOf(v))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b);

    if (sortedIndexes.length === 0) return 31;

    const targetIndex = position === 'first' ? sortedIndexes[0] : sortedIndexes[sortedIndexes.length - 1];
    const currentDate = new Date();
    const years = normalizedYears.map(Number).filter(Number.isFinite);
    const resolvedYears = years.length > 0 ? years : [currentDate.getFullYear()];
    let limit = 0;

    for (const year of resolvedYears) {
      const maxDay = new Date(year, targetIndex + 1, 0).getDate();
      const isCurrentPeriod = year === currentDate.getFullYear() && targetIndex === currentDate.getMonth();
      const cap = isCurrentPeriod ? Math.min(maxDay, currentDate.getDate() - 2) : maxDay;
      limit = Math.max(limit, cap);
    }

    return limit > 0 ? limit : 1;
  }

  private buildSelectedFilters(): SpotfireFilter[] {
    const filters: SpotfireFilter[] = [];

    for (const filter of this.secondaryFilters()) {
      if (filter.value.length === 0 || !filter.enabled || !filter.sourceTitle || !filter.sourceKind) {
        continue;
      }

      const selectedValues = filter.value.includes(ALL_OPTION)
        ? filter.options.filter((option) => option !== ALL_OPTION)
        : filter.value;

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
    const yearFilter = this.periodFilters().find((filter) => filter.key === 'ano');
    const monthFilter = this.periodFilters().find((filter) => filter.key === 'mes');
    const year = yearFilter?.value.includes(ALL_OPTION)
      ? yearFilter.options.filter((option) => option !== ALL_OPTION)
      : (yearFilter?.value ?? []);
    const month = monthFilter?.value.includes(ALL_OPTION)
      ? monthFilter.options.filter((option) => option !== ALL_OPTION)
      : (monthFilter?.value ?? []);

    const resolved = this.resolvedDayRange();
    const sortedIndexes = this.sortedActiveMonthIndexes();
    const counts = this.monthDayCounts();

    // Multi-month: each month has its own day range
    //  • first month: resolvedDayRange().min  →  last day of that month
    //  • middle months: 1 → last day of that month (full month)
    //  • last month:  1 → resolvedDayRange().max
    if (sortedIndexes.length > 1 && counts.length === sortedIndexes.length) {
      const monthDayRanges: Record<string, { min: number; max: number }> = {};
      for (let i = 0; i < sortedIndexes.length; i++) {
        const abbr = MONTH_OPTIONS[sortedIndexes[i]];
        const monthMaxDay = counts[i].days;
        if (i === 0) {
          monthDayRanges[abbr] = { min: resolved.min, max: monthMaxDay };
        } else if (i === sortedIndexes.length - 1) {
          monthDayRanges[abbr] = { min: 1, max: resolved.max };
        } else {
          monthDayRanges[abbr] = { min: 1, max: monthMaxDay };
        }
      }
      return {
        year: year.length > 0 ? year : undefined,
        month: month.length > 0 ? month : undefined,
        monthDayRanges,
      };
    }

    // Single month: classic dayRange
    const limit = this.dayLimit();
    const isFullRange = resolved.min <= 1 && resolved.max >= limit;
    return {
      year: year.length > 0 ? year : undefined,
      month: month.length > 0 ? month : undefined,
      dayRange: isFullRange ? undefined : { min: resolved.min, max: resolved.max },
    };
  }

  private resolveValues(value: string[] | undefined, options: string[], fallback: string[]): string[] {
    if (value?.includes(ALL_OPTION) && options.includes(ALL_OPTION)) {
      return [ALL_OPTION];
    }

    const selected = this.orderSelection(options, (value ?? []).filter((entry) => options.includes(entry) && entry !== ALL_OPTION));
    if (selected.length > 0) {
      return selected;
    }

    const fallbackSelection = this.orderSelection(options, fallback.filter((entry) => options.includes(entry) && entry !== ALL_OPTION));
    if (fallbackSelection.length > 0) {
      return fallbackSelection;
    }

    return [];
  }

  private withAllOption(options: string[]): string[] {
    return [...new Set([ALL_OPTION, ...options.filter((option) => option !== ALL_OPTION)])];
  }

  private orderSelection(options: string[], selection: string[]): string[] {
    const selected = new Set(selection.filter((entry) => entry !== ALL_OPTION));
    return options.filter((option) => option !== ALL_OPTION && selected.has(option));
  }

  private saveToStorage(): void {
    const filters = {} as Record<FilterKey, string[]>;
    for (const f of this.selectFilters()) {
      filters[f.key] = f.value;
    }
    const analiticoFiltersMap = {} as Record<ReportFilterKey, string[]>;
    for (const f of this.analiticoFilters()) {
      analiticoFiltersMap[f.key] = f.value;
    }
    const operacionalFiltersMap = {} as Record<ReportFilterKey, string[]>;
    for (const f of this.operacionalFilters()) {
      operacionalFiltersMap[f.key] = f.value;
    }

    const state: SavedFilterState = {
      filters,
      dayRange: this.resolvedDayRange(),
      reportType: this.reportType(),
      analiticoFilters: analiticoFiltersMap,
      operacionalFilters: operacionalFiltersMap,
      savedAt: new Date().toISOString().slice(0, 10),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* quota exceeded - silent */ }
  }

  private loadFromStorage(): SavedFilterState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.filters) {
        const today = new Date().toISOString().slice(0, 10);
        if (parsed.savedAt !== today) {
          delete parsed.dayRange;
          delete parsed.filters.ano;
          delete parsed.filters.mes;
        }
        return parsed as SavedFilterState;
      }
    } catch { /* corrupt data – ignore */ }
    return null;
  }
}
