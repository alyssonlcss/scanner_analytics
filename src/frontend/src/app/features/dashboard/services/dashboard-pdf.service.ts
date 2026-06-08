// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import { Injectable } from '@angular/core';
import type { GeneratedReport, ReportKpiInsight } from '../../../core/api/scanner-api.service';
import { TimelineSegment, buildTimelineSegments, extractTime, parseDt, tlFlexGrow } from '../../../shared/utils/timeline-segment.utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfMake = require('pdfmake/build/pdfmake');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfFonts = require('pdfmake/build/vfs_fonts');
pdfMake.vfs = pdfFonts.pdfMake?.vfs ?? pdfFonts.vfs;

export interface PdfSection {
  report: GeneratedReport;
  title: string;
  subtitle: string;
  dateRangeLabel?: string;
}

export interface PdfHelpers {
  renderEmojiDataUrl: (emoji: string, pxSize: number) => string;
  renderSymbolDataUrl: (symbol: string, pxSize: number, color: string) => string;
  stripEmojiForPdf: (text: string) => string;
  semOsDetailLabel: (d: SemOsDetail, nrOrdemDespachoAnterior?: string) => string;
  semOsDetailBody: (d: SemOsDetail, nrOrdemDespachoAnterior?: string) => string;
  osDiaFlagLabel: (flag: string) => string;
  eficienciaFlagLabel: (flag: string) => string;
  tmeImpFlagLabel: (flag: string) => string;
  loginFlagLabel: (flag: string) => string;
  deslocFlagLabel: (flag: string) => string;
  retornoFlagLabel: (flag: string) => string;
  osDiaAlertBody: (flag: string, ev: { alertTexts?: Record<string, string> }) => string;
  eficienciaAlertBody: (flag: string, ev: { alertTexts?: Record<string, string> }) => string;
  tmeImpAlertBody: (flag: string, ev: { alertTexts?: Record<string, string> }) => string;
  loginAlertBody: (flag: string, ev: { alertTexts?: Record<string, string> }) => string;
  deslocAlertBody: (flag: string, ev: { alertTexts?: Record<string, string> }) => string;
  retornoAlertBody: (flag: string, ev: { alertTexts?: Record<string, string> }) => string;
}

export interface SemOsDetail {
  type: string;
  min: number;
  from?: string;
  to?: string;
  global_avg_min?: number;
  above_avg_pct?: number;
  interval_discounted?: boolean;
  retorno_base_discounted?: number;
  retorno_base_used_row?: boolean;
  desp_anterior?: string;
  label?: string;
  body?: string;
  [key: string]: unknown;
}

@Injectable({ providedIn: 'root' })
export class DashboardPdfService {

  private static readonly TIMELINE_IDLE_LABELS = new Set([
    '1º Despacho', 'Desp. Prioritário', 'Entre OS', 'Desl. Intervalo', 'Partida', 'Deslocamento p/OS', 'Antes Log Off',
  ]);

  private buildTimelinePdfBlock(ev: any, hidePartida = false, trimToACaminho = false): any | null {
    const segs = buildTimelineSegments(ev, hidePartida, trimToACaminho);
    if (!segs.length) return null;

    const IDLE = DashboardPdfService.TIMELINE_IDLE_LABELS;
    const isRepairAlarm = (s: TimelineSegment): boolean => (s.label === 'Reparo' || s.label === 'Log In') && (s.flags?.length ?? 0) > 0;
    const isDeslocAlarm = (s: TimelineSegment): boolean => s.label === 'Deslocamento p/OS' && (s.flags?.length ?? 0) > 0;
    const isIdleLabel = (s: TimelineSegment): boolean => IDLE.has(s.label) || s.label.startsWith('1º Despacho:');
    const isRetornoBaseAlarm = (s: TimelineSegment): boolean => s.label === 'Retorno a base' && (s.flags?.length ?? 0) > 0;
    const getFill = (s: TimelineSegment): string =>
      s.isInterval ? '#fde68a' : isRepairAlarm(s) || isDeslocAlarm(s) || isRetornoBaseAlarm(s) ? '#fca5a5' :
      s.label === 'Deslocamento p/OS' ? '#dbeafe' :
      isIdleLabel(s) ? ((s.flags?.length ?? 0) > 0 ? '#fca5a5' : '#fee2e2') : '#dbeafe';
    const getTxtColor = (s: TimelineSegment): string =>
      s.isInterval ? '#78350f' : (isRepairAlarm(s) || isDeslocAlarm(s) || isRetornoBaseAlarm(s) || (isIdleLabel(s) && s.label !== 'Deslocamento p/OS' && (s.flags?.length ?? 0) > 0)) ? '#7f1d1d' : (isIdleLabel(s) && s.label !== 'Deslocamento p/OS') ? '#7f1d1d' : '#1e3a8a';

    // 1. Larguras proporcionais puras (mesma lógica do flex-grow da web).
    const CHAR_W = 3.6;   // pt/char estimado para Roboto bold 5.5pt
    const TOTAL_W = 500;
    const grows = segs.map(s => tlFlexGrow(s.durationMin));
    const totalGrow = grows.reduce((a, b) => a + b, 0);
    const rawWidths = grows.map(g => (g / totalGrow) * TOTAL_W);

    // 2. Mínimo para caber o texto em uma linha.
    const minWidths = segs.map(s => {
      const durStr = s.overrideDuration ?? `${s.durationMin}min`;
      const durFull = s.subtitle ? `${durStr} | ${s.subtitle}` : durStr;
      return Math.ceil(Math.max(s.label.length, durFull.length) * CHAR_W + 4);
    });

    // 3. Aplica mínimos (boost segmentos estreitos demais).
    let widths = segs.map((_, i) => Math.max(minWidths[i], Math.round(rawWidths[i])));

    // 4. Se os boosts causaram estouro, reduz proporcionalmente os segmentos com folga.
    const totalW = widths.reduce((a, b) => a + b, 0);
    if (totalW > TOTAL_W) {
      const excess = totalW - TOTAL_W;
      const slack = widths.map((w, i) => Math.max(0, w - minWidths[i]));
      const totalSlack = slack.reduce((a, b) => a + b, 0);
      if (totalSlack > 0) {
        widths = widths.map((w, i) => Math.round(w - (slack[i] / totalSlack) * excess));
      }
    }

    const barRow = segs.map((s) => ({
      stack: [
          { text: s.label, fontSize: 5.5, bold: true, color: getTxtColor(s), alignment: 'center' as const },
          { text: `${s.overrideDuration ?? `${s.durationMin}min`}${s.subtitle ? ` | ${s.subtitle}` : ''}`, fontSize: 5, bold: true, color: getTxtColor(s), alignment: 'center' as const },
        ],
      fillColor: getFill(s),
    }));

    const LINE_H = 14;
    const mkLineCol = () => ({ canvas: [{ type: 'line', x1: 1, y1: 0, x2: 1, y2: LINE_H, lineWidth: 0.8, lineColor: '#9ca3af' }], width: 2 });
    const mkLeftMarker = (label: string, time: string) => ({
      columns: [mkLineCol(), { text: `${label}\n${time}`, fontSize: 4.5, color: '#6b7280', lineHeight: 1.3 }],
      columnGap: 1,
    });
    const mkRightMarker = (label: string, time: string) => ({
      columns: [{ text: `${label}\n${time}`, fontSize: 4.5, color: '#6b7280', lineHeight: 1.3, alignment: 'right' as const }, mkLineCol()],
      columnGap: 1,
    });

    const timeRow = segs.map((s, i) => {
      const isLast = i === segs.length - 1;
      if (isLast) {
        return {
          columns: [
            { ...mkLeftMarker(s.startLabel ?? '', s.startTime ?? ''), width: 'auto' },
            { width: '*', text: '' },
            { ...mkRightMarker(s.endLabel ?? '', s.endTime ?? ''), width: 'auto' },
          ],
        };
      }
      return mkLeftMarker(s.startLabel ?? '', s.startTime ?? '');
    });

    return {
      table: {
        widths,
        body: [barRow, timeRow],
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: (i: number) => (i > 0 && i < segs.length ? 1 : 0),
        vLineColor: () => '#ffffff',
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 2,
        paddingBottom: () => 2,
      },
      margin: [0, 4, 0, 8],
    };
  }

  /**
   * Filtra o relatório por prefixo de equipe (para gerar PDFs segmentados por base).
   */
  filterReportByTeamPrefix(report: GeneratedReport, prefix: string): GeneratedReport {
    const matches = (team: string): boolean => team.toUpperCase().startsWith(prefix);
    return {
      ...report,
      kpis: report.kpis.map((kpi) => ({
        ...kpi,
        topTeams: kpi.topTeams.filter((t) => matches(t.team)),
        opportunityTeams: kpi.opportunityTeams.filter((t) => matches(t.team)),
        scores: kpi.scores.filter((t) => matches(t.team)),
        evidenceAnalysis: kpi.evidenceAnalysis?.filter((a) => matches(a.team)),
        tmeImpAnalysis: kpi.tmeImpAnalysis?.filter((a) => matches(a.team)),
        primeiroLoginAnalysis: kpi.primeiroLoginAnalysis?.filter((a) => matches(a.team)),
        primeiroDeslocAnalysis: kpi.primeiroDeslocAnalysis?.filter((a) => matches(a.team)),
        retornoBaseAnalysis: kpi.retornoBaseAnalysis?.filter((a) => matches(a.team)),
      })),
      specialAnalysis: {
        ...report.specialAnalysis,
        osDiaAnalysis: report.specialAnalysis.osDiaAnalysis?.filter((a) => matches(a.team)) ?? [],
        utilizacaoAnalysis: report.specialAnalysis.utilizacaoAnalysis?.filter((a) => matches(a.team)) ?? [],
        actionPlan: report.specialAnalysis.actionPlan?.filter((a) => matches(a.team)) ?? [],
      },
      teamScorecard: report.teamScorecard?.filter((r) => matches(r.team)) ?? [],
    };
  }

