import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';

import { type GeneratedReport, type OsDiaOrderEvidence, type EficienciaTeamAnalysis, ScannerApiService } from '../../core/api/scanner-api.service';
import { TocNavComponent } from '../../shared/toc/toc-nav.component';
import { SpotfireFilter } from '../../models/spotfire-catalog.model';

type FilterKey = 'ano' | 'mes' | 'atuacaoHd' | 'base';
type ReportTypeValue = 'operacional';
type ReportFilterKey = 'reportBase' | 'reportTipoEquipe' | 'reportEquipe';

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
const REPORT_BASE_OPTIONS = ['Itapajé', 'Itapipoca', 'Trairi', 'Acaraú'];
const REPORT_TEAM_TYPE_OPTIONS = ['Própria', 'Parceira'];
const REPORT_BASE_PREFIX_MAP: Record<string, { own: string; partner: string }> = {
  'Itapajé':   { own: 'ITJ-', partner: 'ITE-' },
  'Itapipoca': { own: 'ITK-', partner: 'IPK-' },
  'Trairi':    { own: 'TRR-', partner: 'IPT-' },
  'Acaraú':    { own: 'ACU-', partner: 'ACA-' },
};
const FILTER_SOURCE_MAP: Record<'atuacaoHd' | 'base', { sourceTitle: string; sourceKind: SpotfireFilter['kind'] }> = {
  atuacaoHd: { sourceTitle: 'Atuação', sourceKind: 'list' },
  base: { sourceTitle: 'Base', sourceKind: 'list' },
};
const REPORT_TYPE_OPTIONS: ReportTypeOption[] = [
  {
    value: 'operacional',
    label: 'Operacional',
  },
];

const STORAGE_KEY = 'scanner_filter_state';

