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
  SPOTFIRE_KEEP_OPEN: booleanFromEnvironment.optional(),
  SPOTFIRE_BROWSER_PATH: z.string().optional().default(''),
  SPOTFIRE_DEFAULT_REPORT_TITLE: z.string().default('Scanner 4.0 - CE'),
  SPOTFIRE_FILTER_PANEL_LABEL: z.string().default('Filters'),
  SPOTFIRE_EXPORT_MENU_LABEL: z.string().default('Export table'),
  SPOTFIRE_EXPORT_PARENT_MENU_LABEL: z.string().default('Export'),
  SPOTFIRE_OUTPUT_DIR: z.string().default('../../data'),
});

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
    keepOpen: parsedEnvironment.SPOTFIRE_KEEP_OPEN ?? !parsedEnvironment.SPOTFIRE_HEADLESS,
    browserPath: parsedEnvironment.SPOTFIRE_BROWSER_PATH,
    defaultReportTitle: parsedEnvironment.SPOTFIRE_DEFAULT_REPORT_TITLE,
    filterPanelLabel: parsedEnvironment.SPOTFIRE_FILTER_PANEL_LABEL,
    exportMenuLabel: parsedEnvironment.SPOTFIRE_EXPORT_MENU_LABEL,
    exportParentMenuLabel: parsedEnvironment.SPOTFIRE_EXPORT_PARENT_MENU_LABEL,
    outputDirectory: parsedEnvironment.SPOTFIRE_OUTPUT_DIR,
  },
} as const;

export type Environment = typeof environment;