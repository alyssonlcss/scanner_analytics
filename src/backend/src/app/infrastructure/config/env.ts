import { config as loadEnvironment } from 'dotenv';
import { z } from 'zod';

loadEnvironment();

const booleanFromEnvironment = z
  .union([z.boolean(), z.string().trim().toLowerCase()])
  .transform((value, context) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (['true', '1', 'yes', 'y', 'on'].includes(value)) {
      return true;
    }

    if (['false', '0', 'no', 'n', 'off'].includes(value)) {
      return false;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected a boolean-like environment value.',
    });

    return z.NEVER;
  });

const environmentSchema = z.object({
  PORT: z.coerce.number().default(3000),
  SPOTFIRE_LOGIN_URL: z.string().min(1),
  SPOTFIRE_ANALYSIS_URL: z.string().min(1).optional(),
  SPOTFIRE_REPORT_URL: z.string().min(1).optional(),
  SPOTFIRE_USERNAME: z.string().min(1),
  SPOTFIRE_PASSWORD: z.string().min(1),
  SPOTFIRE_HEADLESS: booleanFromEnvironment.default(true),
  SPOTFIRE_BROWSER_PATH: z.string().optional().default(''),
  SPOTFIRE_BROWSER_URL: z.string().url().optional(),
  SPOTFIRE_BROWSER_WS_ENDPOINT: z.string().url().optional(),
  SPOTFIRE_USER_DATA_DIR: z.string().optional().default(''),
  SPOTFIRE_PROFILE_DIRECTORY: z.string().optional().default(''),
  SPOTFIRE_DEFAULT_REPORT_TITLE: z.string().default('Scanner 4.0 - CE'),
  SPOTFIRE_FILTER_PANEL_LABEL: z.string().default('Filters'),
  SPOTFIRE_EXPORT_MENU_LABEL: z.string().default('Export table'),
  SPOTFIRE_EXPORT_PARENT_MENU_LABEL: z.string().default('Export'),
  SPOTFIRE_OUTPUT_DIR: z.string().default('../../data'),
  SPOTFIRE_DOWNLOAD_TABLES: z.string().default('Tab_Completa-Deslocamentos,Ranking-Detalhamento_Diário,Desvios-Relatório_Geral:Desvios'),
  SPOTFIRE_DEBUG: booleanFromEnvironment.default(false),
  FILTER_BASE_ITAPAJE_OWN_PREFIX: z.string().default('ITJ-'),
  FILTER_BASE_ITAPAJE_PARTNER_PREFIX: z.string().default('ITE-'),
  FILTER_BASE_ITAPIPOCA_OWN_PREFIX: z.string().default('ITK-'),
  FILTER_BASE_ITAPIPOCA_PARTNER_PREFIX: z.string().default('IPK-'),
  FILTER_BASE_TRAIRI_OWN_PREFIX: z.string().default('TRR-'),
  FILTER_BASE_TRAIRI_PARTNER_PREFIX: z.string().default('IPT-'),
  FILTER_BASE_ACARAU_OWN_PREFIX: z.string().default('ACU-'),
  FILTER_BASE_ACARAU_PARTNER_PREFIX: z.string().default('ACA-'),
  TAGS_EQUIPES_EXTRAS: z.string().default('-PD-,-ML-,-EP-,-LC-,-LL-,-CO-,-MP-,-IN-,-EN-,-MO-,-LV-'),
  REPORT_AUTO_GENERATE: booleanFromEnvironment.default(true),
  REPORT_OUTPUT_FILE_NAME: z.string().default('scanner-analytics-report.json'),
});

function parseCsvList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseDownloadTargets(raw: string): Array<{ analysisTab: string; tableTitle: string; fileAlias?: string }> {
  const results: Array<{ analysisTab: string; tableTitle: string; fileAlias?: string }> = [];

  const entries = raw.split(',').map(e => e.trim()).filter(e => e.length > 0);

  for (const entry of entries) {
    const segments = entry.split('-');
    if (segments.length < 2) {
      throw new Error(`Invalid SPOTFIRE_DOWNLOAD_TABLES entry "${entry}": expected "Aba-Tabela" format (use - to separate tab from tables)`);
    }

    const analysisTab = segments[0].replace(/_/g, ' ');

    for (let i = 1; i < segments.length; i++) {
      const [tableRaw, aliasRaw] = segments[i].split(':');
      const tableTitle = tableRaw.replace(/_/g, ' ');
      const fileAlias = aliasRaw?.trim().replace(/_/g, ' ') || undefined;
      results.push({ analysisTab, tableTitle, ...(fileAlias ? { fileAlias } : {}) });
    }
  }

  return results;
}

