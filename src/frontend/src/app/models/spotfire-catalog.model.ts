export type SpotfireFilterKind = 'list' | 'range' | 'text' | 'toggle-group' | 'unknown';

export interface SpotfireFilterOption {
  label: string;
  selected: boolean;
}

export interface SpotfireFilterRange {
  min: string;
  max: string;
  selectedMin: string;
  selectedMax: string;
}

export interface SpotfireFilter {
  title: string;
  kind: SpotfireFilterKind;
  selectedValues: string[];
  options?: SpotfireFilterOption[];
  range?: SpotfireFilterRange;
  textValue?: string;
}