  /**
   * Renderiza um emoji como Data URL PNG (compatível com pdfmake).
   */
  renderEmojiDataUrl(emoji: string, pxSize: number): string {
    try {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const s = Math.round(pxSize * dpr * 1.6);
      const canvas = document.createElement('canvas');
      canvas.width = s;
      canvas.height = s;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.font = `${Math.round(s * 0.72)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, s / 2, s / 2);
      return canvas.toDataURL('image/png');
    } catch {
      return '';
    }
  }

  /**
   * Renderiza um símbolo Unicode (não-emoji) colorido como PNG para pdfmake.
   */
  renderSymbolDataUrl(symbol: string, pxSize: number, color: string): string {
    try {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const s = Math.round(pxSize * dpr * 1.6);
      const canvas = document.createElement('canvas');
      canvas.width = s;
      canvas.height = s;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.fillStyle = color;
      ctx.font = `bold ${Math.round(s * 0.78)}px "Segoe UI Symbol", "Arial Unicode MS", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(symbol, s / 2, s / 2);
      return canvas.toDataURL('image/png');
    } catch {
      return '';
    }
  }

  /**
   * Remove / substitui emojis que o Roboto não consegue renderizar no pdfmake.
   */
  stripEmojiForPdf(text: string): string {
    return text
      .replace(/\u2705/g, '\u2713')
      .replace(/\u26A0\uFE0F/g, '\u26A0')
      .replace(/\u2191/g, '(+)')
      .replace(/\u2193/g, '(-)')
      .replace(/[\uFE0F]/g, '')
      .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
      .replace(/\u200D/g, '')
      .replace(/ {2,}/g, ' ');
  }

  /**
   * Gera e baixa o PDF usando pdfmake.
   */
  downloadPdf(section: PdfSection, safeName: string, helpers: PdfHelpers, expandedKeys?: Set<string>): void {
    const effectiveSection = { ...section, report: this.injectExpandedOrders(section.report, expandedKeys) };
    const docDef = this.buildPdfDocDef(effectiveSection, helpers);
    pdfMake.createPdf(docDef).download(`${safeName}.pdf`);
  }

  /**
   * Gera o PDF em memória como File (sem baixar automaticamente).
   * pdfmake 0.3.x: getBlob() é async — retorna Promise<Blob>, não usa callback.
   */
  async generatePdfFile(section: PdfSection, safeName: string, helpers: PdfHelpers, expandedKeys?: Set<string>): Promise<File> {
    const effectiveSection = { ...section, report: this.injectExpandedOrders(section.report, expandedKeys) };
    const docDef = this.buildPdfDocDef(effectiveSection, helpers);
    const blob: Blob = await pdfMake.createPdf(docDef).getBlob();
    if (!blob || blob.size === 0) {
      throw new Error('[PdfService] PDF gerado está vazio');
    }
    return new File([blob], `${safeName}.pdf`, { type: 'application/pdf' });
  }

  /**
   * Merges extraFlaggedOrders/extraFlaggedDays into flaggedOrders/flaggedDays
   * for the analysis entries that match the user's expanded date keys.
   * Returns a shallow-cloned report — only the relevant nested arrays are replaced.
   */
  private injectExpandedOrders(report: any, expandedKeys?: Set<string>): any {
    const mergeOrderExtrasAndSort = (analysisList: any[], kpiName: string): any[] =>
      analysisList.map((a: any) => {
        const extras = (a.extraFlaggedOrders ?? []).filter((o: any) => (o.flags?.length ?? 0) > 0);
        if (extras.length === 0) return a;
        
        const merged = [...a.flaggedOrders, ...extras];
        
        if (kpiName === 'OS Dia' || kpiName === 'Utilização') {
          merged.sort((x, y) => {
            const idleX = (x.ocioso_min ?? 0) + (x.temp_prep_os_min ?? 0) + (x.sem_os_total_min ?? 0);
            const idleY = (y.ocioso_min ?? 0) + (y.temp_prep_os_min ?? 0) + (y.sem_os_total_min ?? 0);
            return idleY - idleX;
          });
        } else if (kpiName === 'Eficiência' || kpiName === 'TME IMP') {
          merged.sort((x, y) => (y.tr_ordem_min ?? 0) - (x.tr_ordem_min ?? 0));
        }
        
        return { ...a, flaggedOrders: merged };
      });

    const mergeDayExtras = (analysisList: any[], kpiName: string): any[] =>
      analysisList.map((a: any) => {
        if (expandedKeys?.has(`${kpiName}|${a.team}|__extra__`)) {
          const extras = a.extraFlaggedDays ?? [];
          return extras.length ? { ...a, flaggedDays: [...a.flaggedDays, ...extras] } : a;
        }
        return a;
      });

    return {
      ...report,
      specialAnalysis: {
        ...report.specialAnalysis,
        osDiaAnalysis: mergeOrderExtrasAndSort(report.specialAnalysis?.osDiaAnalysis ?? [], 'OS Dia'),
        utilizacaoAnalysis: mergeOrderExtrasAndSort(report.specialAnalysis?.utilizacaoAnalysis ?? [], 'Utilização'),
      },
      kpis: (report.kpis ?? []).map((kpi: any) => ({
        ...kpi,
        evidenceAnalysis: mergeOrderExtrasAndSort(kpi.evidenceAnalysis ?? [], 'Eficiência'),
        tmeImpAnalysis: mergeOrderExtrasAndSort(kpi.tmeImpAnalysis ?? [], 'TME IMP'),
        primeiroLoginAnalysis: mergeDayExtras(kpi.primeiroLoginAnalysis ?? [], '1\u00ba Login'),
        primeiroDeslocAnalysis: mergeDayExtras(kpi.primeiroDeslocAnalysis ?? [], '1\u00ba Desloc.'),
        retornoBaseAnalysis: mergeDayExtras(kpi.retornoBaseAnalysis ?? [], 'Retorno Base'),
      })),
    };
  }