const parsedEnvironment = environmentSchema.parse(process.env);
const resolvedAnalysisUrl = parsedEnvironment.SPOTFIRE_ANALYSIS_URL ?? parsedEnvironment.SPOTFIRE_REPORT_URL;

if (!resolvedAnalysisUrl) {
  throw new Error('Missing Spotfire analysis URL. Define SPOTFIRE_ANALYSIS_URL or SPOTFIRE_REPORT_URL in src/backend/.env.');
}

export const environment = {
  port: parsedEnvironment.PORT,
  spotfire: {
    loginUrl: parsedEnvironment.SPOTFIRE_LOGIN_URL,
    analysisUrl: resolvedAnalysisUrl,
    username: parsedEnvironment.SPOTFIRE_USERNAME,
    password: parsedEnvironment.SPOTFIRE_PASSWORD,
    headless: parsedEnvironment.SPOTFIRE_HEADLESS,
    keepOpen: !parsedEnvironment.SPOTFIRE_HEADLESS,
    browserPath: parsedEnvironment.SPOTFIRE_BROWSER_PATH,
    browserUrl: parsedEnvironment.SPOTFIRE_BROWSER_URL,
    browserWSEndpoint: parsedEnvironment.SPOTFIRE_BROWSER_WS_ENDPOINT,
    userDataDir: parsedEnvironment.SPOTFIRE_USER_DATA_DIR,
    profileDirectory: parsedEnvironment.SPOTFIRE_PROFILE_DIRECTORY,
    defaultReportTitle: parsedEnvironment.SPOTFIRE_DEFAULT_REPORT_TITLE,
    filterPanelLabel: parsedEnvironment.SPOTFIRE_FILTER_PANEL_LABEL,
    exportMenuLabel: parsedEnvironment.SPOTFIRE_EXPORT_MENU_LABEL,
    exportParentMenuLabel: parsedEnvironment.SPOTFIRE_EXPORT_PARENT_MENU_LABEL,
    outputDirectory: parsedEnvironment.SPOTFIRE_OUTPUT_DIR,
    downloadTargets: parseDownloadTargets(parsedEnvironment.SPOTFIRE_DOWNLOAD_TABLES),
    debug: parsedEnvironment.SPOTFIRE_DEBUG,
  },
  report: {
    autoGenerate: parsedEnvironment.REPORT_AUTO_GENERATE,
    outputFileName: parsedEnvironment.REPORT_OUTPUT_FILE_NAME,
    basePrefixMap: {
      Itapaje: {
        ownPrefix: parsedEnvironment.FILTER_BASE_ITAPAJE_OWN_PREFIX,
        partnerPrefix: parsedEnvironment.FILTER_BASE_ITAPAJE_PARTNER_PREFIX,
      },
      Itapipoca: {
        ownPrefix: parsedEnvironment.FILTER_BASE_ITAPIPOCA_OWN_PREFIX,
        partnerPrefix: parsedEnvironment.FILTER_BASE_ITAPIPOCA_PARTNER_PREFIX,
      },
      Trairi: {
        ownPrefix: parsedEnvironment.FILTER_BASE_TRAIRI_OWN_PREFIX,
        partnerPrefix: parsedEnvironment.FILTER_BASE_TRAIRI_PARTNER_PREFIX,
      },
      Acarau: {
        ownPrefix: parsedEnvironment.FILTER_BASE_ACARAU_OWN_PREFIX,
        partnerPrefix: parsedEnvironment.FILTER_BASE_ACARAU_PARTNER_PREFIX,
      },
    },
    extraTeamTags: parseCsvList(parsedEnvironment.TAGS_EQUIPES_EXTRAS),
  },
} as const;

export type Environment = typeof environment;