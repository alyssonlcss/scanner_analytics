import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseCsv } from 'csv-parse/sync';

import type { Environment } from '../../infrastructure/config/env.js';

type TeamType = 'propria' | 'parceira';

type CsvRow = Record<string, string>;

export interface DownloadedFileRef {
  analysisTab: string;
  tableTitle: string;
  fileName: string;
  filePath: string;
}

export interface ReportFilterInput {
  bases?: string[];
  teamTypes?: TeamType[];
  includeExtraTags?: boolean;
}

interface TeamMetricSummary {
  team: string;
  records: number;
  tempPrepJornada: number;
  semOrdemJornada: number;
}

interface KpiRankItem {
  team: string;
  value: number;
}

interface KpiInsight {
  kpi: string;
  direction: 'higher-is-better' | 'lower-is-better';
  topTeams: KpiRankItem[];
  opportunityTeams: KpiRankItem[];
}

interface DeviationInsight {
  category: string;
  occurrences: number;
}

interface DeviationByTeam {
  team: string;
  deviations: string[];
}

interface CrossedInsight {
  title: string;
  description: string;
  evidence: Array<Record<string, string | number>>;
}

export interface GeneratedReport {
  generatedAt: string;
  filtersApplied: {
    bases: string[];
    teamTypes: TeamType[];
    includeExtraTags: boolean;
    extraTags: string[];
  };
  totals: {
    teams: number;
    deslocamentos: number;
    rankingRows: number;
    desviosRows: number;
  };
  kpis: KpiInsight[];
  deviations: {
    mostRecurring: DeviationInsight[];
    teamBreakdown: DeviationByTeam[];
  };
  specialAnalysis: {
    tempPrepAndSemOs: TeamMetricSummary[];
    crossedInsights: CrossedInsight[];
  };
  outputFiles: {
    jsonPath: string;
    markdownPath: string;
  };
}

interface TempSemOsRow {
  team: string;
  dateRef: string;
  tempPrep: number;
  semOsEntreOs: number;
  tempPrepJornada: number;
  semOrdemJornada: number;
}

const KPI_DIRECTIONS: Record<string, 'higher-is-better' | 'lower-is-better'> = {
  'OS Dia': 'higher-is-better',
  'Eficiência': 'higher-is-better',
  'Utilização': 'higher-is-better',
  'Reparo Por OS': 'lower-is-better',
  TME: 'lower-is-better',
  'TME IMP': 'lower-is-better',
  '1º Login': 'lower-is-better',
  '1º Desloc.': 'lower-is-better',
  'Retorno Base': 'lower-is-better',
};

const KPI_ALIASES: Record<string, string[]> = {
  'OS Dia': ['OS Dia', 'OS/Dia', 'OS_Dia'],
  'Eficiência': ['Eficiência', 'Eficiencia'],
  'Utilização': ['Utilização', 'Utilizacao'],
  'Reparo Por OS': ['Reparo Por OS', 'Reparo/OS'],
  TME: ['TME'],
  'TME IMP': ['TME IMP', 'TME_IMP'],
  '1º Login': ['1º Login', '1o Login', 'Primeiro Login'],
  '1º Desloc.': ['1º Desloc.', '1º Desloc', '1o Desloc', 'Primeiro Desloc'],
  'Retorno Base': ['Retorno Base', 'Retorno à Base', 'Retorno a Base'],
};

export class PostDownloadReportService {
  public constructor(private readonly environment: Environment) {}