type SavedFilterState = {
  filters: Record<FilterKey, string[]>;
  dayRange: { min: number; max: number };
  reportType: ReportTypeValue;
  reportFilters?: Record<ReportFilterKey, string[]>;
  savedAt?: string;
};

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, TocNavComponent],
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
            <div class="rf-chip" *ngFor="let filter of reportFilterStates(); trackBy: trackByReportFilterKey"
                 (click)="toggleDropdown(filter.key, $event)">
              <span class="rf-chip-label">{{ filter.title }}</span>
              <span class="rf-chip-value">{{ filter.value[0] }}</span>
              <svg class="rf-chip-arrow" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <div class="rf-dropdown" *ngIf="openDropdownKey() === filter.key" (click)="$event.stopPropagation()">
                <input *ngIf="filter.options.length > 8" class="rf-dropdown-search" type="text" placeholder="Buscar…"
                       [value]="dropdownSearch()" (input)="onDropdownSearch($event)" (click)="$event.stopPropagation()"/>
                <div class="rf-dropdown-list">
                  <button *ngFor="let option of filteredDropdownOptions(filter)"
                          class="rf-dropdown-option" [class.rf-dropdown-option-active]="filter.value[0] === option"
                          type="button" (click)="selectDropdownOption(filter.key, option, $event)">
                    <span class="rf-opt-check" *ngIf="filter.value[0] === option">
                      <svg viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5.5l3 3 7-7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
            <article class="drawer-card">
              <div class="drawer-card-head">
                <h3>Tipo de Relatório</h3>
              </div>

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
            </article>

            <article class="drawer-card drawer-card-period">
              <div class="drawer-card-head">
                <h3>Período</h3>
              </div>

              <div class="period-shell">
                <div class="period-selects">
                  <ng-container *ngFor="let filter of periodFilters(); trackBy: trackByFilterKey">
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
                  </ng-container>
                </div>

                <div class="day-range-shell">
                  <div class="range-summary-shell">
                    <span class="select-caption">Dia</span>
                    <div class="day-range-display">
                      <div>
                        <input type="number" class="day-input" min="1" [max]="dayLimit()" [value]="resolvedDayRange().min" (change)="updateDayRangeFromInput('min', $event)" (keydown.enter)="$any($event.target).blur()" aria-label="Dia inicial" />
                      </div>

                      <div>
                        <input type="number" class="day-input" min="1" [max]="dayLimit()" [value]="resolvedDayRange().max" (change)="updateDayRangeFromInput('max', $event)" (keydown.enter)="$any($event.target).blur()" aria-label="Dia final" />
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
              </div>
              <div class="rpt-hero-totals">
                <div class="rpt-total-item">
                  <span class="rpt-total-v">{{ report.totals.teams }}</span>
                  <span class="rpt-total-l">Equipes</span>
                </div>
                <div class="rpt-total-item">
                  <span class="rpt-total-v">{{ report.totals.deslocamentos }}</span>
                  <span class="rpt-total-l">Deslocamentos</span>
                </div>
                <div class="rpt-total-item">
                  <span class="rpt-total-v">{{ report.totals.rankingRows }}</span>
                  <span class="rpt-total-l">Linhas Ranking</span>
                </div>
              </div>
              <button class="rpt-export-btn" (click)="exportPdf()">Exportar PDF</button>
            </div>

            <!-- TOC Scroll Spy sidebar -->
            <app-toc-nav [kpis]="report.kpis" />

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
                      <div class="kpi-cr-fill kpi-cr-fill--good" [style.width.%]="barWidthPct(t.value, kpi.kpi)"></div>
                      <div class="kpi-cr-meta-line" [style.left.%]="kpiMetaPct(kpi.kpi, kpi.metaTarget)"></div>
                    </div>
                    <span class="kpi-cr-val">{{ t.value }}</span>
                  </div>
                  <div class="kpi-cr kpi-cr--avg">
                    <span class="kpi-cr-pos">—</span>
                    <span class="kpi-cr-team kpi-cr-team--avg">Média geral</span>
                    <div class="kpi-cr-track">
                      <div class="kpi-cr-fill kpi-cr-fill--avg" [style.width.%]="barWidthPct(kpi.average, kpi.kpi)"></div>
                      <div class="kpi-cr-meta-line" [style.left.%]="kpiMetaPct(kpi.kpi, kpi.metaTarget)"></div>
                    </div>
                    <span class="kpi-cr-val kpi-cr-val--avg">{{ kpi.average }}</span>
                  </div>
                  <div class="kpi-chart-group-label kpi-group-opp" *ngIf="kpi.opportunityTeams.length > 0">⚠ Oportunidade</div>
                  <div class="kpi-cr kpi-cr--opp" *ngFor="let t of kpi.opportunityTeams; let i = index">
                    <span class="kpi-cr-pos">{{ i + 1 }}</span>
                    <span class="kpi-cr-team">{{ t.team }}</span>
                    <div class="kpi-cr-track">
                      <div class="kpi-cr-fill kpi-cr-fill--bad" [style.width.%]="barWidthPct(t.value, kpi.kpi)"></div>
                      <div class="kpi-cr-meta-line" [style.left.%]="kpiMetaPct(kpi.kpi, kpi.metaTarget)"></div>
                    </div>
                    <span class="kpi-cr-val kpi-cr-val--opp">{{ t.value }}</span>
                  </div>
                </div>
                <!-- OS/Dia drill-down (3 piores) -->
                <ng-container *ngIf="kpi.kpi === 'OS Dia'">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — 3 Piores
                    <span class="rpt-osdia-src-inline">Fonte: Scanner 4.4 - CE M300</span>
                  </div>
                  <ng-container *ngIf="report.specialAnalysis.osDiaAnalysis && report.specialAnalysis.osDiaAnalysis.length > 0; else noOsDiaAnalysis">
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of report.specialAnalysis.osDiaAnalysis">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}</span>
                        <span class="rpt-osdia-badge rpt-osdia-badge--gap">Gap {{ analysis.gap | number:'1.1-1' }} OS/dia</span>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">OS/Dia <strong>{{ analysis.osDiaValue }}</strong></span>
                        <span class="rpt-osdia-chip">Meta <strong>{{ analysis.metaTarget }}</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTrExceeds > 0">
                          TR&gt;20% HD: <strong>{{ analysis.summary.countTrExceeds }}</strong>
                        </span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTlExceeds > 0">
                          TL&gt;20% HD: <strong>{{ analysis.summary.countTlExceeds }}</strong>
                        </span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTempPrepAlto > 0">
                          TempPrep≥10min: <strong>{{ analysis.summary.countTempPrepAlto }}</strong>
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
                              <span class="osdia-idle-chip osdia-idle-chip--hd">HD Médio/dia <strong>{{ analysis.hdTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--prep">TempPrep Médio/dia <strong>{{ analysis.tempPrepTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--sem">SemOrdem Médio/dia <strong>{{ analysis.semOrdemTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--idle">Ocioso Médio/dia <strong>{{ analysis.idleAnalysis.idleMin | number:'1.0-0' }} min ({{ analysis.idleAnalysis.idlePct | number:'1.1-1' }}%) — limite: 10%</strong></span>
                            </div>
                          </ng-container>
                          <!-- Ordens flagadas -->
                          <div class="osdia-ev-list" *ngIf="analysis.flaggedOrders.length > 0">
                            <div class="osdia-ev-item" *ngFor="let ev of analysis.flaggedOrders">
                              <!-- Header: ordem + alertas -->
                              <div class="osdia-ev-header">
                                <span class="osdia-ev-ordem">OS {{ ev.nr_ordem }}</span>
                                <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ osDiaFlagLabel(f) }}</span>
                              </div>
                              <!-- Causa -->
                              <p class="osdia-ev-causa" *ngIf="ev.classe || ev.causa">
                                <span *ngIf="ev.classe"><strong>Classe:</strong> {{ ev.classe }}</span>
                                <span class="osdia-ev-causa-sep" *ngIf="ev.classe && ev.causa"> · </span>
                                <span *ngIf="ev.causa"><strong>Causa:</strong> {{ ev.causa }}</span>
                              </p>
                              <!-- Linha do tempo -->
                              <ng-container *ngIf="ev.prev_liberada; else primeiraOsBlock">
                                <!-- OS Anterior -->
                                <div class="osdia-ev-timeline">
                                  <span class="osdia-ev-ts-label osdia-ev-ts-first">OS Anterior ({{ ev.prev_nr_ordem || '—' }})</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Desp. Anterior</span>
                                  <span class="osdia-ev-ts-val">{{ ev.prev_despachada || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Lib. Anterior</span>
                                  <span class="osdia-ev-ts-val">{{ ev.prev_liberada }}</span>
                                </div>
                                <!-- OS Atual -->
                                <div class="osdia-ev-timeline">
                                  <span class="osdia-ev-ts-label osdia-ev-ts-first">OS Atual</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Despachada</span>
                                  <span class="osdia-ev-ts-val">{{ ev.despachada || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">A Caminho</span>
                                  <span class="osdia-ev-ts-val">{{ ev.a_caminho || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">No Local</span>
                                  <span class="osdia-ev-ts-val">{{ ev.no_local || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Liberada</span>
                                  <span class="osdia-ev-ts-val">{{ ev.liberada || '—' }}</span>
                                </div>
                              </ng-container>
                              <ng-template #primeiraOsBlock>
                                <div class="osdia-ev-timeline">
                                  <span class="osdia-ev-ts-label osdia-ev-ts-first">Início da jornada</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Início Calendário</span>
                                  <span class="osdia-ev-ts-val">{{ ev.inicio_calendario || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">-</span>
                                  <span class="osdia-ev-ts-label">Log In</span>
                                  <span class="osdia-ev-ts-val">{{ ev.log_in || '—' }}</span>
                                </div>
                                <div class="osdia-ev-timeline">
                                  <span class="osdia-ev-ts-label osdia-ev-ts-first">1ª OS da jornada</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Despachada</span>
                                  <span class="osdia-ev-ts-val">{{ ev.despachada || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">A Caminho</span>
                                  <span class="osdia-ev-ts-val">{{ ev.a_caminho || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">No Local</span>
                                  <span class="osdia-ev-ts-val">{{ ev.no_local || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Liberada</span>
                                  <span class="osdia-ev-ts-val">{{ ev.liberada || '—' }}</span>
                                </div>
                              </ng-template>
                              <!-- Intervalo de almoço (se houver dentro da jornada desta OS) -->
                              <div class="osdia-ev-interval" *ngIf="ev.inicio_intervalo">
                                <span class="osdia-ev-int-icon">⏸</span>
                                <span class="osdia-ev-int-label">Intervalo:</span>
                                <span class="osdia-ev-int-val">{{ ev.inicio_intervalo }}</span>
                                <span class="osdia-ev-int-sep">→</span>
                                <span class="osdia-ev-int-val">{{ ev.fim_intervalo || '—' }}</span>
                              </div>
                              <!-- Alertas em prosa -->
                              <ul class="osdia-ev-alerts">
                                <li *ngIf="ev.flags.includes('tr_excede_hd')" class="osdia-ev-alert">
                                  <strong>Tempo de Reparo alto:</strong> {{ ev.tr_ordem_min }} min
                                  ({{ ev.hd_pct_tr }}% da jornada de {{ ev.hd_total_min }} min — limite: 20% da HD)
                                  — tempo padrão M300: <strong>{{ ev.tempo_padrao_min !== undefined ? ev.tempo_padrao_min + ' min' : 'vazio' }}</strong>.
                                </li>
                                <li *ngIf="ev.flags.includes('tl_excede_hd')" class="osdia-ev-alert">
                                  <strong>Tempo de Deslocamento alto:</strong> {{ ev.tl_ordem_min }} min ({{ ev.hd_pct_tl }}% da jornada de {{ ev.hd_total_min }} min) — limite sugerido: 20% da HD.
                                </li>
                                <li *ngIf="ev.flags.includes('temp_prep_alto')" class="osdia-ev-alert">
                                  <strong>TempPrep/OS elevado:</strong> {{ ev.temp_prep_os_min }} min aguardando confirmação de "A Caminho" após <ng-container *ngIf="ev.prev_liberada">Despacho/Lib. Anterior — limite: 10 min</ng-container><ng-container *ngIf="!ev.prev_liberada">Início do Calendário (1ª OS da jornada) — limite: 10 min</ng-container>.
                                </li>
                                <li *ngIf="ev.flags.includes('sem_os_alto') && ev.sem_os_details?.length" class="osdia-ev-alert">
                                  <strong>SemOrdem/OS:</strong> {{ ev.sem_os_total_min }} min — limite: 10 min.
                                  <ol class="osdia-sem-os-list">
                                    <li *ngFor="let d of ev.sem_os_details">
                                      <ng-container [ngSwitch]="d.type">
                                        <ng-container *ngSwitchCase="'inicio_jornada'"><strong>Início Jornada:</strong> {{ d.min }} min do Início Calendário ({{ d.from || '—' }}) até Despachada ({{ d.to || '—' }}).</ng-container>
                                        <ng-container *ngSwitchCase="'entre_ordens'"><strong>Entre OS:</strong> {{ d.min }} min sem nova OS — Lib. Anterior ({{ d.from || '\u2014' }})<ng-container *ngIf="d.desp_anterior"> · Desp. Anterior ({{ d.desp_anterior }})</ng-container> até Despachada ({{ d.to || '\u2014' }})<ng-container *ngIf="d.interval_discounted"> — intervalo descontado</ng-container>.</ng-container>
                                        <ng-container *ngSwitchCase="'fim_jornada'"><strong>Antes Log Off:</strong> {{ d.min }} min entre última Liberada ({{ d.from || '\u2014' }}) e Log Off Corrigido ({{ d.to || '\u2014' }})<ng-container *ngIf="d.interval_discounted"> — intervalo de 60 min descontado</ng-container><ng-container *ngIf="d.retorno_base_discounted"> — retorno base <ng-container *ngIf="d.retorno_base_used_row">do dia ({{ d.retorno_base_discounted }} min) descontado</ng-container><ng-container *ngIf="!d.retorno_base_used_row">médio ({{ d.retorno_base_discounted }} min) descontado</ng-container></ng-container>.</ng-container>
                                        <ng-container *ngSwitchCase="'intervalo_deslocamento'"><strong>Desl. Intervalo:</strong> {{ d.min }} min — Lib. Anterior ({{ d.from || '\u2014' }}) até Início Intervalo ({{ d.to || '\u2014' }}).</ng-container>
                                      </ng-container>
                                    </li>
                                  </ol>
                                </li>
                              </ul>
                            </div>
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
                    <p class="rpt-no-data">Nenhuma equipe abaixo da meta de OS/Dia para os filtros selecionados.</p>
                  </ng-template>
                </ng-container>
                <!-- Eficiência drill-down (evidências de incidências) -->
                <ng-container *ngIf="kpi.kpi === 'Eficiência' && kpi.evidenceAnalysis && kpi.evidenceAnalysis.length > 0">                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — Top 3 e Piores 3 Equipes
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
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">Média <strong>{{ analysis.averageEficiencia }}%</strong></span>
                        <span class="rpt-osdia-chip">TL Médio <strong>{{ analysis.avgDeslocamentoMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip">TR Médio <strong>{{ analysis.avgExecucaoMin | number:'1.1-1' }} min</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.avgTempoPadraoMin > 0">T. Padrão Médio <strong>{{ analysis.avgTempoPadraoMin | number:'1.1-1' }} min</strong></span>
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
                            <span class="osdia-idle-chip osdia-idle-chip--hd">TL Global <strong>{{ analysis.globalAvgDeslocamentoMin | number:'1.1-1' }} min</strong></span>
                            <span class="osdia-idle-chip osdia-idle-chip--prep">TR Global <strong>{{ analysis.globalAvgExecucaoMin | number:'1.1-1' }} min</strong></span>
                            <span class="osdia-idle-chip osdia-idle-chip--idle" *ngIf="analysis.flags.includes('short_displacement')">
                              TL curto: <strong>{{ analysis.avgDeslocamentoMin | number:'1.1-1' }} min (≤ {{ (analysis.globalAvgDeslocamentoMin * 0.25) | number:'1.1-1' }} min — 25% global)</strong>
                            </span>
                          </div>

                          <!-- Ordens flagadas (TR>HD, Desloc. Curto) -->
                          <div class="osdia-ev-list" *ngIf="analysis.flaggedOrders.length > 0">
                            <div class="osdia-ev-item" *ngFor="let ev of analysis.flaggedOrders">
                              <div class="osdia-ev-header">
                                <span class="osdia-ev-ordem">OS {{ ev.nr_ordem }}</span>
                                <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ eficienciaFlagLabel(f) }}</span>
                              </div>
                              <p class="osdia-ev-causa" *ngIf="ev.classe || ev.causa">
                                <span *ngIf="ev.classe"><strong>Classe:</strong> {{ ev.classe }}</span>
                                <span class="osdia-ev-causa-sep" *ngIf="ev.classe && ev.causa"> &middot; </span>
                                <span *ngIf="ev.causa"><strong>Causa:</strong> {{ ev.causa }}</span>
                              </p>
                              <div class="osdia-ev-timeline">
                                <span class="osdia-ev-ts-label osdia-ev-ts-first">OS</span>
                                <span class="osdia-ev-ts-sep">→</span>
                                <span class="osdia-ev-ts-label">Despachada</span>
                                <span class="osdia-ev-ts-val">{{ ev.despachada || '—' }}</span>
                                <span class="osdia-ev-ts-sep">→</span>
                                <span class="osdia-ev-ts-label">A Caminho</span>
                                <span class="osdia-ev-ts-val">{{ ev.a_caminho || '—' }}</span>
                                <span class="osdia-ev-ts-sep">→</span>
                                <span class="osdia-ev-ts-label">No Local</span>
                                <span class="osdia-ev-ts-val">{{ ev.no_local || '—' }}</span>
                                <span class="osdia-ev-ts-sep">→</span>
                                <span class="osdia-ev-ts-label">Liberada</span>
                                <span class="osdia-ev-ts-val">{{ ev.liberada || '—' }}</span>
                              </div>
                              <ul class="osdia-ev-alerts">
                                <li *ngIf="ev.flags.includes('tr_muito_baixo')" class="osdia-ev-alert">
                                  <strong>Tempo de Reparo muito baixo:</strong> {{ ev.tr_ordem_min }} min
                                  (abaixo de 20% do tempo padrão<ng-container *ngIf="ev.tempo_padrao_min !== undefined"> de {{ ev.tempo_padrao_min }} min</ng-container> e da média global de {{ analysis.globalAvgExecucaoMin | number:'1.1-1' }} min).
                                </li>
                                <li *ngIf="ev.flags.includes('deslocamento_curto')" class="osdia-ev-alert">
                                  <strong>Deslocamento (TL) muito curto:</strong> {{ ev.tl_ordem_min }} min
                                  (&le; {{ (analysis.globalAvgDeslocamentoMin * 0.25) | number:'1.1-1' }} min &mdash; 25% da média geral de {{ analysis.globalAvgDeslocamentoMin | number:'1.1-1' }} min).
                                </li>
                                <li *ngIf="ev.flags.includes('tr_excede_hd')" class="osdia-ev-alert">
                                  <strong>Tempo de Reparo alto:</strong> {{ ev.tr_ordem_min }} min
                                  ({{ ev.hd_pct_tr }}% da jornada de {{ ev.hd_total_min }} min &mdash; limite: 20% da HD) &mdash; tempo padrão M300: <strong>{{ ev.tempo_padrao_min !== undefined ? ev.tempo_padrao_min + ' min' : 'vazio' }}</strong>.
                                </li>
                                <li *ngIf="ev.flags.includes('tempo_padrao_vazio')" class="osdia-ev-alert">
                                  <strong>Tempo Padrão ausente:</strong> TR {{ ev.tr_ordem_min }} min — sem tempo padrão cadastrado, eficiência calculada como zero para esta OS.
                                </li>
                              </ul>
                            </div>
                          </div>

                          <!-- Simulação: equipe penalizada por T.Padrão ausente -->
                          <ng-container *ngIf="analysis.summary.countTempoPadraoVazio > 0">
                            <p class="osdia-idle-desc">
                              <strong>Equipe penalizada por ausência de Tempo Padrão:</strong>
                              {{ analysis.summary.countTempoPadraoVazio }} ordem(ns) sem tempo padrão cadastrado. O sistema calcula a eficiência como <em>Tempo Padrão / TR</em>, portanto ordens vazias contam como zero, prejudicando o resultado.<ng-container *ngIf="analysis.simulatedEficiencia !== undefined && analysis.simulatedEficiencia !== null">
                              <br><strong>Simulação:</strong> se usassem o TR médio global ({{ analysis.globalAvgExecucaoMin | number:'1.1-1' }} min), a eficiência estimada seria
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
                <!-- Utilização drill-down (3 piores) -->
                <ng-container *ngIf="kpi.kpi === 'Utilização' && report.specialAnalysis.utilizacaoAnalysis && report.specialAnalysis.utilizacaoAnalysis.length > 0">
                  <div class="kpi-osdia-drill-head">
                    🔍 Análise Detalhada — 3 Piores
                    <span class="rpt-osdia-src-inline">Fonte: Tab_Completa-Deslocamentos</span>
                  </div>
                  <div class="rpt-osdia-grid">
                    <div class="rpt-osdia-card" *ngFor="let analysis of report.specialAnalysis.utilizacaoAnalysis">
                      <div class="rpt-osdia-card-head">
                        <span class="rpt-osdia-team">{{ analysis.team }}</span>
                        <span class="rpt-osdia-badge rpt-osdia-badge--gap">Gap {{ analysis.gap | number:'1.1-1' }}%</span>
                      </div>
                      <div class="rpt-osdia-card-meta">
                        <span class="rpt-osdia-chip">Utilização <strong>{{ analysis.utilizacaoValue }}%</strong></span>
                        <span class="rpt-osdia-chip">Meta <strong>{{ analysis.metaTarget }}%</strong></span>
                        <span class="rpt-osdia-chip" *ngIf="analysis.summary.countTempPrepAlto > 0">
                          TempPrep≥10min: <strong>{{ analysis.summary.countTempPrepAlto }}</strong>
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
                              <span class="osdia-idle-chip osdia-idle-chip--hd">HD Médio/dia <strong>{{ analysis.hdTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--prep">TempPrep Médio/dia <strong>{{ analysis.tempPrepTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--sem">SemOrdem Médio/dia <strong>{{ analysis.semOrdemTotalMin | number:'1.0-0' }} min</strong></span>
                              <span class="osdia-idle-chip osdia-idle-chip--idle">Ocioso Médio/dia <strong>{{ analysis.idleAnalysis.idleMin | number:'1.0-0' }} min ({{ analysis.idleAnalysis.idlePct | number:'1.1-1' }}%) — limite: 10%</strong></span>
                            </div>
                          </ng-container>
                          <!-- Ordens flagadas -->
                          <div class="osdia-ev-list" *ngIf="analysis.flaggedOrders.length > 0">
                            <div class="osdia-ev-item" *ngFor="let ev of analysis.flaggedOrders">
                              <!-- Header: ordem + alertas -->
                              <div class="osdia-ev-header">
                                <span class="osdia-ev-ordem">OS {{ ev.nr_ordem }}</span>
                                <span class="rpt-osdia-flag" *ngFor="let f of ev.flags">{{ osDiaFlagLabel(f) }}</span>
                              </div>
                              <!-- Causa -->
                              <p class="osdia-ev-causa" *ngIf="ev.classe || ev.causa">
                                <span *ngIf="ev.classe"><strong>Classe:</strong> {{ ev.classe }}</span>
                                <span class="osdia-ev-causa-sep" *ngIf="ev.classe && ev.causa"> · </span>
                                <span *ngIf="ev.causa"><strong>Causa:</strong> {{ ev.causa }}</span>
                              </p>
                              <!-- Linha do tempo -->
                              <ng-container *ngIf="ev.prev_liberada; else primeiraOsUtilBlock">
                                <!-- OS Anterior -->
                                <div class="osdia-ev-timeline">
                                  <span class="osdia-ev-ts-label osdia-ev-ts-first">OS Anterior ({{ ev.prev_nr_ordem || '—' }})</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Desp. Anterior</span>
                                  <span class="osdia-ev-ts-val">{{ ev.prev_despachada || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Lib. Anterior</span>
                                  <span class="osdia-ev-ts-val">{{ ev.prev_liberada }}</span>
                                </div>
                                <!-- OS Atual -->
                                <div class="osdia-ev-timeline">
                                  <span class="osdia-ev-ts-label osdia-ev-ts-first">OS Atual</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Despachada</span>
                                  <span class="osdia-ev-ts-val">{{ ev.despachada || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">A Caminho</span>
                                  <span class="osdia-ev-ts-val">{{ ev.a_caminho || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">No Local</span>
                                  <span class="osdia-ev-ts-val">{{ ev.no_local || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Liberada</span>
                                  <span class="osdia-ev-ts-val">{{ ev.liberada || '—' }}</span>
                                </div>
                              </ng-container>
                              <ng-template #primeiraOsUtilBlock>
                                <div class="osdia-ev-timeline">
                                  <span class="osdia-ev-ts-label osdia-ev-ts-first">Início da jornada</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Início Calendário</span>
                                  <span class="osdia-ev-ts-val">{{ ev.inicio_calendario || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">-</span>
                                  <span class="osdia-ev-ts-label">Log In</span>
                                  <span class="osdia-ev-ts-val">{{ ev.log_in || '—' }}</span>
                                </div>
                                <div class="osdia-ev-timeline">
                                  <span class="osdia-ev-ts-label osdia-ev-ts-first">1ª OS da jornada</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Despachada</span>
                                  <span class="osdia-ev-ts-val">{{ ev.despachada || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">A Caminho</span>
                                  <span class="osdia-ev-ts-val">{{ ev.a_caminho || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">No Local</span>
                                  <span class="osdia-ev-ts-val">{{ ev.no_local || '—' }}</span>
                                  <span class="osdia-ev-ts-sep">→</span>
                                  <span class="osdia-ev-ts-label">Liberada</span>
                                  <span class="osdia-ev-ts-val">{{ ev.liberada || '—' }}</span>
                                </div>
                              </ng-template>
                              <!-- Intervalo de almoço (se houver dentro da jornada desta OS) -->
                              <div class="osdia-ev-interval" *ngIf="ev.inicio_intervalo">
                                <span class="osdia-ev-int-icon">⏸</span>
                                <span class="osdia-ev-int-label">Intervalo:</span>
                                <span class="osdia-ev-int-val">{{ ev.inicio_intervalo }}</span>
                                <span class="osdia-ev-int-sep">→</span>
                                <span class="osdia-ev-int-val">{{ ev.fim_intervalo || '—' }}</span>
                              </div>
                              <!-- Alertas em prosa -->
                              <ul class="osdia-ev-alerts">
                                <li *ngIf="ev.flags.includes('temp_prep_alto')" class="osdia-ev-alert">
                                  <strong>TempPrep/OS elevado:</strong> {{ ev.temp_prep_os_min }} min aguardando confirmação de "A Caminho" após <ng-container *ngIf="ev.prev_liberada">Despacho/Lib. Anterior — limite: 10 min</ng-container><ng-container *ngIf="!ev.prev_liberada">Início do Calendário (1ª OS da jornada) — limite: 10 min</ng-container>.
                                </li>
                                <li *ngIf="ev.flags.includes('sem_os_alto') && ev.sem_os_details?.length" class="osdia-ev-alert">
                                  <strong>SemOrdem/OS:</strong> {{ ev.sem_os_total_min }} min — limite: 10 min.
                                  <ol class="osdia-sem-os-list">
                                    <li *ngFor="let d of ev.sem_os_details">
                                      <ng-container [ngSwitch]="d.type">
                                        <ng-container *ngSwitchCase="'inicio_jornada'"><strong>Início Jornada:</strong> {{ d.min }} min do Início Calendário ({{ d.from || '—' }}) até Despachada ({{ d.to || '—' }}).</ng-container>
                                        <ng-container *ngSwitchCase="'entre_ordens'"><strong>Entre OS:</strong> {{ d.min }} min sem nova OS — Lib. Anterior ({{ d.from || '\u2014' }})<ng-container *ngIf="d.desp_anterior"> · Desp. Anterior ({{ d.desp_anterior }})</ng-container> até Despachada ({{ d.to || '\u2014' }})<ng-container *ngIf="d.interval_discounted"> — intervalo descontado</ng-container>.</ng-container>
                                        <ng-container *ngSwitchCase="'fim_jornada'"><strong>Antes Log Off:</strong> {{ d.min }} min entre última Liberada ({{ d.from || '\u2014' }}) e Log Off Corrigido ({{ d.to || '\u2014' }})<ng-container *ngIf="d.interval_discounted"> — intervalo de 60 min descontado</ng-container><ng-container *ngIf="d.retorno_base_discounted"> — retorno base <ng-container *ngIf="d.retorno_base_used_row">do dia ({{ d.retorno_base_discounted }} min) descontado</ng-container><ng-container *ngIf="!d.retorno_base_used_row">médio ({{ d.retorno_base_discounted }} min) descontado</ng-container></ng-container>.</ng-container>
                                        <ng-container *ngSwitchCase="'intervalo_deslocamento'"><strong>Desl. Intervalo:</strong> {{ d.min }} min — Lib. Anterior ({{ d.from || '\u2014' }}) até Início Intervalo ({{ d.to || '\u2014' }}).</ng-container>
                                      </ng-container>
                                    </li>
                                  </ol>
                                </li>
                              </ul>
                            </div>
                          </div>
                        </div>
                      </ng-container>
                      <ng-template #noUtilizacaoEvidence>
                        <p class="rpt-no-data">Nenhuma ordem com alertas nos dados filtrados.</p>
                      </ng-template>
                    </div>
                  </div>
                </ng-container>
              </section>
            </ng-container>

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

            <!-- TempPrep / SemOs -->
            <section class="rpt-section anim-el" *ngIf="report.specialAnalysis.tempPrepAndSemOs.length > 0">
              <h2 class="rpt-section-title">⏱ TempPrep/Dia e SemOrdem/Dia <span class="rpt-section-note">(média diária em minutos)</span></h2>
              <div class="rpt-table-wrap">
                <table class="rpt-table">
                  <thead>
                    <tr>
                      <th>Equipe</th>
                      <th class="rpt-td-num">Dias</th>
                      <th class="rpt-td-num">TempPrep/Dia (min)</th>
                      <th class="rpt-td-num">SemOrdem/Dia (min)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr *ngFor="let tm of report.specialAnalysis.tempPrepAndSemOs">
                      <td>{{ tm.team }}</td>
                      <td class="rpt-td-num">{{ tm.records }}</td>
                      <td class="rpt-td-num">{{ tm.tempPrepJornada }}</td>
                      <td class="rpt-td-num" [class.rpt-td-high]="tm.semOrdemJornada > 30">{{ tm.semOrdemJornada }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <!-- Análise Cruzada -->
            <section class="rpt-section anim-el" *ngIf="report.specialAnalysis.crossedInsights.length > 0">
              <h2 class="rpt-section-title">🔀 Análise Cruzada</h2>
              <div class="rpt-cross-grid">
                <div class="rpt-glass-card" *ngFor="let insight of report.specialAnalysis.crossedInsights">
                  <h3 class="rpt-card-sub">{{ insight.title }}</h3>
                  <p class="rpt-cross-desc">{{ insight.description }}</p>
                  <ng-container *ngIf="insight.evidence.length > 0; else noEvidence">
                    <div class="rpt-cross-rows">
                      <div class="rpt-cross-row" *ngFor="let row of insight.evidence">
                        <span *ngFor="let key of objectKeys(row)" class="rpt-cross-cell">
                          <span class="rpt-cross-key">{{ key }}</span>
                          <span class="rpt-cross-val">{{ row[key] }}</span>
                        </span>
                      </div>
                    </div>
                  </ng-container>
                  <ng-template #noEvidence>
                    <p class="rpt-no-data">Sem evidências para os filtros selecionados.</p>
                  </ng-template>
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
        width: min(1000px, 100%);
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
        color: var(--accent);
        flex-shrink: 0;
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
          rgba(60, 40, 30, 0.12) 0%,
          rgba(60, 40, 30, 0.12) var(--range-start),
          rgba(192, 18, 45, 0.75) var(--range-start),
          rgba(192, 18, 45, 0.75) var(--range-end),
          rgba(60, 40, 30, 0.12) var(--range-end),
          rgba(60, 40, 30, 0.12) 100%
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
        .report-filter-groups {
          gap: 6px;
        }

        .workspace-stage {
          padding-top: 116px;
        }

        .filter-fab {
          top: 122px;
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
        padding: 72px 20px 80px;
        display: grid;
        gap: 28px;
        align-content: start;
        max-width: 1100px;
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
        grid-template-columns: 22px 180px 1fr 60px;
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

      .osdia-ev-alert strong {
        color: #b91c3a;
      }

      .osdia-sem-os-list {
        margin: 2px 0 0 6px;
        padding: 0;
        list-style: decimal;
        font-size: 0.74rem;
        color: var(--text);
        line-height: 1.5;
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

      @media print {
        .filter-drawer, .filter-fab, .report-filter-bar,
        .rpt-export-btn, .drawer-backdrop { display: none !important; }
        .shell {
          background: #f5f4f0 !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        .anim-el { opacity: 1 !important; transform: none !important; }
        .kpi-cr-fill { transition: none !important; }
      }
    `,
  ],
})
export class DashboardComponent implements OnInit, OnDestroy, AfterViewInit {
  protected readonly api = inject(ScannerApiService);
  private readonly zone = inject(NgZone);
  protected readonly allOption = ALL_OPTION;

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
  protected readonly reportBarHidden = signal(true);
  protected readonly reportData = signal<GeneratedReport | null>(null);
  protected readonly reportTitle = signal(DEFAULT_REPORT_TITLE);
  protected readonly reportType = signal<ReportTypeValue>('operacional');
  protected readonly selectFilters = signal<SelectFilterState[]>([]);
  protected readonly reportFilterStates = signal<ReportSelectFilterState[]>([]);
  protected readonly openDropdownKey = signal<ReportFilterKey | null>(null);
  protected readonly dropdownSearch = signal('');
  protected readonly dayRange = signal({ min: 1, max: 31 });
  protected readonly resolvedDayRange = computed(() => {
    const r = this.dayRange();
    return { min: Math.min(r.min, r.max), max: Math.max(r.min, r.max) };
  });
  protected readonly reportTypeOptions = REPORT_TYPE_OPTIONS;
  protected readonly filtersVisible = computed(() => this.selectFilters().length > 0);
  protected readonly periodFilters = computed(() => this.selectFilters().filter((filter) => filter.key === 'ano' || filter.key === 'mes'));
  protected readonly secondaryFilters = computed(() => this.selectFilters().filter((filter) => filter.key !== 'ano' && filter.key !== 'mes'));
  protected readonly dayLimit = computed(() => {
    const year = this.periodFilters().find((filter) => filter.key === 'ano')?.value ?? [];
    const month = this.periodFilters().find((filter) => filter.key === 'mes')?.value ?? [];
    const days = this.dayOptionsFromSelection(year, month);
    return days[days.length - 1] ?? 31;
  });
  protected readonly dayRangeStart = computed(() => {
    const limit = this.dayLimit();
    return limit > 1 ? ((this.resolvedDayRange().min - 1) / (limit - 1)) * 100 : 0;
  });
  protected readonly dayRangeEnd = computed(() => {
    const limit = this.dayLimit();
    return limit > 1 ? ((this.resolvedDayRange().max - 1) / (limit - 1)) * 100 : 100;
  });

  private readonly KPI_CHART_CONFIG: Record<string, { worst: number; best: number; direction: 'h' | 'l' }> = {
    'OS Dia':        { worst: 1.0,  best: 5.5,  direction: 'h' },
    'Eficiência':    { worst: 80,   best: 125,  direction: 'h' },
    'Utilização':    { worst: 60,   best: 88,   direction: 'h' },
    'Reparo Por OS': { worst: 1.32, best: 1.18, direction: 'l' },
    'TME':           { worst: 72,   best: 45,   direction: 'l' },
    'TME IMP':       { worst: 28,   best: 17,   direction: 'l' },
    '1º Login':      { worst: 12,   best: 7,    direction: 'l' },
    '1º Desloc.':    { worst: 30,   best: 20,   direction: 'l' },
    'Retorno Base':  { worst: 50,   best: 35,   direction: 'l' },
  };

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
    const saved = this.loadFromStorage();
    // Restore extraction filters (ano, mes, etc.) only for context — not used on F5
    const overrides = saved ? new Map(Object.entries(saved.filters) as [FilterKey, string[]][]) : undefined;
    const builtFilters = this.buildSelectFilters(overrides);
    this.selectFilters.set(builtFilters);

    // Restore report filters (Base, Tipo Equipe, Equipe) from storage
    const baseReportFilters = this.buildReportFilterStates();
    if (saved?.reportFilters) {
      const restored = baseReportFilters.map((f) => {
        const savedVal = saved.reportFilters![f.key];
        return savedVal ? { ...f, value: savedVal } : f;
      });
      this.reportFilterStates.set(this.cascadeReportFilters(restored));
    } else {
      this.reportFilterStates.set(baseReportFilters);
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

  protected barWidthPct(value: number, kpiName: string): number {
    const cfg = this.KPI_CHART_CONFIG[kpiName];
    if (!cfg || !Number.isFinite(value)) return 0;
    const pct = cfg.direction === 'h'
      ? (value - cfg.worst) / (cfg.best - cfg.worst) * 100
      : (cfg.worst - value) / (cfg.worst - cfg.best) * 100;
    return Math.max(2, Math.min(100, pct));
  }

  protected kpiMetaPct(kpiName: string, metaTarget: number): number {
    return this.barWidthPct(metaTarget, kpiName);
  }

  protected exportPdf(): void {
    window.print();
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
    this.saveToStorage();
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

  protected osDiaFlagLabel(flag: string): string {
    const labels: Record<string, string> = {
      tr_excede_hd:       'TR>20%HD',
      tl_excede_hd:       'TL>20%HD',
      temp_prep_alto:     'TempPrep≥20min',
      sem_os_alto:        'SemOS≥10min',
    };
    return labels[flag] ?? flag;
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
    const labels: Record<string, string> = {
      deslocamento_curto: 'Desloc. Curto',
      tr_excede_hd: 'TR>20%HD',
      tr_muito_baixo: 'TR Baixo',
      tempo_padrao_vazio: 'T.Padrão Vazio',
    };
    return labels[flag] ?? flag;
  }

  protected getFimJornadaDetail(ev: OsDiaOrderEvidence): NonNullable<OsDiaOrderEvidence['sem_os_details']>[number] | null {
    return ev.sem_os_details?.find((d: NonNullable<OsDiaOrderEvidence['sem_os_details']>[number]) => d.type === 'fim_jornada') ?? null;
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

    return filter.value.join(', ');
  }

  protected toggleReportFilterOption(key: ReportFilterKey, option: string): void {
    const filters = this.reportFilterStates();
    const updated = filters.map((filter) => filter.key === key ? { ...filter, value: [option] } : filter);
    this.reportFilterStates.set(this.cascadeReportFilters(updated));
    this.scheduleInstantReportRefresh();
  }

  protected onReportSelectChange(key: ReportFilterKey, event: Event): void {
    const value = String((event.target as HTMLSelectElement | null)?.value ?? ALL_OPTION);
    this.toggleReportFilterOption(key, value);
  }

  protected toggleDropdown(key: ReportFilterKey, event: Event): void {
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
    this.toggleReportFilterOption(key, option);
    this.openDropdownKey.set(null);
    this.dropdownSearch.set('');
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

  protected updateDayRange(boundary: 'min' | 'max', event: Event): void {
    const value = Number((event.target as HTMLInputElement | null)?.value ?? Number.NaN);
    if (Number.isNaN(value)) {
      return;
    }

    this.dayRange.update((range) => {
      return {
        min: boundary === 'min' ? value : range.min,
        max: boundary === 'max' ? value : range.max,
      };
    });
    this.saveToStorage();
  }

  protected updateDayRangeFromInput(boundary: 'min' | 'max', event: Event): void {
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
              this.reportData.set(result.generatedReport);
              this.loading.set(false);
              this.progressMessage.set('');
              this.setupAnimations();
              this.fetchAndUpdateTeams();
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
        this.reportData.set(result.generatedReport);
        this.loading.set(false);
        this.progressMessage.set('');
        this.setupAnimations();
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

  private buildReportFilterStates(): ReportSelectFilterState[] {
    return [
      {
        key: 'reportBase',
        title: 'Base (Relatório)',
        value: [ALL_OPTION],
        options: this.withAllOption(REPORT_BASE_OPTIONS),
        enabled: true,
      },
      {
        key: 'reportTipoEquipe',
        title: 'Tipo de Equipe (Relatório)',
        value: [ALL_OPTION],
        options: this.withAllOption(REPORT_TEAM_TYPE_OPTIONS),
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
  } {
    const baseFilter = this.reportFilterStates().find((filter) => filter.key === 'reportBase');
    const teamTypeFilter = this.reportFilterStates().find((filter) => filter.key === 'reportTipoEquipe');
    const equipeFilter = this.reportFilterStates().find((filter) => filter.key === 'reportEquipe');

    const normalize = (filter: ReportSelectFilterState | undefined): string[] => {
      if (!filter || filter.value.includes(ALL_OPTION)) {
        return [];
      }
      return filter.value;
    };

    const selectedTypes = normalize(teamTypeFilter)
      .map((value) => value === 'Própria' ? 'propria' : value === 'Parceira' ? 'parceira' : null)
      .filter((value): value is 'propria' | 'parceira' => value !== null);

    const selectedBases = normalize(baseFilter);
    const selectedTeams = normalize(equipeFilter);

    return {
      bases: selectedBases.length > 0 ? selectedBases : undefined,
      teamTypes: selectedTypes.length > 0 ? selectedTypes : undefined,
      teams: selectedTeams.length > 0 ? selectedTeams : undefined,
      includeExtraTags: true,
    };
  }

  private cascadeReportFilters(filters: ReportSelectFilterState[]): ReportSelectFilterState[] {
    const baseF = filters.find((f) => f.key === 'reportBase');
    const tipoF = filters.find((f) => f.key === 'reportTipoEquipe');
    const equipeF = filters.find((f) => f.key === 'reportEquipe');

    const selectedBase = baseF && !baseF.value.includes(ALL_OPTION) ? baseF.value[0] : null;
    const selectedTipo = tipoF && !tipoF.value.includes(ALL_OPTION) ? tipoF.value[0] : null;
    const selectedEquipe = equipeF && !equipeF.value.includes(ALL_OPTION) ? equipeF.value[0] : null;

    // Build allowed prefixes from base + tipo
    const allowedPrefixes: string[] = [];
    const bases = selectedBase ? [selectedBase] : REPORT_BASE_OPTIONS;
    for (const base of bases) {
      const mapping = REPORT_BASE_PREFIX_MAP[base];
      if (!mapping) continue;
      if (!selectedTipo || selectedTipo === 'Própria') allowedPrefixes.push(mapping.own.toUpperCase());
      if (!selectedTipo || selectedTipo === 'Parceira') allowedPrefixes.push(mapping.partner.toUpperCase());
    }

    // Filter equipe options
    const filteredTeams = this.availableTeams.filter((team) => {
      const upper = team.toUpperCase();
      return allowedPrefixes.length === 0 || allowedPrefixes.some((p) => upper.startsWith(p));
    });

    // If selected equipe no longer matches, reset to All
    const equipeStillValid = selectedEquipe && filteredTeams.some((t) => t === selectedEquipe);

    // Reverse: if equipe is selected, narrow Base and Tipo options
    let filteredBases = REPORT_BASE_OPTIONS;
    let filteredTypes = REPORT_TEAM_TYPE_OPTIONS;

    if (selectedEquipe && equipeStillValid) {
      const upper = selectedEquipe.toUpperCase();
      filteredBases = REPORT_BASE_OPTIONS.filter((base) => {
        const m = REPORT_BASE_PREFIX_MAP[base];
        return m && (upper.startsWith(m.own.toUpperCase()) || upper.startsWith(m.partner.toUpperCase()));
      });
      filteredTypes = REPORT_TEAM_TYPE_OPTIONS.filter((tipo) => {
        return REPORT_BASE_OPTIONS.some((base) => {
          const m = REPORT_BASE_PREFIX_MAP[base];
          if (!m) return false;
          if (tipo === 'Própria') return upper.startsWith(m.own.toUpperCase());
          if (tipo === 'Parceira') return upper.startsWith(m.partner.toUpperCase());
          return false;
        });
      });
    }

    return filters.map((f) => {
      if (f.key === 'reportEquipe') {
        return {
          ...f,
          options: this.withAllOption(filteredTeams),
          value: equipeStillValid ? f.value : [ALL_OPTION],
        };
      }
      if (f.key === 'reportBase') {
        const baseStillValid = selectedBase && filteredBases.includes(selectedBase);
        return {
          ...f,
          options: this.withAllOption(filteredBases),
          value: baseStillValid ? f.value : (selectedBase && !baseStillValid ? [ALL_OPTION] : f.value),
        };
      }
      if (f.key === 'reportTipoEquipe') {
        const tipoStillValid = selectedTipo && filteredTypes.includes(selectedTipo);
        return {
          ...f,
          options: this.withAllOption(filteredTypes),
          value: tipoStillValid ? f.value : (selectedTipo && !tipoStillValid ? [ALL_OPTION] : f.value),
        };
      }
      return f;
    });
  }

  private fetchAndUpdateTeams(): void {
    this.api.getTeams().subscribe({
      next: (result) => {
        this.availableTeams = result.teams;
        const current = this.reportFilterStates();
        this.reportFilterStates.set(this.cascadeReportFilters(current));
      },
    });
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
          this.reportData.set(result.generatedReport);
          this.errorMessage.set('');
          this.setupAnimations();
        },
        error: (error) => {
          const message = error?.error?.message ?? 'Falha ao atualizar relatório';
          this.errorMessage.set(message);
        },
      });
    }, 300);
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
      const d2 = Math.max(currentDate.getDate() - 2, minDay);
      return { min: d2, max: d2 };
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

    // Current year only: limit to months that have scanner data (up to yesterday)
    // If today is day 1, yesterday was last month so current month has no data yet
    const lastAvailableMonth = currentDate.getDate() <= 1
      ? currentDate.getMonth() - 1
      : currentDate.getMonth();

    return MONTH_OPTIONS.slice(0, Math.max(lastAvailableMonth + 1, 1));
  }

  private dayOptionsFromSelection(selectedYear: string[], selectedMonth: string[]): number[] {
    const normalizedYears = selectedYear.filter((value) => value !== ALL_OPTION);
    const normalizedMonths = selectedMonth.filter((value) => value !== ALL_OPTION);
    const selectedMonthIndexes = normalizedMonths
      .map((value) => MONTH_OPTIONS.indexOf(value))
      .filter((index) => index !== -1);

    if (selectedMonthIndexes.length === 0) {
      return Array.from({ length: 31 }, (_, index) => index + 1);
    }

    const currentDate = new Date();
    const resolvedYears = normalizedYears
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    const years = resolvedYears.length > 0 ? resolvedYears : [currentDate.getFullYear()];
    let limit = 0;

    for (const year of years) {
      for (const monthIndex of selectedMonthIndexes) {
        const maxDay = new Date(year, monthIndex + 1, 0).getDate();
        // Scanner only has data up to yesterday, so for the current month/year cap to day-1
        const isCurrentPeriod = year === currentDate.getFullYear() && monthIndex === currentDate.getMonth();
        const limitedMaxDay = isCurrentPeriod
          ? Math.min(maxDay, currentDate.getDate() - 1)
          : maxDay;
        limit = Math.max(limit, limitedMaxDay);
      }
    }

    if (limit <= 0) {
      return [1];
    }

    return Array.from({ length: limit }, (_, index) => index + 1);
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
    const reportFilters = {} as Record<ReportFilterKey, string[]>;
    for (const f of this.reportFilterStates()) {
      reportFilters[f.key] = f.value;
    }
    const state: SavedFilterState = {
      filters,
      dayRange: this.resolvedDayRange(),
      reportType: this.reportType(),
      reportFilters,
      savedAt: new Date().toISOString().slice(0, 10),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* quota exceeded – silent */ }
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