  /**
   * Constrói a definição completa do documento PDF para pdfmake.
   */
  buildPdfDocDef(section: PdfSection, helpers: PdfHelpers): any {
    const { report, title, subtitle, dateRangeLabel } = section;

    const barPct = (value: number, kpi: ReportKpiInsight): number => {
      const cfg = kpi.chartConfig;
      if (!cfg || !Number.isFinite(value)) return 2;
      const pct = cfg.direction === 'h'
        ? (value - cfg.worst) / (cfg.best - cfg.worst) * 100
        : (cfg.worst - value) / (cfg.worst - cfg.best) * 100;
      return Math.max(2, Math.min(100, pct));
    };

    const metaLinePct = (kpi: ReportKpiInsight): number => {
      const cfg = kpi.chartConfig;
      return cfg ? barPct(cfg.meta, kpi) : 50;
    };

    const isAbove = (kpi: { kpi: string; direction: string; metaTarget: number }, value: number): boolean =>
      kpi.direction === 'higher-is-better' ? value >= kpi.metaTarget : value <= kpi.metaTarget;

    const fmt = (v: number | undefined | null, dec = 1): string =>
      v != null && Number.isFinite(v) ? v.toFixed(dec).replace('.', ',') : '–';

    const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    const es = report.executiveSummary;

    const RED = '#c0122d';
    const BLUE = '#2563eb';
    const GRAY = '#64748b';
    const DARK = '#1e1a17';
    const MUTED = '#94a3b8';
    const BG = '#f8f7f4';

    const th = (text: string): any => ({ text, bold: true, fontSize: 7, color: GRAY, fillColor: BG, alignment: 'center' as const, margin: [2, 3, 2, 3] });
    const td = (text: string, opts: any = {}): any => ({ text, fontSize: 7.5, margin: [2, 3, 2, 3], ...opts });

    // Cover
    const cover: any[] = [
      { text: 'Relatório Analítico de Campo', fontSize: 9, bold: true, color: MUTED, characterSpacing: 2, margin: [0, 0, 0, 10] },
      { text: title, fontSize: 32, bold: true, color: DARK, margin: [0, 0, 0, 6] },
      subtitle ? { text: subtitle, fontSize: 12, color: GRAY, margin: [0, 0, 0, 6] } : null,
      { text: `Gerado em ${today}`, fontSize: 9, color: MUTED, margin: [0, 0, 0, 2] },
      dateRangeLabel ? { text: `Período de referência: ${dateRangeLabel}`, fontSize: 9, color: MUTED, margin: [0, 0, 0, 4] } : null,
      { text: 'Autor: Alysson Pinheiro – Analista de Dados', fontSize: 9, color: MUTED, italics: true, margin: [0, 0, 0, 28] },
    ];

    const content: any[] = [...cover.filter(Boolean)];

    // Executive summary
    if (es) {
      content.push(
        { text: 'Resumo Executivo', style: 'sectionHeader', margin: [0, 0, 0, 10] },
        {
          columns: [
            { stack: [{ text: `${es.totalTeams}`, fontSize: 20, bold: true, color: DARK }, { text: 'Equipes', fontSize: 7, color: MUTED }], alignment: 'center' as const },
            es.periodDays > 0 ? { stack: [{ text: `${es.periodDays}`, fontSize: 20, bold: true, color: DARK }, { text: 'Dias analisados', fontSize: 7, color: MUTED }], alignment: 'center' as const } : {},
            { stack: [{ text: `${es.kpiAlerts.length}`, fontSize: 20, bold: true, color: RED }, { text: 'KPIs em alerta', fontSize: 7, color: MUTED }], alignment: 'center' as const },
            { stack: [{ text: `${es.teamsBelowMetaCount}`, fontSize: 20, bold: true, color: RED }, { text: 'Equipes críticas', fontSize: 7, color: MUTED }], alignment: 'center' as const },
          ],
          columnGap: 12,
          margin: [0, 0, 0, 8],
        },
      );
      if (es.kpiAlerts.length > 0) {
        content.push({ text: 'KPIs em Alerta', bold: true, fontSize: 8, color: GRAY, margin: [0, 0, 0, 6] });
        es.kpiAlerts.forEach((a) => {
          const pct = Math.round((a.teamsBelowMeta / Math.max(es.totalTeams, 1)) * 100);
          content.push({
            columns: [
              { text: a.kpi, bold: true, fontSize: 8, width: 80 },
              {
                stack: [{
                  canvas: [
                    { type: 'rect', x: 0, y: 4, w: 200, h: 6, r: 3, color: '#f0ede8' },
                    { type: 'rect', x: 0, y: 4, w: Math.max(4, pct * 2), h: 6, r: 3, color: RED },
                  ],
                }],
                width: 200,
              },
              { text: `${a.teamsBelowMeta}/${es.totalTeams}`, bold: true, color: RED, fontSize: 7.5, width: 40, alignment: 'right' as const },
              { text: `crítico: ${a.worst.team} (${a.worst.value})`, fontSize: 7, color: GRAY, width: '*' },
            ],
            columnGap: 8,
            margin: [0, 0, 0, 3],
          });
        });
      }
      if (es.topActionIssues.length > 0) {
        const shortLabel = (s: string): string => s.split(':')[0].trim();
        content.push({ text: `Recorrentes: ${es.topActionIssues.map(shortLabel).join(' · ')}`, fontSize: 7.5, color: GRAY, margin: [0, 8, 0, 0] });
      }
      const alertBadges: string[] = [];
      if (es.retornoBaseAlertCount > 0) alertBadges.push(`âš  ${es.retornoBaseAlertCount} equipe(s) com Retorno a Base acima da meta`);
      if (es.tmeImpAlertCount > 0) alertBadges.push(`âš  ${es.tmeImpAlertCount} equipe(s) com TME IMP acima da meta`);
      if (alertBadges.length > 0) {
        content.push({ text: `ALERTAS: ${alertBadges.join('   ')}`, fontSize: 7.5, bold: true, color: RED, margin: [0, 6, 0, 0] });
      }
      content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: '#cbd5e1' }], margin: [0, 16, 0, 0], pageBreak: 'after' });
    }

    // KPI sections
    report.kpis.filter((kpi) => kpi.topTeams.length > 0 || kpi.opportunityTeams.length > 0).forEach((kpi) => {
      const dec = ['OS Dia', 'Eficiência', 'Utilização'].includes(kpi.kpi) ? 1 : 0;
      const dirUp = kpi.direction === 'higher-is-better';
      const suffix = kpi.kpi === 'Eficiência' || kpi.kpi === 'Utilização' ? '%' : '';

      const allTeams: Array<{ team: string; value: number; group: string }> = [
        ...kpi.topTeams.map((t) => ({ ...t, group: 'top' })),
        { team: 'Média geral', value: kpi.average, group: 'avg' },
        ...kpi.opportunityTeams.map((t) => ({ ...t, group: 'opp' })),
      ];

      const kpiChartItems: any[] = [
        { text: kpi.kpi, style: 'sectionHeader', margin: [0, 10, 0, 3] },
        {
          columns: [
            { text: dirUp ? '(+) Maior e melhor' : '(-) Menor e melhor', fontSize: 7.5, bold: true, color: dirUp ? '#15803d' : RED },
            { text: `Meta: ${fmt(kpi.metaTarget, dec)}${suffix}   Media: ${fmt(kpi.average, dec)}${suffix}`, fontSize: 7.5, color: GRAY },
          ],
          margin: [0, 0, 0, 10],
        },
      ];

      let _prevGroup = '';
      allTeams.forEach((t) => {
        if (t.group !== _prevGroup) {
          if (t.group === 'top') {
            const trophyUrl = helpers.renderEmojiDataUrl('\uD83C\uDFC6', 8);
            if (trophyUrl) {
              kpiChartItems.push({
                columns: [
                  { image: trophyUrl, width: 8, height: 8, margin: [0, 0, 4, 0] },
                  { text: 'Top Performers', fontSize: 7.5, bold: true, color: BLUE, width: '*' },
                ],
                margin: [0, 6, 0, 2],
              });
            } else {
              kpiChartItems.push({ text: 'Top Performers', fontSize: 7.5, bold: true, color: BLUE, margin: [0, 6, 0, 2] });
            }
          } else if (t.group === 'opp') {
            const oppWarnUrl = helpers.renderSymbolDataUrl('\u26A0', 8, RED);
            if (oppWarnUrl) {
              kpiChartItems.push({ columns: [{ image: oppWarnUrl, width: 8, height: 8, margin: [0, 0, 4, 0] }, { text: 'Oportunidade', bold: true, fontSize: 7.5, color: RED, width: '*' }], margin: [0, 6, 0, 2] });
            } else {
              kpiChartItems.push({ text: '! Oportunidade', fontSize: 7.5, bold: true, color: RED, margin: [0, 6, 0, 2] });
            }
          }
          _prevGroup = t.group;
        }
        const above = t.group === 'avg' ? null : isAbove(kpi, t.value);
        const pct = barPct(t.value, kpi);
        const mlPct = metaLinePct(kpi);
        const barColor = t.group === 'avg' ? MUTED : (above ? BLUE : RED);
        const valColor = t.group === 'avg' ? GRAY : (above ? BLUE : RED);
        kpiChartItems.push({
          columns: [
            { text: t.team, fontSize: 7.5, bold: t.group !== 'avg', width: 120, color: t.group === 'avg' ? GRAY : DARK },
            {
              stack: [{
                canvas: [
                  { type: 'rect', x: 0, y: 3, w: 280, h: 8, r: 2, color: '#f0ede8' },
                  { type: 'rect', x: 0, y: 3, w: Math.max(2, pct * 2.8), h: 8, r: 2, color: barColor },
                  { type: 'line', x1: mlPct * 2.8, y1: 1, x2: mlPct * 2.8, y2: 13, lineWidth: 1.5, lineColor: '#1e1a17' },
                ],
              }],
              width: 280,
            },
            { text: `${fmt(t.value, dec)}${suffix}`, fontSize: 7.5, bold: true, color: valColor, width: 40, alignment: 'right' as const },
          ],
          columnGap: 8,
          margin: [0, 0, 0, 3],
        });
      });

      if (kpi.opportunityTeams.length === 0) {
        kpiChartItems.push({ text: 'Todas as equipes atingiram a meta esperada.', fontSize: 8, color: '#15803d', italics: true, margin: [0, 6, 0, 0] });
      }

      // Analysis table per KPI
      let analysisTable: any = null;
      if (kpi.kpi === 'OS Dia' && report.specialAnalysis.osDiaAnalysis?.length) {
        analysisTable = {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body: [
              [th('Equipe'), th('OS/Dia'), th('Ordens'), th('Jornadas'), th('Dias ociosos'), th('Ocioso méd.'), th('Temp. Prep.')],
              ...report.specialAnalysis.osDiaAnalysis.map((a) => [
                td(a.team, { bold: true, alignment: 'left' as const }),
                td(fmt(a.osDiaValue), { color: isAbove(kpi, a.osDiaValue) ? BLUE : RED, bold: true }),
                td(`${a.totalOrders}`),
                td(`${a.totalJornadas}`),
                td(`${a.idleDays}`),
                td(a.idleDays > 0 ? `${Math.round(a.idleAvgMin)} min` : '–'),
                td(a.tempPrepTotalMin > 0 ? `${Math.round(a.tempPrepTotalMin)} min` : '–'),
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 10, 0, 0],
        };
      } else if (kpi.kpi === 'Utilização' && report.specialAnalysis.utilizacaoAnalysis?.length) {
        analysisTable = {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body: [
              [th('Equipe'), th('Utilização'), th('Ordens'), th('Jornadas'), th('Abaixo meta'), th('Temp. Prep.'), th('Sem OS')],
              ...report.specialAnalysis.utilizacaoAnalysis.map((a) => [
                td(a.team, { bold: true, alignment: 'left' as const }),
                td(`${fmt(a.utilizacaoValue, 0)}%`, { color: isAbove(kpi, a.utilizacaoValue) ? BLUE : RED, bold: true }),
                td(`${a.totalOrders}`),
                td(`${a.totalJornadas}`),
                td(`${a.jornadasAbaixoMeta}`),
                td(`${Math.round(a.tempPrepTotalMin)} min`),
                td(`${Math.round(a.semOrdemTotalMin)} min`),
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 10, 0, 0],
        };
      } else if (kpi.kpi === 'TME IMP' && report.specialAnalysis.tmeImpAnalysis?.length) {
        analysisTable = {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body: [
              [th('Equipe'), th('TME IMP'), th('Média TME'), th('Média global'), th('Ordens'), th('TME muito alto')],
              ...report.specialAnalysis.tmeImpAnalysis.map((a) => [
                td(a.team, { bold: true, alignment: 'left' as const }),
                td(`${fmt(a.tmeImpValue, 0)} min`, { color: isAbove(kpi, a.tmeImpValue) ? BLUE : RED, bold: true }),
                td(`${fmt(a.avgTmeImpMin, 0)} min`),
                td(`${fmt(a.globalAvgTmeImpMin, 0)} min`),
                td(`${a.totalOrders}`),
                td(`${a.summary.countTmeMuitoAlto}`),
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 10, 0, 0],
        };
      } else if (kpi.kpi === '1º Login' && report.specialAnalysis.primeiroLoginAnalysis?.length) {
        analysisTable = {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body: [
              [th('Equipe'), th('1º Login'), th('Média login'), th('Dias totais'), th('Acima meta'), th('Login tardio')],
              ...report.specialAnalysis.primeiroLoginAnalysis.map((a) => [
                td(a.team, { bold: true, alignment: 'left' as const }),
                td(`${fmt(a.primeiroLoginValue, 0)} min`, { color: isAbove(kpi, a.primeiroLoginValue) ? BLUE : RED, bold: true }),
                td(`${fmt(a.avgLoginMin, 0)} min`),
                td(`${a.totalDays}`),
                td(`${a.diasAcimaMetaCount}`),
                td(`${a.summary.countLoginTardio + a.summary.countLoginMuitoTardio}`),
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 10, 0, 0],
        };
      } else if (kpi.kpi === '1º Desloc.' && report.specialAnalysis.primeiroDeslocAnalysis?.length) {
        analysisTable = {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body: [
              [th('Equipe'), th('1º Desloc.'), th('Média desloc.'), th('Dias totais'), th('Acima meta'), th('Desloc. lento')],
              ...report.specialAnalysis.primeiroDeslocAnalysis.map((a) => [
                td(a.team, { bold: true, alignment: 'left' as const }),
                td(`${fmt(a.primeiroDeslocValue, 0)} min`, { color: isAbove(kpi, a.primeiroDeslocValue) ? BLUE : RED, bold: true }),
                td(`${fmt(a.avgDeslocMin, 0)} min`),
                td(`${a.totalDays}`),
                td(`${a.diasAcimaMetaCount}`),
                td(`${a.summary.countDeslocLento + a.summary.countDeslocMuitoLento}`),
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 10, 0, 0],
        };
      } else if (kpi.kpi === 'Retorno Base' && report.specialAnalysis.retornoBaseAnalysis?.length) {
        analysisTable = {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body: [
              [th('Equipe'), th('Retorno Base'), th('Média retorno'), th('Dias totais'), th('Acima meta'), th('Retorno alto')],
              ...report.specialAnalysis.retornoBaseAnalysis.map((a) => [
                td(a.team, { bold: true, alignment: 'left' as const }),
                td(`${fmt(a.retornoBaseValue, 0)} min`, { color: isAbove(kpi, a.retornoBaseValue) ? BLUE : RED, bold: true }),
                td(`${fmt(a.avgRetornoMin, 0)} min`),
                td(`${a.totalDays}`),
                td(`${a.diasAcimaMetaCount}`),
                td(`${a.summary.countRetornoAlto + a.summary.countRetornoMuitoAlto}`),
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 10, 0, 0],
        };
      }

      if (analysisTable) {
        content.push({ stack: [{ stack: kpiChartItems }, analysisTable], unbreakable: true });
      } else {
        content.push({ stack: kpiChartItems, unbreakable: true });
      }

      // ---- Drill-down helpers ----
      const cardHeader = (team: string, badge: string, badgeRed = true): any => ({
        columns: [
          { text: team, bold: true, fontSize: 9, color: DARK, width: '*' },
          { text: badge, bold: true, fontSize: 8, color: badgeRed ? RED : BLUE, width: 'auto', alignment: 'right' as const },
        ],
        margin: [0, 0, 0, 2],
      });

      const chipRow = (chips: string[]): any => ({
        text: helpers.stripEmojiForPdf(chips.join('  \u00B7  ')),
        fontSize: 7,
        color: GRAY,
        margin: [0, 0, 0, 2],
      });

      const tl = (...steps: string[]): any => ({
        text: steps.flatMap((s, i) =>
          i === 0
            ? [{ text: s, color: GRAY }]
            : [{ text: '  \u2014>  ', color: MUTED }, { text: s, color: GRAY }],
        ),
        fontSize: 7,
        margin: [0, 1, 0, 1],
      });

      const orderHead = (nr_ordem: string, flags: string[], labelFn: (f: string) => string, extra?: string, isPrimeiraOs?: boolean, customFlags: string[] = []): any => {
        const allFlags = [...(flags || []).map(labelFn), ...customFlags];
        return {
          text: [
            { text: `OS ${nr_ordem}${extra ? ' | ' + extra : ''}`, bold: true, fontSize: 7.5, color: DARK },
            { text: '    ', fontSize: 7 },
            ...(isPrimeiraOs ? [{ text: '1\u00aa OS', bold: true, color: BLUE, fontSize: 6.5 }] : []),
            ...allFlags.flatMap((f, i) => [
              ...(i > 0 || isPrimeiraOs ? [{ text: '  |  ', color: MUTED, fontSize: 6.5 }] : []),
              { text: f, bold: true, color: RED, fontSize: 6.5 },
            ]),
          ],
          margin: [0, 6, 0, 2],
        };
      };

      const minRuns = (text: string): any[] => {
        const parts = text.split(/(\d+(?:[.,]\d+)? min\b)/);
        return parts.flatMap((p, i) =>
          p ? [i % 2 === 1 ? { text: p, bold: true, color: RED } : { text: p, color: DARK }] : []
        );
      };

      const alertItem = (text: string): any => {
        const cleaned = helpers.stripEmojiForPdf(text);
        const sep = cleaned.indexOf(': ');
        const label = sep > -1 ? cleaned.slice(0, sep) : cleaned;
        const body = sep > -1 ? cleaned.slice(sep + 2) : '';
        const warnUrl = helpers.renderSymbolDataUrl('\u26A0', 7, RED);
        const labelRuns: any[] = [
          { text: label + (body ? ': ' : ''), bold: true, color: RED },
          ...(body ? minRuns(body) : []),
        ];
        if (warnUrl) {
          return {
            columns: [
              { image: warnUrl, width: 7, height: 7, margin: [0, 0, 3, 0] },
              { text: labelRuns, fontSize: 7, width: '*' },
            ],
            margin: [0, 1, 0, 2],
          };
        }
        return {
          text: [{ text: '! ', bold: true, color: RED }, ...labelRuns],
          fontSize: 7,
          margin: [0, 1, 0, 2],
        };
      };

      const AMBER = '#d97706';
      const AMBER_DARK = '#92400e';
      const alertWarnItem = (text: string): any => {
        const sep = text.indexOf(': ');
        const label = sep > -1 ? text.slice(0, sep) : text;
        const body = sep > -1 ? text.slice(sep + 2) : '';
        const warnUrl = helpers.renderSymbolDataUrl('\u26A0', 7, AMBER);
        const labelRuns: any[] = [
          { text: label + (body ? ': ' : ''), bold: true, color: AMBER_DARK },
          ...(body ? [{ text: body, color: DARK }] : []),
        ];
        if (warnUrl) {
          return {
            columns: [
              { image: warnUrl, width: 7, height: 7, margin: [0, 0, 3, 0] },
              { text: labelRuns, fontSize: 7, width: '*' },
            ],
            margin: [0, 1, 0, 2],
          };
        }
        return {
          text: [{ text: '! ', bold: true, color: AMBER }, ...labelRuns],
          fontSize: 7,
          margin: [0, 1, 0, 2],
        };
      };

      const alertWarnItemRuns = (label: string, bodyRuns: any[]): any => {
        const warnUrl = helpers.renderSymbolDataUrl('\u26A0', 7, AMBER);
        const labelRuns: any[] = [{ text: label + ': ', bold: true, color: AMBER_DARK }, ...bodyRuns];
        if (warnUrl) {
          return {
            columns: [
              { image: warnUrl, width: 7, height: 7, margin: [0, 0, 3, 0] },
              { text: labelRuns, fontSize: 7, width: '*' },
            ],
            margin: [0, 1, 0, 2],
          };
        }
        return {
          text: [{ text: '! ', bold: true, color: AMBER }, ...labelRuns],
          fontSize: 7,
          margin: [0, 1, 0, 2],
        };
      };

      const cardDivider = (): any => ({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: '#cbd5e1' }], margin: [0, 4, 0, 4] });
      const orderDivider = (): any => ({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#e2e8f0' }], margin: [0, 3, 0, 3] });

      const indentBlock = (items: any[], color: string, indent = 8): any => ({
        table: {
          widths: [2, '*'],
          body: items.map((item, index) => [
            { text: '' },
            { stack: [item], margin: [indent, index === 0 ? 2 : 0, 0, index === items.length - 1 ? 2 : 0] },
          ]),
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: (i: number) => (i === 1 ? 2 : 0),
          vLineColor: () => color,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
        margin: [0, 2, 0, 2],
      });

      const drillHead = (text: string, emoji = '\uD83D\uDD0D'): any => {
        const emojiUrl = emoji ? helpers.renderEmojiDataUrl(emoji, 9) : '';
        if (emojiUrl) {
          return {
            columns: [
              { image: emojiUrl, width: 9, height: 9, margin: [0, 0, 4, 0] },
              { text, bold: true, fontSize: 8.5, color: DARK, width: '*' },
            ],
            margin: [0, 8, 0, 4],
            background: BG,
            keepWithNext: true,
          };
        }
        return { text, bold: true, fontSize: 8.5, color: DARK, margin: [0, 8, 0, 4], background: BG, keepWithNext: true };
      };

      // OS Dia drill-down
      if (kpi.kpi === 'OS Dia' && report.specialAnalysis.osDiaAnalysis?.length) {
        const osDiaList = report.specialAnalysis.osDiaAnalysis.filter((a: any) => (a.flaggedOrders?.length ?? 0) > 0 || !!a.idleAnalysis);
        const osDiaDrillHead = osDiaList.length > 0 ? drillHead('Análise Detalhada – OS Dia') : null;
        osDiaList.forEach((analysis: any, analysisIdx: number) => {
          const chips: string[] = [
            `OS/Dia ${fmt(analysis.osDiaValue)}`,
            `Total OS: ${analysis.totalOrders} em ${analysis.totalJornadas} dias`,
          ];
          if (analysis.idleDays > 0) chips.push(`Ocioso: ${analysis.idleDays} dias`);
          if (analysis.summary?.countTrExceeds > 0) chips.push(`Temp. Reparo>20% HD: ${analysis.summary.countTrExceeds}`);
          if (analysis.summary?.countTlExceeds > 0) chips.push(`Temp. Desloc.: ${analysis.summary.countTlExceeds}`);
          if (analysis.summary?.countTempPrepAlto > 0) chips.push(`Temp. Partida\u226510min: ${analysis.summary.countTempPrepAlto}`);
          if (analysis.summary?.countSemOsAlto > 0) chips.push(`SemOS\u226510min: ${analysis.summary.countSemOsAlto}`);
          const teamItems: any[] = [chipRow(chips)];
          if (analysis.idleAnalysis) {
            const idleWarnUrl1 = helpers.renderSymbolDataUrl('\u26A0', 8, RED);
            const idleText1 = `Ociosidade elevada \u2014 ${analysis.idleAnalysis.idlePct?.toFixed(1)}% da jornada sem trabalho registrado`;
            if (idleWarnUrl1) {
              teamItems.push({ columns: [{ image: idleWarnUrl1, width: 8, height: 8, margin: [0, 0, 4, 0] }, { text: idleText1, bold: true, fontSize: 7.5, color: RED, width: '*' }], margin: [0, 2, 0, 2] });
            } else {
              teamItems.push({ text: `! ${idleText1}`, fontSize: 7.5, bold: true, color: RED, margin: [0, 2, 0, 2] });
            }
            teamItems.push(chipRow([
              `HD Médio/dia: ${Math.round(analysis.hdTotalMin)} min`,
              `Temp. Partida Médio/dia: ${Math.round(analysis.tempPrepTotalMin)} min`,
              `SemOrdem Médio/dia: ${Math.round(analysis.semOrdemTotalMin)} min`,
              `Ocioso Médio/dia: ${Math.round(analysis.idleAnalysis.idleMin)} min (${analysis.idleAnalysis.idlePct?.toFixed(1)}%) – limite: 10%`,
              ...(analysis.idleAnalysis.horasExtras > 0 ? [`Horas Extras Méd/dia: ${Math.round(analysis.idleAnalysis.horasExtras)} min`] : []),
            ]));
          }
          if (analysis.flaggedOrders?.length > 0) {
            analysis.flaggedOrders.forEach((ev: any, evIdx: number, evArr: any[]) => {
              const orderItems: any[] = [];
              const ccParts: string[] = [];
              if (ev.classe) ccParts.push(`Classe: ${ev.classe}`);
              if (ev.classe && ev.causa) ccParts.push('  \u00b7  ');
              if (ev.causa) ccParts.push(`Causa: ${ev.causa}`);
              const _osDiaDesp = ev.despachada || ev.hora_primeiro_despacho;
              if (_osDiaDesp && ev.prev_liberada) {
                const _osPrevTs = parseDt(ev.prev_liberada), _osDespTs = parseDt(_osDiaDesp);
                if (_osPrevTs > 0 && _osDespTs > 0 && _osPrevTs > _osDespTs) {
                  if (ccParts.length > 0) ccParts.push('  \u00b7  ');
                  ccParts.push(`Desp.: ${extractTime(_osDiaDesp)}`);
                }
              }
              if (ccParts.length > 0) orderItems.push({ text: ccParts.join(''), fontSize: 7, color: GRAY, margin: [0, 0, 0, 2] });
              const osDiaTl = this.buildTimelinePdfBlock(ev);
              if (osDiaTl) orderItems.push(osDiaTl);
              if (ev.flags?.includes('tr_excede_hd')) orderItems.push(alertItem(`Tempo de Reparo alto: ${helpers.osDiaAlertBody('tr_excede_hd', ev)}`));
              if (ev.flags?.includes('tl_excede_hd')) orderItems.push(alertItem(`Tempo de Deslocamento alto: ${helpers.osDiaAlertBody('tl_excede_hd', ev)}`));
              if (ev.flags?.includes('temp_prep_alto')) orderItems.push(alertItem(`Tempo de Partida/OS: ${helpers.osDiaAlertBody('temp_prep_alto', ev)}`));
              if (ev.flags?.includes('triagem_alto')) orderItems.push(alertItem(`Desp. Prioritário: ${helpers.osDiaAlertBody('triagem_alto', ev)}`));
              if (ev.flags?.includes('primeiro_desloc_alto')) orderItems.push(alertItem(`1º Desloc.: ${helpers.osDiaAlertBody('primeiro_desloc_alto', ev)}`));
              if (ev.flags?.includes('sem_os_alto') && ev.sem_os_details?.length) {
                orderItems.push(alertItem(`Sem Ordem/OS: ${helpers.osDiaAlertBody('sem_os_alto', ev)}`));
                (ev.sem_os_details as any[]).filter((d: any) => d.type !== 'fim_jornada').forEach((d: any, di: number) => {
                  const semLabel = helpers.semOsDetailLabel(d, ev.nr_ordem_despacho_anterior);
                  const semBody = helpers.semOsDetailBody(d, ev.nr_ordem_despacho_anterior);
                  orderItems.push({ text: [{ text: `${di + 1}. `, color: RED, bold: true, italics: true }, { text: semLabel, color: RED, italics: true }, ...(semBody ? [{ text: ': ', color: DARK }, ...minRuns(semBody)] : [])], fontSize: 6.5, margin: [10, 0, 0, 1] });
                });
              }
              if (ev.nr_ordem_despacho_anterior) {
                const horaFmt = (ev.hora_despacho_anterior || '').replace(/^(\d{2}\/\d{2})\/\d{4}\s+(\d{2}:\d{2}).*$/, '$1 $2');
                orderItems.push(alertWarnItemRuns('Despacho anterior da 1ªOS', [
                  { text: 'a OS ', color: DARK },
                  { text: ev.nr_ordem_despacho_anterior, bold: true, color: AMBER_DARK },
                  { text: `${horaFmt ? ' foi despachada em ' + horaFmt : ''} antes do deslocamento da 1ª OS desta equipe, provavelmente por motivo de prioridade, dessa forma o despacho da 1ªOS pode ficar elevado.`, color: DARK },
                ]));
              }
              if (ev.flags?.includes('antes_log_off_alto')) {
                const fjDetail = (ev.sem_os_details as any[] | undefined)?.find((d: any) => d.type === 'fim_jornada');
                if (fjDetail) {
                  const fjBody = helpers.semOsDetailBody(fjDetail, ev.nr_ordem_despacho_anterior);
                  orderItems.push(alertWarnItem(`Antes Log Off: ${fjBody}`));
                }
              }
              const customFlags: string[] = [];
              if (ev.sem_os_details?.find((d: any) => d.type === 'entre_os' && d.interval_discounted && d.min >= 10)) {
                customFlags.push('Entre OS\u226510min');
              }
              if (ev.ocioso_min != null) {
                customFlags.push(`Ocioso: ${Math.round(ev.ocioso_min)} min`);
              }
              const orderBlock: any[] = [orderHead(ev.nr_ordem, ev.flags ?? [], (f) => helpers.osDiaFlagLabel(f), ev.date_ref || undefined, !ev.prev_liberada, customFlags)];
              if (orderItems.length > 0) orderBlock.push(indentBlock(orderItems, '#94a3b8', 6));
              teamItems.push({ stack: orderBlock, unbreakable: true });
              if (evIdx < evArr.length - 1) teamItems.push(orderDivider());
            });
          }
          const osDiaBarColor = isAbove(kpi, analysis.osDiaValue) ? BLUE : RED;
          const osDiaHdr = cardHeader(analysis.team, `${fmt(analysis.osDiaValue)} OS/Dia`, !isAbove(kpi, analysis.osDiaValue));
          const osDiaBlock = indentBlock(teamItems, osDiaBarColor, 8);
          if (analysisIdx === 0 && osDiaDrillHead) {
            content.push({ stack: [osDiaDrillHead, osDiaHdr, osDiaBlock] });
          } else {
            content.push({ stack: [cardDivider(), osDiaHdr, osDiaBlock] });
          }
        });
      }

      // Eficiência drill-down
      if (kpi.kpi === 'Eficiência' && kpi.evidenceAnalysis?.length) {
        const efList = kpi.evidenceAnalysis.filter((a: any) => (a.flaggedOrders?.length ?? 0) > 0 || (a.summary?.countTempoPadraoVazio ?? 0) > 0);
        const efDrillHead = efList.length > 0 ? drillHead('Análise Detalhada – Eficiência (Top 3 e 3 Abaixo do Padrão)') : null;
        efList.forEach((analysis: any, analysisIdx: number) => {
          const isTop = analysis.analysisType === 'top_performer';
          const teamBarColor = isTop ? BLUE : RED;
          const chips: string[] = [
            `Média ${analysis.averageEficiencia}%`,
            `TL Médio: ${analysis.avgDeslocamentoMin?.toFixed(1)} min`,
            `TR Médio: ${analysis.avgExecucaoMin?.toFixed(1)} min`,
          ];
          if (analysis.avgTempoPadraoMin > 0) chips.push(`T. Padrão Médio: ${analysis.avgTempoPadraoMin?.toFixed(1)} min`);
          if (analysis.summary?.countDeslocamentoCurto > 0) chips.push(`TL Curto: ${analysis.summary.countDeslocamentoCurto}`);
          const teamItems: any[] = [chipRow(chips)];
          if (analysis.flags?.length > 0) {
            teamItems.push(chipRow([
              `TL Global: ${analysis.globalAvgDeslocamentoMin?.toFixed(1)} min`,
              `TR Global: ${analysis.globalAvgExecucaoMin?.toFixed(1)} min`,
              ...(analysis.flags.includes('short_displacement') ? [`TL curto: ${analysis.avgDeslocamentoMin?.toFixed(1)} min (\u2264 ${(analysis.globalAvgDeslocamentoMin * 0.25)?.toFixed(1)} min – 25% global)`] : []),
            ]));
          }
          analysis.flaggedOrders?.forEach((ev: any, evIdx: number, evArr: any[]) => {
            const orderItems: any[] = [];
            const efCcParts: string[] = [];
            if (ev.classe) efCcParts.push(`Classe: ${ev.classe}`);
            if (ev.classe && ev.causa) efCcParts.push('  \u00b7  ');
            if (ev.causa) efCcParts.push(`Causa: ${ev.causa}`);
            const _efDesp = ev.despachada || ev.hora_primeiro_despacho;
            if (_efDesp && ev.prev_liberada) {
              const _efPrevTs = parseDt(ev.prev_liberada), _efDespTs = parseDt(_efDesp);
              if (_efPrevTs > 0 && _efDespTs > 0 && _efPrevTs > _efDespTs) {
                if (efCcParts.length > 0) efCcParts.push('  \u00b7  ');
                efCcParts.push(`Desp.: ${extractTime(_efDesp)}`);
              }
            }
            if (efCcParts.length > 0) orderItems.push({ text: efCcParts.join(''), fontSize: 7, color: GRAY, margin: [0, 0, 0, 2] });
            const efTl = this.buildTimelinePdfBlock(ev, true, true);
            if (efTl) orderItems.push(efTl);
            if (ev.flags?.includes('tr_muito_baixo')) orderItems.push(alertItem(`Tempo de Reparo muito baixo: ${helpers.eficienciaAlertBody('tr_muito_baixo', ev)}`));
            if (ev.flags?.includes('deslocamento_curto')) orderItems.push(alertItem(`Deslocamento (TL) muito curto: ${helpers.eficienciaAlertBody('deslocamento_curto', ev)}`));
            if (ev.flags?.includes('tr_excede_hd')) orderItems.push(alertItem(`Tempo de Reparo alto: ${helpers.eficienciaAlertBody('tr_excede_hd', ev)}`));
            if (ev.flags?.includes('tempo_padrao_vazio')) orderItems.push(alertItem(`Tempo Padrão ausente: ${helpers.eficienciaAlertBody('tempo_padrao_vazio', ev)}`));
            const orderBlock: any[] = [orderHead(ev.nr_ordem, ev.flags ?? [], (f) => helpers.eficienciaFlagLabel(f), ev.date_ref || undefined, !ev.prev_liberada)];
            if (orderItems.length > 0) orderBlock.push(indentBlock(orderItems, '#94a3b8', 6));
            teamItems.push({ stack: orderBlock, unbreakable: true });
            if (evIdx < evArr.length - 1) teamItems.push(orderDivider());
          });
          if (analysis.summary?.countTempoPadraoVazio > 0) {
            teamItems.push({ text: `Equipe penalizada por ausência de Tempo Padrão: ${analysis.summary.countTempoPadraoVazio} ordem(ns) sem tempo padrão.${analysis.simulatedEficiencia != null ? ` Simulação com TR médio global: ${analysis.simulatedEficiencia?.toFixed(1)}% vs. atual ${analysis.eficienciaValue}%.` : ''}`, fontSize: 7, color: RED, margin: [0, 3, 0, 2] });
          }
          const efHdr = cardHeader(analysis.team, `${analysis.eficienciaValue}% efic.`, !isTop);
          const efBlock = indentBlock(teamItems, teamBarColor, 8);
          if (analysisIdx === 0 && efDrillHead) {
            content.push({ stack: [efDrillHead, efHdr, efBlock] });
          } else {
            content.push({ stack: [cardDivider(), efHdr, efBlock] });
          }
        });
      }

      // Utilização drill-down
      if (kpi.kpi === 'Utilização' && report.specialAnalysis.utilizacaoAnalysis?.length) {
        const utilList = report.specialAnalysis.utilizacaoAnalysis.filter((a: any) => (a.flaggedOrders?.length ?? 0) > 0 || !!a.idleAnalysis);
        const utilDrillHead = utilList.length > 0 ? drillHead('Análise Detalhada – Utilização (3 Abaixo do Padrão)') : null;
        utilList.forEach((analysis: any, analysisIdx: number) => {
          const chips: string[] = [
            `Utilização: ${analysis.utilizacaoValue}%`,
            `Meta: ${analysis.metaTarget}%`,
            `Total OS: ${analysis.totalOrders} em ${analysis.totalJornadas} dias`,
          ];
          if (analysis.jornadasAbaixoMeta > 0) chips.push(`Jornadas < meta: ${analysis.jornadasAbaixoMeta}/${analysis.totalJornadas}`);
          if (analysis.idleDays > 0) chips.push(`Ocioso: ${analysis.idleDays} dias`);
          if (analysis.summary?.countTempPrepAlto > 0) chips.push(`Temp. Partida\u226510min: ${analysis.summary.countTempPrepAlto}`);
          if (analysis.summary?.countSemOsAlto > 0) chips.push(`SemOS\u226510min: ${analysis.summary.countSemOsAlto}`);
          const teamItems: any[] = [chipRow(chips)];
          if (analysis.idleAnalysis) {
            const idleWarnUrl2 = helpers.renderSymbolDataUrl('\u26A0', 8, RED);
            const idleText2 = `Ociosidade elevada \u2014 ${analysis.idleAnalysis.idlePct?.toFixed(1)}% da jornada sem trabalho registrado`;
            if (idleWarnUrl2) {
              teamItems.push({ columns: [{ image: idleWarnUrl2, width: 8, height: 8, margin: [0, 0, 4, 0] }, { text: idleText2, bold: true, fontSize: 7.5, color: RED, width: '*' }], margin: [0, 2, 0, 2] });
            } else {
              teamItems.push({ text: `! ${idleText2}`, fontSize: 7.5, bold: true, color: RED, margin: [0, 2, 0, 2] });
            }
            teamItems.push(chipRow([
              `HD Médio/dia: ${Math.round(analysis.hdTotalMin)} min`,
              `Temp. Partida Médio/dia: ${Math.round(analysis.tempPrepTotalMin)} min`,
              `SemOrdem Médio/dia: ${Math.round(analysis.semOrdemTotalMin)} min`,
              `Ocioso Médio/dia: ${Math.round(analysis.idleAnalysis.idleMin)} min (${analysis.idleAnalysis.idlePct?.toFixed(1)}%) – limite: 10%`,
              ...(analysis.idleAnalysis.horasExtras > 0 ? [`Horas Extras Méd/dia: ${Math.round(analysis.idleAnalysis.horasExtras)} min`] : []),
            ]));
          }
          analysis.flaggedOrders?.forEach((ev: any, evIdx: number, evArr: any[]) => {
            const orderItems: any[] = [];
            const utilCcParts: string[] = [];
            if (ev.classe) utilCcParts.push(`Classe: ${ev.classe}`);
            if (ev.classe && ev.causa) utilCcParts.push('  \u00b7  ');
            if (ev.causa) utilCcParts.push(`Causa: ${ev.causa}`);
            const _utilDesp = ev.despachada || ev.hora_primeiro_despacho;
            if (_utilDesp && ev.prev_liberada) {
              const _utilPrevTs = parseDt(ev.prev_liberada), _utilDespTs = parseDt(_utilDesp);
              if (_utilPrevTs > 0 && _utilDespTs > 0 && _utilPrevTs > _utilDespTs) {
                if (utilCcParts.length > 0) utilCcParts.push('  \u00b7  ');
                utilCcParts.push(`Desp.: ${extractTime(_utilDesp)}`);
              }
            }
            if (utilCcParts.length > 0) orderItems.push({ text: utilCcParts.join(''), fontSize: 7, color: GRAY, margin: [0, 0, 0, 2] });
            const utilTl = this.buildTimelinePdfBlock(ev);
            if (utilTl) orderItems.push(utilTl);
            if (ev.flags?.includes('tr_excede_hd')) orderItems.push(alertItem(`Tempo de Reparo alto: ${helpers.osDiaAlertBody('tr_excede_hd', ev)}`));
            if (ev.flags?.includes('temp_prep_alto')) orderItems.push(alertItem(`Tempo de Partida/OS: ${helpers.osDiaAlertBody('temp_prep_alto', ev)}`));
            if (ev.flags?.includes('triagem_alto')) orderItems.push(alertItem(`Desp. Prioritário: ${helpers.osDiaAlertBody('triagem_alto', ev)}`));
            if (ev.flags?.includes('primeiro_desloc_alto')) orderItems.push(alertItem(`1º Desloc.: ${helpers.osDiaAlertBody('primeiro_desloc_alto', ev)}`));
            if (ev.flags?.includes('sem_os_alto') && ev.sem_os_details?.length) {
              orderItems.push(alertItem(`Sem Ordem/OS: ${helpers.osDiaAlertBody('sem_os_alto', ev)}`));
              (ev.sem_os_details as any[]).filter((d: any) => d.type !== 'fim_jornada').forEach((d: any, di: number) => {
                const semLabel = helpers.semOsDetailLabel(d, ev.nr_ordem_despacho_anterior);
                const semBody = helpers.semOsDetailBody(d, ev.nr_ordem_despacho_anterior);
                orderItems.push({ text: [{ text: `${di + 1}. `, color: RED, bold: true, italics: true }, { text: semLabel, color: RED, italics: true }, ...(semBody ? [{ text: ': ', color: DARK }, ...minRuns(semBody)] : [])], fontSize: 6.5, margin: [10, 0, 0, 1] });
              });
            }
            if (ev.nr_ordem_despacho_anterior) {
              const obsHoraFmt = (ev.hora_despacho_anterior || '').replace(/^(\d{2}\/\d{2})\/\d{4}\s+(\d{2}:\d{2}).*$/, '$1 $2');
              orderItems.push(alertWarnItemRuns('Despacho anterior da 1ªOS', [
                { text: 'a OS ', color: DARK },
                { text: ev.nr_ordem_despacho_anterior, bold: true, color: AMBER_DARK },
                { text: `${obsHoraFmt ? ' foi despachada em ' + obsHoraFmt : ''} antes do deslocamento da 1ª OS desta equipe, provavelmente por motivo de prioridade, dessa forma o despacho da 1ªOS pode ficar elevado.`, color: DARK },
              ]));
            }
            if (ev.flags?.includes('antes_log_off_alto')) {
              const fjDetail = (ev.sem_os_details as any[] | undefined)?.find((d: any) => d.type === 'fim_jornada');
              if (fjDetail) {
                const fjBody = helpers.semOsDetailBody(fjDetail, ev.nr_ordem_despacho_anterior);
                orderItems.push(alertWarnItem(`Antes Log Off: ${fjBody}`));
              }
            }
            const customFlags: string[] = [];
            if (ev.sem_os_details?.find((d: any) => d.type === 'entre_os' && d.interval_discounted && d.min >= 10)) {
              customFlags.push('Entre OS\u226510min');
            }
            if (ev.ocioso_min != null) {
              customFlags.push(`Ocioso: ${Math.round(ev.ocioso_min)} min`);
            }
            const orderBlock: any[] = [orderHead(ev.nr_ordem, ev.flags ?? [], (f) => helpers.osDiaFlagLabel(f), ev.date_ref || undefined, !ev.prev_liberada, customFlags)];
            if (orderItems.length > 0) orderBlock.push(indentBlock(orderItems, '#94a3b8', 6));
            teamItems.push({ stack: orderBlock, unbreakable: true });
            if (evIdx < evArr.length - 1) teamItems.push(orderDivider());
          });
          const utilizacaoBarColor = (analysis.utilizacaoValue ?? 0) >= (analysis.metaTarget ?? 0) ? BLUE : RED;
          const utilHdr = cardHeader(analysis.team, `Gap ${analysis.gap?.toFixed(1)}%`, true);
          const utilBlock = indentBlock(teamItems, utilizacaoBarColor, 8);
          if (analysisIdx === 0 && utilDrillHead) {
            content.push({ stack: [utilDrillHead, utilHdr, utilBlock] });
          } else {
            content.push({ stack: [cardDivider(), utilHdr, utilBlock] });
          }
        });
      }

      // TME IMP drill-down
      if (kpi.kpi === 'TME IMP' && kpi.tmeImpAnalysis?.length) {
        const tmeList = kpi.tmeImpAnalysis.filter((a: any) => (a.flaggedOrders?.length ?? 0) > 0);
        const tmeDrillHead = tmeList.length > 0 ? drillHead('Análise Detalhada – TME IMP (Ordens com TME Elevado)') : null;
        tmeList.forEach((analysis: any, analysisIdx: number) => {
          const chips: string[] = [
            `TME IMP: ${analysis.tmeImpValue?.toFixed(1)} min`,
            `Meta: ${analysis.metaTarget} min`,
            `Média equipe: ${analysis.avgTmeImpMin?.toFixed(1)} min`,
            `Média global: ${analysis.globalAvgTmeImpMin?.toFixed(1)} min`,
            `Total OS: ${analysis.totalOrders}`,
          ];
          if (analysis.summary?.countTmeMuitoAlto > 0) chips.push(`TME\u22651.5\u00d7avg: ${analysis.summary.countTmeMuitoAlto}`);
          if (analysis.summary?.countSemDeslocamento > 0) chips.push(`Sem desloc.: ${analysis.summary.countSemDeslocamento}`);
          const teamItems: any[] = [chipRow(chips)];
          analysis.flaggedOrders?.forEach((ev: any, evIdx: number, evArr: any[]) => {
            const orderItems: any[] = [];
            if (ev.classe || ev.causa) {
              orderItems.push({ text: [ev.classe ? `Classe: ${ev.classe}` : '', ev.classe && ev.causa ? '  \u00b7  ' : '', ev.causa ? `Causa: ${ev.causa}` : ''].join(''), fontSize: 7, color: GRAY, margin: [0, 0, 0, 2] });
            }
            if (ev.prev_liberada) {
              orderItems.push(tl('OS Anterior', `Lib.: ${ev.prev_liberada}`));
            }
            orderItems.push(tl('OS Atual', `Despachada: ${ev.despachada || '\u2014'}`, `A Caminho: ${ev.a_caminho || '\u2014'}`, `No Local: ${ev.no_local || '\u2014'}`, `Liberada: ${ev.liberada || '\u2014'}`));
            if (ev.flags?.includes('tme_muito_alto')) orderItems.push(alertItem(`TME IMP elevado: ${helpers.tmeImpAlertBody('tme_muito_alto', ev)}`));
            if (ev.flags?.includes('sem_deslocamento')) orderItems.push(alertItem(`Sem registro de deslocamento: ${helpers.tmeImpAlertBody('sem_deslocamento', ev)}`));
            if (ev.flags?.includes('sem_execucao')) orderItems.push(alertItem(`Sem TR Ordem: ${helpers.tmeImpAlertBody('sem_execucao', ev)}`));
            const orderBlock: any[] = [orderHead(ev.nr_ordem, ev.flags ?? [], (f) => helpers.tmeImpFlagLabel(f), ev.date_ref || undefined)];
            if (orderItems.length > 0) orderBlock.push(indentBlock(orderItems, '#94a3b8', 6));
            teamItems.push({ stack: orderBlock, unbreakable: true });
            if (evIdx < evArr.length - 1) teamItems.push(orderDivider());
          });
          const tmeBarColor = (analysis.gap ?? 1) <= 0 ? BLUE : RED;
          const tmeHdr = cardHeader(analysis.team, `${analysis.gap > 0 ? '+' : ''}${analysis.gap?.toFixed(1)} min s/meta`, true);
          const tmeBlock = indentBlock(teamItems, tmeBarColor, 8);
          if (analysisIdx === 0 && tmeDrillHead) {
            content.push({ stack: [tmeDrillHead, tmeHdr, tmeBlock] });
          } else {
            content.push({ stack: [cardDivider(), tmeHdr, tmeBlock] });
          }
        });
      }

      // 1º Login drill-down
      if (kpi.kpi === '1º Login' && kpi.primeiroLoginAnalysis?.length) {
        const loginList = kpi.primeiroLoginAnalysis.filter((a: any) => (a.flaggedDays?.length ?? 0) > 0);
        const loginDrillHead = loginList.length > 0 ? drillHead('Análise Detalhada – 1º Login (Dias Acima da Meta)') : null;
        loginList.forEach((analysis: any, analysisIdx: number) => {
          const chips: string[] = [
            `1\u00ba Login: ${analysis.primeiroLoginValue?.toFixed(1)} min`,
            `Meta: ${analysis.metaTarget} min`,
            `Média equipe: ${analysis.avgLoginMin?.toFixed(1)} min`,
            `Média global: ${analysis.globalAvgLoginMin?.toFixed(1)} min`,
            `Dias com atraso: ${analysis.diasAcimaMetaCount}/${analysis.totalDays}`,
          ];
          if (analysis.summary?.countLoginMuitoTardio > 0) chips.push(`Login>16min: ${analysis.summary.countLoginMuitoTardio}`);
          const teamItems: any[] = [chipRow(chips)];
          analysis.flaggedDays?.forEach((ev: any, evIdx: number, evArr: any[]) => {
            const dayItems: any[] = [];
            dayItems.push(tl('Inicio Cal.', ev.inicio_calendario || '\u2014', `Log In: ${ev.log_in_corrigido || '\u2014'}`));
            if (ev.flags?.includes('login_muito_tardio')) dayItems.push(alertItem(`Login muito tardio: ${helpers.loginAlertBody('login_muito_tardio', ev)}`));
            else if (ev.flags?.includes('login_tardio')) dayItems.push(alertItem(`Login tardio: ${helpers.loginAlertBody('login_tardio', ev)}`));
            teamItems.push({ stack: [
              {
                text: [
                  { text: ev.date_ref || '\u2014', bold: true, fontSize: 7.5, color: DARK },
                  { text: '    ' },
                  ...((ev.flags ?? []).flatMap((f: string, i: number) => [
                    ...(i > 0 ? [{ text: '  |  ', color: MUTED, fontSize: 6.5 }] : []),
                    { text: helpers.loginFlagLabel(f), bold: true, color: RED, fontSize: 6.5 },
                  ])),
                ],
                margin: [0, 6, 0, 2],
              },
              indentBlock(dayItems, '#94a3b8', 6),
            ], unbreakable: true });
            if (evIdx < evArr.length - 1) teamItems.push(orderDivider());
          });
          const loginBarColor = (analysis.gap ?? 1) <= 0 ? BLUE : RED;
          const loginHdr = cardHeader(analysis.team, `${analysis.gap > 0 ? '+' : ''}${analysis.gap?.toFixed(1)} min s/meta`, true);
          const loginBlock = indentBlock(teamItems, loginBarColor, 8);
          if (analysisIdx === 0 && loginDrillHead) {
            content.push({ stack: [loginDrillHead, loginHdr, loginBlock] });
          } else {
            content.push({ stack: [cardDivider(), loginHdr, loginBlock] });
          }
        });
      }

      // 1º Desloc. drill-down
      if (kpi.kpi === '1º Desloc.' && kpi.primeiroDeslocAnalysis?.length) {
        const deslocList = kpi.primeiroDeslocAnalysis.filter((a: any) => (a.flaggedDays?.length ?? 0) > 0);
        const deslocDrillHead = deslocList.length > 0 ? drillHead('Análise Detalhada – 1º Desloc. (Dias Acima da Meta)') : null;
        deslocList.forEach((analysis: any, analysisIdx: number) => {
          const chips: string[] = [
            `1\u00ba Desloc.: ${analysis.primeiroDeslocValue?.toFixed(1)} min`,
            `Meta: ${analysis.metaTarget} min`,
            `Média equipe: ${analysis.avgDeslocMin?.toFixed(1)} min`,
            `Média global: ${analysis.globalAvgDeslocMin?.toFixed(1)} min`,
            `Dias c/ atraso: ${analysis.diasAcimaMetaCount}/${analysis.totalDays}`,
          ];
          if (analysis.summary?.countDeslocMuitoLento > 0) chips.push(`Desloc.>37min: ${analysis.summary.countDeslocMuitoLento}`);
          if (analysis.summary?.countSemDeslocRegistrado > 0) chips.push(`Sem registro: ${analysis.summary.countSemDeslocRegistrado}`);
          if (analysis.summary?.countDespachioTardio > 0) chips.push(`Despacho tardio: ${analysis.summary.countDespachioTardio}`);
          const teamItems: any[] = [chipRow(chips)];
          analysis.flaggedDays?.forEach((ev: any, evIdx: number, evArr: any[]) => {
            const dayItems: any[] = [];
            const deslocTl = this.buildTimelinePdfBlock(ev);
            if (deslocTl) dayItems.push(deslocTl);
            if (ev.flags?.includes('despacho_tardio')) dayItems.push(alertItem(`Despacho tardio: ${helpers.deslocAlertBody('despacho_tardio', ev)}`));
            if (ev.flags?.includes('desloc_muito_lento')) dayItems.push(alertItem(`1º Desloc.: ${helpers.deslocAlertBody('desloc_muito_lento', ev)}`));
            else if (ev.flags?.includes('desloc_lento')) dayItems.push(alertItem(`1º Desloc.: ${helpers.deslocAlertBody('desloc_lento', ev)}`));
            if (ev.flags?.includes('triagem_alto')) dayItems.push(alertItem(`Desp. Prioritário: ${helpers.deslocAlertBody('triagem_alto', ev)}`));
            if (ev.flags?.includes('sem_desloc_registrado')) dayItems.push(alertItem(`Sem deslocamento registrado: ${helpers.deslocAlertBody('sem_desloc_registrado', ev)}`));
            if (ev.nr_ordem_despacho_anterior) {
              const horaFmt = (ev.hora_despacho_anterior || '').replace(/^(\d{2}\/\d{2})\/\d{4}\s+(\d{2}:\d{2}).*$/, '$1 $2');
              dayItems.push(alertWarnItemRuns('Despacho anterior da 1ªOS', [
                { text: 'a OS ', color: DARK },
                { text: ev.nr_ordem_despacho_anterior, bold: true, color: AMBER_DARK },
                { text: `${horaFmt ? ' foi despachada em ' + horaFmt : ''} antes do deslocamento da 1ª OS desta equipe, provavelmente por motivo de prioridade, dessa forma o despacho da 1ªOS pode ficar elevado.`, color: DARK },
              ]));
            }
            teamItems.push({ stack: [
              {
                text: [
                  { text: `${ev.date_ref || '\u2014'}${ev.nr_ordem ? '  \u00b7  OS ' + ev.nr_ordem : ''}${ev.is_primeira_os_jornada ? '  \u00b7  1\u00aa OS' : ''}`, bold: true, fontSize: 7.5, color: DARK },
                  { text: '    ' },
                  ...((ev.flags ?? []).flatMap((f: string, i: number) => [
                    ...(i > 0 ? [{ text: '  |  ', color: MUTED, fontSize: 6.5 }] : []),
                    { text: helpers.deslocFlagLabel(f), bold: true, color: RED, fontSize: 6.5 },
                  ])),
                ],
                margin: [0, 6, 0, 2],
              },
              indentBlock(dayItems, '#94a3b8', 6),
            ], unbreakable: true });
            if (evIdx < evArr.length - 1) teamItems.push(orderDivider());
          });
          const deslocBarColor = (analysis.gap ?? 1) <= 0 ? BLUE : RED;
          const deslocHdr = cardHeader(analysis.team, `${analysis.gap > 0 ? '+' : ''}${analysis.gap?.toFixed(1)} min s/meta`, true);
          const deslocBlock = indentBlock(teamItems, deslocBarColor, 8);
          if (analysisIdx === 0 && deslocDrillHead) {
            content.push({ stack: [deslocDrillHead, deslocHdr, deslocBlock] });
          } else {
            content.push({ stack: [cardDivider(), deslocHdr, deslocBlock] });
          }
        });
      }

      // Retorno Base drill-down
      if (kpi.kpi === 'Retorno Base' && kpi.retornoBaseAnalysis?.length) {
        const retornoList = kpi.retornoBaseAnalysis.filter((a: any) => (a.flaggedDays?.length ?? 0) > 0);
        const retornoDrillHead = retornoList.length > 0 ? drillHead('Análise Detalhada – Retorno Base (Dias Acima da Meta)') : null;
        retornoList.forEach((analysis: any, analysisIdx: number) => {
          const chips: string[] = [
            `Retorno Base: ${analysis.retornoBaseValue?.toFixed(1)} min`,
            `Meta: ${analysis.metaTarget} min`,
            `Média equipe: ${analysis.avgRetornoMin?.toFixed(1)} min`,
            `Média global: ${analysis.globalAvgRetornoMin?.toFixed(1)} min`,
            `Dias c/ atraso: ${analysis.diasAcimaMetaCount}/${analysis.totalDays}`,
          ];
          if (analysis.summary?.countRetornoMuitoAlto > 0) chips.push(`Retorno>60min: ${analysis.summary.countRetornoMuitoAlto}`);
          const teamItems: any[] = [chipRow(chips)];
          analysis.flaggedDays?.forEach((ev: any, evIdx: number, evArr: any[]) => {
            const dayItems: any[] = [];
            dayItems.push(tl('Ultima OS Lib.', ev.hora_ultima_ordem || '\u2014', `Log Off: ${ev.log_off_corrigido || '\u2014'}`));
            if (ev.flags?.includes('retorno_muito_alto')) dayItems.push(alertItem(`Retorno muito alto: ${helpers.retornoAlertBody('retorno_muito_alto', ev)}`));
            else if (ev.flags?.includes('retorno_alto')) dayItems.push(alertItem(`Retorno acima da meta: ${helpers.retornoAlertBody('retorno_alto', ev)}`));
            teamItems.push({ stack: [
              {
                text: [
                  { text: ev.date_ref || '\u2014', bold: true, fontSize: 7.5, color: DARK },
                  { text: '    ' },
                  ...((ev.flags ?? []).flatMap((f: string, i: number) => [
                    ...(i > 0 ? [{ text: '  |  ', color: MUTED, fontSize: 6.5 }] : []),
                    { text: helpers.retornoFlagLabel(f), bold: true, color: RED, fontSize: 6.5 },
                  ])),
                ],
                margin: [0, 6, 0, 2],
              },
              indentBlock(dayItems, '#94a3b8', 6),
            ], unbreakable: true });
            if (evIdx < evArr.length - 1) teamItems.push(orderDivider());
          });
          const retornoBarColor = (analysis.gap ?? 1) <= 0 ? BLUE : RED;
          const retornoHdr = cardHeader(analysis.team, `${analysis.gap > 0 ? '+' : ''}${analysis.gap?.toFixed(1)} min s/meta`, true);
          const retornoBlock = indentBlock(teamItems, retornoBarColor, 8);
          if (analysisIdx === 0 && retornoDrillHead) {
            content.push({ stack: [retornoDrillHead, retornoHdr, retornoBlock] });
          } else {
            content.push({ stack: [cardDivider(), retornoHdr, retornoBlock] });
          }
        });
      }
      content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: '#cbd5e1' }], margin: [0, 14, 0, 0] });
    });

    // Scorecard table
    if (report.teamScorecard.length > 0) {
      content.push(
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: '#cbd5e1' }], margin: [0, 14, 0, 0] },
        { text: 'Scorecard por Equipe', style: 'sectionHeader', margin: [0, 16, 0, 6] },
        { text: 'Todos os KPIs por equipe. Azul = meta atingida, vermelho = abaixo da meta.', fontSize: 7.5, color: GRAY, margin: [0, 0, 0, 8] },
        {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body: [
              [th('Equipe'), th('Rank'), th('Dias'), th('OS/Dia\n4,4'), th('Efic.\n100%'), th('Util.\n85%'), th('TME\n20'), th('Login\n8'), th('Desloc\n25'), th('Ret.\n40'), th('Score')],
              ...report.teamScorecard.map((row) => [
                td(row.team, { bold: true, alignment: 'left' as const, fillColor: row.kpisBelowMeta >= 4 ? '#fff1f2' : row.kpisBelowMeta === 3 ? '#fffbeb' : null }),
                td(`${row.classificacao ?? '–'}`, { color: GRAY }),
                td(`${row.diasTrabalhados ?? '–'}`, { color: GRAY }),
                td(fmt(row.kpis.osDia), { color: row.kpiStatus.osDia === 'above' ? BLUE : row.kpiStatus.osDia === 'below' ? RED : DARK, bold: true }),
                td(row.kpis.eficiencia != null ? `${fmt(row.kpis.eficiencia, 0)}%` : '–', { color: row.kpiStatus.eficiencia === 'above' ? BLUE : row.kpiStatus.eficiencia === 'below' ? RED : DARK, bold: true }),
                td(row.kpis.utilizacao != null ? `${fmt(row.kpis.utilizacao, 0)}%` : '–', { color: row.kpiStatus.utilizacao === 'above' ? BLUE : row.kpiStatus.utilizacao === 'below' ? RED : DARK, bold: true }),
                td(fmt(row.kpis.tmeImp, 0), { color: row.kpiStatus.tmeImp === 'above' ? BLUE : row.kpiStatus.tmeImp === 'below' ? RED : DARK, bold: true }),
                td(fmt(row.kpis.primeiroLogin, 0), { color: row.kpiStatus.primeiroLogin === 'above' ? BLUE : row.kpiStatus.primeiroLogin === 'below' ? RED : DARK, bold: true }),
                td(fmt(row.kpis.primeiroDesloc, 0), { color: row.kpiStatus.primeiroDesloc === 'above' ? BLUE : row.kpiStatus.primeiroDesloc === 'below' ? RED : DARK, bold: true }),
                td(fmt(row.kpis.retornoBase, 0), { color: row.kpiStatus.retornoBase === 'above' ? BLUE : row.kpiStatus.retornoBase === 'below' ? RED : DARK, bold: true }),
                td(`${row.score}/7`, { bold: true, color: row.score >= 6 ? BLUE : row.score >= 4 ? '#d97706' : RED }),
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
        },
      );
    }

    // Deviations
    if (report.deviations.mostRecurring.length > 0) {
      content.push(
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: '#cbd5e1' }], margin: [0, 14, 0, 0], pageBreak: 'after' },
        { text: 'Desvios de Padrão Operacional', style: 'sectionHeader', margin: [0, 16, 0, 8] },
        {
          columns: [
            {
              stack: [
                { text: 'Mais Recorrentes', bold: true, fontSize: 8, color: GRAY, margin: [0, 0, 0, 6] },
                {
                  table: {
                    widths: ['*', 'auto'],
                    body: report.deviations.mostRecurring.map((d) => [
                      td(d.category, { alignment: 'left' as const }),
                      td(`${d.occurrences}`, { bold: true, color: RED }),
                    ]),
                  },
                  layout: 'lightHorizontalLines',
                },
              ],
              width: '50%',
            },
            report.deviations.teamBreakdown.length > 0 ? {
              stack: [
                { text: 'Por Equipe', bold: true, fontSize: 8, color: GRAY, margin: [0, 0, 0, 6] },
                {
                  table: {
                    widths: ['auto', '*'],
                    body: report.deviations.teamBreakdown.map((t) => [
                      td(t.team, { bold: true, alignment: 'left' as const }),
                      td(t.deviations.join(' · '), { color: GRAY }),
                    ]),
                  },
                  layout: 'lightHorizontalLines',
                },
              ],
              width: '50%',
            } : {},
          ],
          columnGap: 16,
        },
      );
    }

    // Action plan
    if (report.specialAnalysis.actionPlan.length > 0) {
      content.push(
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: '#cbd5e1' }], margin: [0, 14, 0, 0] },
        { text: 'Plano de Acao por Equipe', style: 'sectionHeader', margin: [0, 16, 0, 8] },
      );
      const plans = report.specialAnalysis.actionPlan;
      for (let i = 0; i < plans.length; i += 2) {
        const makeCard = (plan: any): any => ({
          stack: [
            { text: plan.team, bold: true, fontSize: 9, margin: [0, 0, 0, 4] },
            ...plan.issues.map((iss: string) => ({ text: `! ${iss}`, fontSize: 7.5, color: RED, margin: [0, 0, 0, 2] })),
            ...plan.recommendations.map((r: string) => ({ text: `> ${r}`, fontSize: 7, color: DARK, margin: [4, 0, 0, 2] })),
          ],
          margin: [0, 0, 0, 8],
        });
        content.push({
          columns: [
            { stack: [makeCard(plans[i])], width: '50%' },
            { stack: [plans[i + 1] ? makeCard(plans[i + 1]) : {}], width: '50%' },
          ],
          columnGap: 12,
        });
      }
    }

    return {
      pageSize: 'A4',
      pageMargins: [30, 36, 30, 36] as [number, number, number, number],
      content,
      styles: {
        sectionHeader: { fontSize: 13, bold: true, color: DARK },
      },
      defaultStyle: { font: 'Roboto', fontSize: 8, color: DARK },
    };
  }
}