  public async generate(params: {
    dataDirectory: string;
    downloadedFiles: DownloadedFileRef[];
    reportFilters?: ReportFilterInput;
  }): Promise<GeneratedReport> {
    const displacementFile = this.findFile(params.downloadedFiles, ['tab_completa', 'deslocamentos']);
    const rankingFile = this.findFile(params.downloadedFiles, ['ranking']);
    const deviationsFile = this.findFile(params.downloadedFiles, ['desvios']);

    const deslocamentos = displacementFile ? await this.readCsv(displacementFile.filePath) : [];
    const ranking = rankingFile ? await this.readCsv(rankingFile.filePath) : [];
    const desvios = deviationsFile ? await this.readCsv(deviationsFile.filePath) : [];

    const filtered = this.applyTeamFilters(
      { deslocamentos, ranking, desvios },
      params.reportFilters,
    );

    const tempSemOs = this.calculateTempPrepSemOs(filtered.deslocamentos);
    const teamMetrics = this.buildTeamMetrics(tempSemOs);
    const kpis = this.buildKpiInsights(filtered.ranking);
    const deviationInsights = this.buildDeviationInsights(filtered.desvios);
    const crossedInsights = this.buildCrossedInsights(teamMetrics, kpis, deviationInsights.teamBreakdown);

    const generatedAt = new Date().toISOString();
    const report: GeneratedReport = {
      generatedAt,
      filtersApplied: {
        bases: params.reportFilters?.bases ?? [],
        teamTypes: params.reportFilters?.teamTypes ?? [],
        includeExtraTags: params.reportFilters?.includeExtraTags ?? true,
        extraTags: this.environment.report.extraTeamTags,
      },
      totals: {
        teams: new Set(teamMetrics.map((item) => item.team)).size,
        deslocamentos: filtered.deslocamentos.length,
        rankingRows: filtered.ranking.length,
        desviosRows: filtered.desvios.length,
      },
      kpis,
      deviations: deviationInsights,
      specialAnalysis: {
        tempPrepAndSemOs: teamMetrics,
        crossedInsights,
      },
      outputFiles: {
        jsonPath: join(params.dataDirectory, this.environment.report.outputFileName),
        markdownPath: join(params.dataDirectory, this.environment.report.outputFileName.replace(/\.json$/i, '.md')),
      },
    };

    await writeFile(report.outputFiles.jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    await writeFile(report.outputFiles.markdownPath, this.buildMarkdownReport(report), 'utf-8');

    return report;
  }

  private async readCsv(filePath: string): Promise<CsvRow[]> {
    const raw = await readFile(filePath, 'utf-8');
    const delimiter = raw.includes(';') ? ';' : ',';

    const rows = parseCsv(raw, {
      columns: true,
      skip_empty_lines: true,
      delimiter,
      bom: true,
      trim: true,
    }) as CsvRow[];

    return rows;
  }

  private findFile(files: DownloadedFileRef[], expectedTokens: string[]): DownloadedFileRef | undefined {
    return files.find((file) => {
      const source = normalizeToken(`${file.tableTitle} ${file.fileName}`);
      return expectedTokens.every((token) => source.includes(normalizeToken(token)));
    }) ?? files.find((file) => {
      const source = normalizeToken(`${file.tableTitle} ${file.fileName}`);
      return expectedTokens.some((token) => source.includes(normalizeToken(token)));
    });
  }

  private applyTeamFilters(
    datasets: { deslocamentos: CsvRow[]; ranking: CsvRow[]; desvios: CsvRow[] },
    reportFilters?: ReportFilterInput,
  ): { deslocamentos: CsvRow[]; ranking: CsvRow[]; desvios: CsvRow[] } {
    const includeExtra = reportFilters?.includeExtraTags ?? true;
    const teamMatcher = this.buildTeamMatcher(reportFilters, includeExtra);

    const filterRows = (rows: CsvRow[]): CsvRow[] => {
      if (rows.length === 0) {
        return rows;
      }

      const accessor = createAccessor(rows[0]);
      const teamColumn = accessor.resolve(['Equipe', 'Team', 'Equipe Nome']);
      if (!teamColumn) {
        return rows;
      }

      return rows.filter((row) => teamMatcher(String(row[teamColumn] ?? '')));
    };

    return {
      deslocamentos: filterRows(datasets.deslocamentos),
      ranking: filterRows(datasets.ranking),
      desvios: filterRows(datasets.desvios),
    };
  }

  private buildTeamMatcher(reportFilters: ReportFilterInput | undefined, includeExtraTags: boolean): (team: string) => boolean {
    const selectedBases = new Set((reportFilters?.bases ?? []).map((base) => normalizeToken(base)));
    const selectedTypes = new Set(reportFilters?.teamTypes ?? []);
    const hasBaseFilter = selectedBases.size > 0;
    const hasTypeFilter = selectedTypes.size > 0;
    const allowedPrefixes = new Set<string>();

    for (const [baseName, prefixes] of Object.entries(this.environment.report.basePrefixMap)) {
      const baseMatch = !hasBaseFilter || selectedBases.has(normalizeToken(baseName));
      if (!baseMatch) {
        continue;
      }

      if (!hasTypeFilter || selectedTypes.has('propria')) {
        allowedPrefixes.add(prefixes.ownPrefix.toUpperCase());
      }
      if (!hasTypeFilter || selectedTypes.has('parceira')) {
        allowedPrefixes.add(prefixes.partnerPrefix.toUpperCase());
      }
    }

    const extraTags = includeExtraTags
      ? this.environment.report.extraTeamTags.map((tag) => tag.toUpperCase())
      : [];

    return (teamNameRaw: string): boolean => {
      const teamName = teamNameRaw.toUpperCase().trim();
      if (teamName.length === 0) {
        return false;
      }

      const prefixMatch = allowedPrefixes.size === 0
        ? true
        : Array.from(allowedPrefixes).some((prefix) => teamName.startsWith(prefix));

      if (!prefixMatch) {
        return extraTags.some((tag) => teamName.includes(tag));
      }

      return true;
    };
  }

  private calculateTempPrepSemOs(rows: CsvRow[]): TempSemOsRow[] {
    if (rows.length === 0) {
      return [];
    }

    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe']);
    const dateCol = accessor.resolve(['Data Referência', 'Data Referencia']);
    const caminhoCol = accessor.resolve(['A_Caminho', 'A Caminho']);
    const despachadaCol = accessor.resolve(['Despachada']);
    const liberadaCol = accessor.resolve(['Liberada']);
    const firstDeslocCol = accessor.resolve(['1º Desloc', '1o Desloc']);
    const firstDespachoCol = accessor.resolve(['1º Despacho', '1o Despacho']);
    const intervaloCol = accessor.resolve(['Intervalo']);
    const inicioIntervaloCol = accessor.resolve(['Inicio Intervalo', 'Início Intervalo']);
    const fimIntervaloCol = accessor.resolve(['Fim Intervalo']);

    if (!teamCol || !dateCol || !caminhoCol || !despachadaCol || !liberadaCol || !firstDeslocCol || !firstDespachoCol) {
      return [];
    }

    const grouped = new Map<string, CsvRow[]>();

    for (const row of rows) {
      const key = `${row[teamCol] ?? ''}::${row[dateCol] ?? ''}`;
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }

    const output: TempSemOsRow[] = [];

    for (const groupRows of grouped.values()) {
      const ordered = [...groupRows].sort((a, b) => {
        const left = parseDateTimeBr(String(a[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const right = parseDateTimeBr(String(b[caminhoCol] ?? ''))?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return left - right;
      });

      if (ordered.length === 0) {
        continue;
      }

      const firstRow = ordered[0];
      const team = String(firstRow[teamCol] ?? '').trim();
      const dateRef = String(firstRow[dateCol] ?? '').trim();
      const firstIntervalMinutes = parseNumber(firstRow[intervaloCol ?? ''] as string);
      const semOsIntervalStart = inicioIntervaloCol ? parseDateTimeBr(String(firstRow[inicioIntervaloCol] ?? '')) : null;
      const semOsIntervalEnd = fimIntervaloCol ? parseDateTimeBr(String(firstRow[fimIntervaloCol] ?? '')) : null;

      const tempPrepValues: number[] = [];
      const semOsValues: number[] = [];
      let isInterACaminho = false;
      let isInterOrdem = false;

      tempPrepValues.push(parseNumber(String(firstRow[firstDeslocCol] ?? '')) ?? Number.NaN);
      semOsValues.push(parseNumber(String(firstRow[firstDespachoCol] ?? '')) ?? Number.NaN);

      for (let i = 1; i < ordered.length; i++) {
        const current = ordered[i];
        const previous = ordered[i - 1];

        const aCaminho = parseDateTimeBr(String(current[caminhoCol] ?? ''));
        const despachada = parseDateTimeBr(String(current[despachadaCol] ?? ''));
        const liberada = parseDateTimeBr(String(previous[liberadaCol] ?? ''));
        const inicioIntervalo = inicioIntervaloCol ? parseDateTimeBr(String(current[inicioIntervaloCol] ?? '')) : null;
        const fimIntervalo = fimIntervaloCol ? parseDateTimeBr(String(current[fimIntervaloCol] ?? '')) : null;
        const intervaloMinutes = parseNumber(String(current[intervaloCol ?? ''] ?? ''));

        const tempPrep = this.calculateTempPrepValue({
          aCaminho,
          despachada,
          liberada,
          inicioIntervalo,
          fimIntervalo,
          intervaloMinutes,
          isIntervalAlreadyApplied: isInterACaminho,
        });

        if (tempPrep.intervalApplied) {
          isInterACaminho = true;
        }

        tempPrepValues.push(tempPrep.value);

        const semOs = this.calculateSemOsValue({
          despachada,
          liberada,
          inicioIntervalo: semOsIntervalStart,
          fimIntervalo: semOsIntervalEnd,
          intervaloMinutes: firstIntervalMinutes,
          isIntervalAlreadyApplied: isInterOrdem,
        });

        if (semOs.intervalApplied) {
          isInterOrdem = true;
        }

        semOsValues.push(semOs.value);
      }

      const tempPrepJornada = safeSum(tempPrepValues);
      const semOrdemJornada = safeSum(semOsValues);

      for (let i = 0; i < ordered.length; i++) {
        output.push({
          team,
          dateRef,
          tempPrep: tempPrepValues[i] ?? Number.NaN,
          semOsEntreOs: semOsValues[i] ?? Number.NaN,
          tempPrepJornada,
          semOrdemJornada,
        });
      }
    }

    return output;
  }

  private calculateTempPrepValue(input: {
    aCaminho: Date | null;
    despachada: Date | null;
    liberada: Date | null;
    inicioIntervalo: Date | null;
    fimIntervalo: Date | null;
    intervaloMinutes: number | null;
    isIntervalAlreadyApplied: boolean;
  }): { value: number; intervalApplied: boolean } {
    const {
      aCaminho,
      despachada,
      liberada,
      inicioIntervalo,
      fimIntervalo,
      intervaloMinutes,
      isIntervalAlreadyApplied,
    } = input;

    if (!aCaminho || !liberada) {
      return { value: Number.NaN, intervalApplied: false };
    }

    let value = Number.NaN;
    let intervalApplied = false;
    let shouldApplyDiscount = false;

    if (despachada && despachada.getTime() > liberada.getTime()) {
      const interceptsDispatch = Boolean(
        inicioIntervalo &&
        fimIntervalo &&
        liberada.getTime() < inicioIntervalo.getTime() &&
        inicioIntervalo.getTime() < despachada.getTime() &&
        despachada.getTime() < fimIntervalo.getTime() &&
        fimIntervalo.getTime() <= aCaminho.getTime() &&
        !isIntervalAlreadyApplied,
      );

      if (interceptsDispatch && fimIntervalo && inicioIntervalo) {
        value = minutesBetween(aCaminho, fimIntervalo);
        const duration = minutesBetween(fimIntervalo, inicioIntervalo);
        if (duration > 60) {
          value += duration - 60;
        }
        intervalApplied = true;
      } else {
        value = minutesBetween(aCaminho, despachada);

        const insideTolerance = Boolean(
          inicioIntervalo &&
          fimIntervalo &&
          inicioIntervalo.getTime() >= despachada.getTime() - 10 * 60_000 &&
          fimIntervalo.getTime() <= aCaminho.getTime() + 10 * 60_000 &&
          !isIntervalAlreadyApplied,
        );

        if (insideTolerance) {
          intervalApplied = true;
          shouldApplyDiscount = true;
        }
      }
    } else {
      const intervalBetweenLiberadaAndCaminho = Boolean(
        inicioIntervalo &&
        fimIntervalo &&
        liberada.getTime() < inicioIntervalo.getTime() &&
        fimIntervalo.getTime() < aCaminho.getTime() &&
        !isIntervalAlreadyApplied,
      );

      if (intervalBetweenLiberadaAndCaminho && inicioIntervalo && fimIntervalo) {
        value = minutesBetween(aCaminho, fimIntervalo);
        const duration = minutesBetween(fimIntervalo, inicioIntervalo);
        if (duration > 60) {
          value += duration - 60;
        }
        intervalApplied = true;
      } else {
        value = minutesBetween(aCaminho, liberada);

        const insideTolerance = Boolean(
          inicioIntervalo &&
          fimIntervalo &&
          inicioIntervalo.getTime() >= liberada.getTime() - 10 * 60_000 &&
          fimIntervalo.getTime() <= aCaminho.getTime() + 10 * 60_000 &&
          !isIntervalAlreadyApplied,
        );

        if (insideTolerance) {
          intervalApplied = true;
          shouldApplyDiscount = true;
        }
      }
    }

    if (shouldApplyDiscount) {
      value = applyIntervalDiscount(value, intervaloMinutes);
    }

    return { value, intervalApplied };
  }

  private calculateSemOsValue(input: {
    despachada: Date | null;
    liberada: Date | null;
    inicioIntervalo: Date | null;
    fimIntervalo: Date | null;
    intervaloMinutes: number | null;
    isIntervalAlreadyApplied: boolean;
  }): { value: number; intervalApplied: boolean } {
    const {
      despachada,
      liberada,
      inicioIntervalo,
      fimIntervalo,
      intervaloMinutes,
      isIntervalAlreadyApplied,
    } = input;

    if (!despachada || !liberada) {
      return { value: Number.NaN, intervalApplied: false };
    }

    if (despachada.getTime() <= liberada.getTime()) {
      return { value: Number.NaN, intervalApplied: false };
    }

    const interceptsDispatch = Boolean(
      inicioIntervalo &&
      fimIntervalo &&
      liberada.getTime() < inicioIntervalo.getTime() &&
      inicioIntervalo.getTime() < despachada.getTime() &&
      despachada.getTime() < fimIntervalo.getTime() &&
      !isIntervalAlreadyApplied,
    );

    if (interceptsDispatch && inicioIntervalo) {
      return {
        value: minutesBetween(inicioIntervalo, liberada),
        intervalApplied: true,
      };
    }

    let value = minutesBetween(despachada, liberada);

    const insideTolerance = Boolean(
      inicioIntervalo &&
      fimIntervalo &&
      inicioIntervalo.getTime() >= liberada.getTime() - 10 * 60_000 &&
      fimIntervalo.getTime() <= despachada.getTime() + 10 * 60_000 &&
      !isIntervalAlreadyApplied,
    );

    if (insideTolerance) {
      value = applyIntervalDiscount(value, intervaloMinutes);
      return { value, intervalApplied: true };
    }

    return { value, intervalApplied: false };
  }

  private buildTeamMetrics(rows: TempSemOsRow[]): TeamMetricSummary[] {
    const grouped = new Map<string, TeamMetricSummary>();

    for (const row of rows) {
      const current = grouped.get(row.team) ?? {
        team: row.team,
        records: 0,
        tempPrepJornada: 0,
        semOrdemJornada: 0,
      };

      current.records += 1;
      current.tempPrepJornada += Number.isFinite(row.tempPrepJornada) ? row.tempPrepJornada : 0;
      current.semOrdemJornada += Number.isFinite(row.semOrdemJornada) ? row.semOrdemJornada : 0;
      grouped.set(row.team, current);
    }

    return Array.from(grouped.values())
      .map((item) => ({
        ...item,
        tempPrepJornada: round2(item.tempPrepJornada),
        semOrdemJornada: round2(item.semOrdemJornada),
      }))
      .sort((a, b) => b.semOrdemJornada - a.semOrdemJornada);
  }

  private buildKpiInsights(rows: CsvRow[]): KpiInsight[] {
    if (rows.length === 0) {
      return [];
    }

    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe', 'Team', 'Equipe Nome']);
    if (!teamCol) {
      return [];
    }

    const insights: KpiInsight[] = [];

    for (const [kpi, aliases] of Object.entries(KPI_ALIASES)) {
      const kpiCol = accessor.resolve(aliases);
      if (!kpiCol) {
        continue;
      }

      const values: KpiRankItem[] = rows
        .map((row) => ({
          team: String(row[teamCol] ?? '').trim(),
          value: parseNumber(String(row[kpiCol] ?? '')) ?? Number.NaN,
        }))
        .filter((item) => item.team.length > 0 && Number.isFinite(item.value));

      if (values.length === 0) {
        continue;
      }

      const direction = KPI_DIRECTIONS[kpi] ?? 'higher-is-better';
      const sorted = [...values].sort((a, b) => direction === 'higher-is-better' ? b.value - a.value : a.value - b.value);

      insights.push({
        kpi,
        direction,
        topTeams: sorted.slice(0, 3).map((item) => ({ ...item, value: round2(item.value) })),
        opportunityTeams: sorted.slice(-3).reverse().map((item) => ({ ...item, value: round2(item.value) })),
      });
    }

    return insights;
  }

  private buildDeviationInsights(rows: CsvRow[]): { mostRecurring: DeviationInsight[]; teamBreakdown: DeviationByTeam[] } {
    if (rows.length === 0) {
      return { mostRecurring: [], teamBreakdown: [] };
    }

    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe', 'Team']);
    const deviationCol = accessor.resolve(['Desvio', 'Tipo Desvio', 'Desvios', 'Ocorrência', 'Ocorrencia', 'Descrição']);

    if (!teamCol || !deviationCol) {
      return { mostRecurring: [], teamBreakdown: [] };
    }

    const countByDeviation = new Map<string, number>();
    const countByTeam = new Map<string, Map<string, number>>();

    for (const row of rows) {
      const team = String(row[teamCol] ?? '').trim();
      const category = String(row[deviationCol] ?? '').trim();
      if (!team || !category) {
        continue;
      }

      countByDeviation.set(category, (countByDeviation.get(category) ?? 0) + 1);

      const teamMap = countByTeam.get(team) ?? new Map<string, number>();
      teamMap.set(category, (teamMap.get(category) ?? 0) + 1);
      countByTeam.set(team, teamMap);
    }

    const mostRecurring = Array.from(countByDeviation.entries())
      .map(([category, occurrences]) => ({ category, occurrences }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10);

    const teamBreakdown = Array.from(countByTeam.entries())
      .map(([team, teamMap]) => ({
        team,
        deviations: Array.from(teamMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([category]) => category),
      }))
      .sort((a, b) => a.team.localeCompare(b.team));

    return { mostRecurring, teamBreakdown };
  }

  private buildCrossedInsights(
    teamMetrics: TeamMetricSummary[],
    kpis: KpiInsight[],
    teamDeviations: DeviationByTeam[],
  ): CrossedInsight[] {
    const deviationMap = new Map(teamDeviations.map((item) => [item.team, item.deviations]));
    const utilKpi = kpis.find((item) => normalizeToken(item.kpi) === normalizeToken('Utilização'));
    const retornoBase = kpis.find((item) => normalizeToken(item.kpi) === normalizeToken('Retorno Base'));

    const matrixEvidence = teamMetrics
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => {
          const token = normalizeToken(entry);
          return token.includes(normalizeToken('Util < 40%')) || token.includes(normalizeToken('Intervalo < 30 ou > 70 min'));
        });
      })
      .slice(0, 8)
      .map((item) => ({
        team: item.team,
        semOrdemJornada: item.semOrdemJornada,
        tempPrepJornada: item.tempPrepJornada,
      }));

    const falsePositiveEvidence = (retornoBase?.topTeams ?? [])
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => normalizeToken(entry).includes(normalizeToken('Retorno a base < 8 min')));
      })
      .map((item) => ({
        team: item.team,
        retornoBase: item.value,
      }));

