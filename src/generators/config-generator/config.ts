/**
 * Reading, writing and migrating `.nestjs-harness/config.json`.
 *
 * Writes are atomic (temp file + rename) so an interrupted run can never leave
 * a half-written config behind, and unknown top-level keys are preserved so a
 * config written by a newer harness is not silently stripped by an older one.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { HarnessError, notInitialised } from '../../errors.js';
import { harnessPaths } from '../../cli/nestjs/project.js';
import type { NestJsVersion } from '../../cli/nestjs/version.js';
import { CURRENT_CONFIG_VERSION, configSchema, defaultConfig, type HarnessConfig } from './schema.js';

/** Unknown keys read from disk, kept so we can write them back untouched. */
const rawByRoot = new Map<string, Record<string, unknown>>();

function migrate(raw: Record<string, unknown>, file: string): Record<string, unknown> {
  const found = raw.configVersion;
  const version = typeof found === 'number' ? found : CURRENT_CONFIG_VERSION;

  if (version > CURRENT_CONFIG_VERSION) {
    throw new HarnessError(
      `${file} was written by a newer version of nestjs-harness (configVersion ${version}).`,
      { hint: 'Upgrade with:\n\n  npm install -g nestjs-harness@latest' },
    );
  }

  // Future migrations chain here, e.g. `if (version < 2) { ...; version = 2 }`.
  return { ...raw, configVersion: CURRENT_CONFIG_VERSION };
}

/** Loads config, or undefined when the project has not been initialised. */
export async function loadConfig(root: string): Promise<HarnessConfig | undefined> {
  const { configFile } = harnessPaths(root);

  let text: string;
  try {
    text = await readFile(configFile, 'utf8');
  } catch {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new HarnessError('.nestjs-harness/config.json is not valid JSON.', {
      hint: `Fix it, or delete it and re-run:\n\n  nestjs-harness init\n\nFile: ${configFile}`,
      cause,
    });
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HarnessError('.nestjs-harness/config.json must contain a JSON object.', {
      hint: `Delete it and re-run:\n\n  nestjs-harness init\n\nFile: ${configFile}`,
    });
  }

  const migrated = migrate(raw as Record<string, unknown>, configFile);
  const parsed = configSchema.safeParse(migrated);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new HarnessError('.nestjs-harness/config.json is not valid.', {
      hint: `${issues}\n\nDelete it and re-run:\n\n  nestjs-harness init`,
    });
  }

  rawByRoot.set(path.resolve(root), migrated);
  return parsed.data;
}

/** Loads config or throws an actionable "not initialised" error. */
export async function requireConfig(root: string): Promise<HarnessConfig> {
  const config = await loadConfig(root);
  if (!config) {
    throw notInitialised();
  }
  return config;
}

export async function saveConfig(root: string, config: HarnessConfig): Promise<void> {
  const { harnessDir, configFile } = harnessPaths(root);
  await mkdir(harnessDir, { recursive: true });

  const previous = rawByRoot.get(path.resolve(root)) ?? {};
  const merged = { ...previous, ...config };

  const temp = `${configFile}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await rename(temp, configFile);

  rawByRoot.set(path.resolve(root), merged as Record<string, unknown>);
}

/**
 * Creates the config if absent, or updates the detected NestJS version if it
 * has changed. Never discards user edits to other fields — this is what makes
 * `init` safe to run repeatedly.
 */
export async function ensureConfig(
  root: string,
  version: NestJsVersion,
  options: {
    /** Coding agents to record, used only when the config is created. */
    targets?: readonly HarnessConfig['targets'][number][];
  } = {},
): Promise<{ config: HarnessConfig; created: boolean; versionChanged: boolean }> {
  const existing = await loadConfig(root);

  if (!existing) {
    const config = defaultConfig(
      {
        version: version.version,
        exactVersion: version.exact,
        docsLine: version.docsLine,
      },
      options.targets,
    );
    await saveConfig(root, config);
    return { config, created: true, versionChanged: false };
  }

  const versionChanged =
    existing.nestjs.version !== version.version ||
    existing.nestjs.docsLine !== version.docsLine ||
    existing.nestjs.exactVersion !== version.exact;

  if (!versionChanged) {
    return { config: existing, created: false, versionChanged: false };
  }

  const config: HarnessConfig = {
    ...existing,
    nestjs: {
      ...existing.nestjs,
      version: version.version,
      exactVersion: version.exact,
      docsLine: version.docsLine,
    },
  };
  await saveConfig(root, config);
  return { config, created: false, versionChanged: true };
}

/**
 * Reconciles stored configuration against the project's *current* NestJS
 * version, and is what every read path must call before trusting the config.
 *
 * The config records a detected version, so it goes stale the moment someone
 * bumps @nestjs/core. Without this check a project upgraded from 10.x to 11.x
 * would keep being served 10.x documentation — silently, and labelled as
 * though it were correct, which is precisely the failure this tool exists to
 * prevent.
 *
 * A changed minor is harmless (same corpus) and is refreshed in place. A
 * changed major line is refused outright.
 */
export async function reconcileConfig(
  root: string,
  detected: NestJsVersion,
  config: HarnessConfig,
): Promise<HarnessConfig> {
  if (config.nestjs.docsLine !== detected.docsLine) {
    throw new HarnessError(
      `This project is now NestJS ${detected.version}, but nestjs-harness is configured for ` +
        `NestJS ${config.nestjs.version} (nestjs-${config.nestjs.docsLine}).`,
      {
        hint:
          `Refusing to use NestJS ${config.nestjs.docsLine} documentation for a ` +
          `NestJS ${detected.docsLine} project.\n\n` +
          'Run:\n\n  nestjs-harness setup',
      },
    );
  }

  if (config.nestjs.version === detected.version && config.nestjs.exactVersion === detected.exact) {
    return config;
  }

  // Same documentation line — just keep the recorded version accurate.
  const next: HarnessConfig = {
    ...config,
    nestjs: {
      ...config.nestjs,
      version: detected.version,
      exactVersion: detected.exact,
      docsLine: detected.docsLine,
    },
  };
  await saveConfig(root, next);
  return next;
}

/** Applies a partial update and persists it. */
export async function updateConfig(
  root: string,
  mutate: (config: HarnessConfig) => HarnessConfig,
): Promise<HarnessConfig> {
  const current = await requireConfig(root);
  const next = mutate(structuredClone(current));
  await saveConfig(root, next);
  return next;
}

/** Test seam: forget cached raw config between runs. */
export function resetConfigCache(): void {
  rawByRoot.clear();
}
