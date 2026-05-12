export const KPI_DEDUP_BY_DATE = new Set(['1º Login', '1º Desloc.', 'Retorno Base']);

export const KPI_DIRECTIONS: Record<string, 'higher-is-better' | 'lower-is-better'> = {
  'OS Dia': 'higher-is-better',
  'Eficiência': 'higher-is-better',
  'Utilização': 'higher-is-better',
  'TME IMP': 'lower-is-better',
  '1º Login': 'lower-is-better',
  '1º Desloc.': 'lower-is-better',
  'Retorno Base': 'lower-is-better',
};

export const KPI_ALIASES: Record<string, string[]> = {
  'OS Dia': ['Ativ/Equipe/Dia', 'OS Dia', 'OS/Dia', 'OS_Dia'],
  'Eficiência': ['Eficiencia', 'Eficiência'],
  'Utilização': ['Utilização', 'Utilizacao'],
  'TME IMP': ['TMR Improd.', 'TMR Improd', 'TME IMP', 'TME_IMP'],
  '1º Login': ['1º Login Corrigido', '1o Login Corrigido', '1º Login', '1o Login', 'Primeiro Login'],
  '1º Desloc.': ['1º Desloc', '1º Desloc.', '1o Desloc'],
  'Retorno Base': ['Retorno a Base', 'Retorno Base', 'Retorno à Base'],
};

export interface KpiThreshold {
  kpi: string;
  direction: 'higher-is-better' | 'lower-is-better';
  worst: number;
  meta: number;
  metaScore: number;
  best: number;
  maxScore: number;
}

export const KPI_THRESHOLDS: KpiThreshold[] = [
  { kpi: 'OS Dia',        direction: 'higher-is-better', worst:  1.0,  meta:  4.4,  metaScore: 15,  best:  5.5,  maxScore: 16.5 },
  { kpi: 'Eficiência',    direction: 'higher-is-better', worst: 80,    meta: 100,   metaScore: 10,  best: 125,   maxScore: 11.7 },
  { kpi: 'Utilização',    direction: 'higher-is-better', worst: 60,    meta:  85,   metaScore: 10,  best:  88,   maxScore: 11.2 },
  { kpi: 'TME IMP',       direction: 'lower-is-better',  worst: 28,    meta:  20,   metaScore: 10,  best:  17,   maxScore: 13.8 },
  { kpi: '1º Login',      direction: 'lower-is-better',  worst: 12,    meta:   8,   metaScore:  5,  best:   7,   maxScore:  6.3 },
  { kpi: '1º Desloc.',    direction: 'lower-is-better',  worst: 30,    meta:  25,   metaScore:  5,  best:  20,   maxScore: 10   },
  { kpi: 'Retorno Base',  direction: 'lower-is-better',  worst: 50,    meta:  40,   metaScore:  5,  best:  35,   maxScore:  7.5 },
];

/** Column config for computing per-day KPI averages from the desloc (Tab_Completa) CSV. */
export const KPI_DESLOC_DAILY_CONFIG: Record<string, {
  aliases: string[];
  aliases2?: string[];  // denominator column for ratio KPIs
  scale?: number;       // multiplier applied after ratio (e.g. 100 → percentage)
  /** When set, count distinct values of this column per team per date instead of reading a value column. */
  countBy?: string[];
  /** When true + aliases2 set, values are fixed per (date, team) — deduplicate to first row before ratio. */
  dedup?: boolean;
}> = {
  'OS Dia':       { aliases: [], countBy: ['Nr_Ordem', 'Nr Ordem', 'NR_ORDEM', 'Numero OS', 'Número OS'] },
  '1º Login':     { aliases: ['1º Login Corrigido', '1o Login Corrigido', '1º Login', '1o Login'] },
  '1º Desloc.':   { aliases: ['1º Desloc', '1o Desloc'] },
  'Retorno Base': { aliases: ['Retorno a base', 'Retorno a Base', 'Retorno Base'] },
  'TME IMP':      { aliases: ['TR Ordem Imp SS equipe', 'TR Ordem Imp SS'] },
  'Eficiência':   { aliases: ['TEMPO_PADRAO_TOTAL_CAL'], aliases2: ['TR_TOTAL_CAL'], scale: 100 },
  'Utilização':   { aliases: ['HT total', 'HT Total'], aliases2: ['HD Total'], scale: 100, dedup: true },
};