    const highIdleThreshold = percentile(teamMetrics.map((item) => item.semOrdemJornada), 0.75);
    const idleCulpabilityEvidence = teamMetrics
      .filter((item) => item.semOrdemJornada >= highIdleThreshold)
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => {
          const token = normalizeToken(entry);
          return token.includes(normalizeToken('Sem Fim Turno')) || token.includes(normalizeToken('Calendário Errado'));
        });
      })
      .map((item) => ({
        team: item.team,
        semOrdemJornada: item.semOrdemJornada,
      }));

    return [
      {
        title: 'Matriz Desvios vs Utilização',
        description: utilKpi
          ? 'Cruza equipes com desvios críticos de utilização/intervalo com os tempos calculados de TempPrep e SemOSentreOS.'
          : 'Cruza equipes com desvios críticos de utilização/intervalo com tempos de ociosidade calculados.',
        evidence: matrixEvidence,
      },
      {
        title: 'Análise de Falsos Positivos de Retorno',
        description: 'Identifica equipes com boa nota de Retorno Base e desvio de retorno suspeito (<8 min).',
        evidence: falsePositiveEvidence,
      },
      {
        title: 'Culpabilidade do Ócio',
        description: 'Relaciona alto SemOSentreOS com desvios de indisciplina de apontamento.',
        evidence: idleCulpabilityEvidence,
      },
    ];
  }

  private buildMarkdownReport(report: GeneratedReport): string {
    const lines: string[] = [];

    lines.push('# Relatorio Analitico Scanner');
    lines.push('');
    lines.push(`Gerado em: ${report.generatedAt}`);
    lines.push('');
    lines.push('## Totais');
    lines.push(`- Equipes avaliadas: ${report.totals.teams}`);
    lines.push(`- Registros de deslocamento: ${report.totals.deslocamentos}`);
    lines.push(`- Linhas de ranking: ${report.totals.rankingRows}`);
    lines.push(`- Linhas de desvios: ${report.totals.desviosRows}`);
    lines.push('');

    lines.push('## KPIs');
    for (const insight of report.kpis) {
      lines.push(`### ${insight.kpi}`);
      lines.push(`Direcao: ${insight.direction}`);
      lines.push(`Top 3: ${insight.topTeams.map((item) => `${item.team} (${item.value})`).join(', ') || 'Sem dados'}`);
      lines.push(`Oportunidade: ${insight.opportunityTeams.map((item) => `${item.team} (${item.value})`).join(', ') || 'Sem dados'}`);
      lines.push('');
    }

    lines.push('## Desvios Mais Recorrentes');
    for (const item of report.deviations.mostRecurring) {
      lines.push(`- ${item.category}: ${item.occurrences}`);
    }
    lines.push('');

    lines.push('## Analise Especial');
    for (const insight of report.specialAnalysis.crossedInsights) {
      lines.push(`### ${insight.title}`);
      lines.push(insight.description);
      if (insight.evidence.length === 0) {
        lines.push('- Sem evidencias para os filtros selecionados.');
      } else {
        for (const evidence of insight.evidence) {
          lines.push(`- ${JSON.stringify(evidence)}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

function createAccessor(sample: CsvRow): {
  resolve: (candidates: string[]) => string | undefined;
} {
  const keys = Object.keys(sample);
  const normalizedMap = new Map<string, string>();

  for (const key of keys) {
    normalizedMap.set(normalizeToken(key), key);
  }

  return {
    resolve: (candidates: string[]) => {
      for (const candidate of candidates) {
        const match = normalizedMap.get(normalizeToken(candidate));
        if (match) {
          return match;
        }
      }
      return undefined;
    },
  };
}

function normalizeToken(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

function parseNumber(valueRaw: string): number | null {
  if (!valueRaw) {
    return null;
  }

  const cleaned = valueRaw.trim();
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;
  if (hasComma && hasDot) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = normalized.replace(',', '.');
  }

  const value = normalized.replace(/[^0-9.-]/g, '');

  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateTimeBr(valueRaw: string): Date | null {
  const value = valueRaw?.trim();
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, dd, mm, yyyy, hh = '0', min = '0', sec = '0'] = match;
  const year = yyyy.length === 2 ? Number(`20${yyyy}`) : Number(yyyy);
  const parsed = new Date(year, Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(sec));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function minutesBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 60_000;
}

function applyIntervalDiscount(value: number, intervaloMinutes: number | null): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  if (intervaloMinutes === null || !Number.isFinite(intervaloMinutes) || intervaloMinutes < 0) {
    return value;
  }

  let adjusted = value - Math.min(intervaloMinutes, 60);
  const excedente = intervaloMinutes - 60;

  if (excedente > 0) {
    adjusted += excedente;
  }

  if (adjusted < 0) {
    return 0;
  }

  return adjusted;
}

function safeSum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return round2(total);
}

function percentile(values: number[], p: number): number {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) {
    return 0;
  }

  const index = Math.max(0, Math.min(finite.length - 1, Math.floor((finite.length - 1) * p)));
  return finite[index];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
