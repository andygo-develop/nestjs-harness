import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { harnessPaths } from '../cli/nestjs/project.js';
import { buildVersion } from '../cli/nestjs/version.js';
import { ensureConfig, loadConfig, requireConfig, resetConfigCache, updateConfig } from '../generators/config-generator/config.js';
import { CURRENT_CONFIG_VERSION } from '../generators/config-generator/schema.js';
import { cleanupTempDirs, makeProject } from './helpers.js';

const v111 = buildVersion({ major: 11, minor: 1 }, 'package-lock.json', '11.1.29');

afterEach(cleanupTempDirs);

describe('configuration', () => {
  it('creates a config with the expected shape', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    const { config, created } = await ensureConfig(root, v111);

    expect(created).toBe(true);
    expect(config).toMatchObject({
      configVersion: CURRENT_CONFIG_VERSION,
      nestjs: { version: '11.1', exactVersion: '11.1.29', docsLine: '11.0.0' },
      manuals: { source: 'official', language: 'en' },
      index: { engine: 'sqlite', searchStrategy: 'bm25' },
      mcp: { transport: 'stdio' },
    });
  });

  it('is idempotent — a second ensure creates nothing', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    await ensureConfig(root, v111);
    resetConfigCache();

    const second = await ensureConfig(root, v111);
    expect(second.created).toBe(false);
    expect(second.versionChanged).toBe(false);
  });

  it('updates the stored version when the project upgrades', async () => {
    const root = await makeProject({ constraint: '^10.4.0' });
    await ensureConfig(root, buildVersion({ major: 10, minor: 4 }, 'package.json'));
    resetConfigCache();

    const upgraded = await ensureConfig(root, v111);
    expect(upgraded.versionChanged).toBe(true);
    expect(upgraded.config.nestjs).toMatchObject({ version: '11.1', docsLine: '11.0.0' });
  });

  it('preserves user edits to unrelated fields across a version change', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    await ensureConfig(root, v111);
    await updateConfig(root, (config) => ({
      ...config,
      mcp: { ...config.mcp, serverName: 'my-nestjs-docs' },
    }));
    resetConfigCache();

    const { config } = await ensureConfig(root, buildVersion({ major: 11, minor: 2 }, 'package.json'));
    expect(config.mcp.serverName).toBe('my-nestjs-docs');
    expect(config.nestjs.version).toBe('11.2');
  });

  it('preserves unknown top-level keys written by a newer harness', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    await ensureConfig(root, v111);

    const { configFile } = harnessPaths(root);
    const raw = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(configFile, JSON.stringify({ ...raw, futureFeature: { enabled: true } }, null, 2));
    resetConfigCache();

    await loadConfig(root);
    await updateConfig(root, (config) => config);

    const after = JSON.parse(await readFile(configFile, 'utf8'));
    expect(after.futureFeature).toEqual({ enabled: true });
  });

  it('returns undefined when the project is not initialised', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    expect(await loadConfig(root)).toBeUndefined();
  });

  it('tells the user to run setup when config is missing', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    await expect(requireConfig(root)).rejects.toMatchObject({
      hint: expect.stringContaining('nestjs-harness setup'),
    });
  });

  it('rejects a config written by a newer harness', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    await ensureConfig(root, v111);

    const { configFile } = harnessPaths(root);
    const raw = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(configFile, JSON.stringify({ ...raw, configVersion: 99 }));
    resetConfigCache();

    await expect(loadConfig(root)).rejects.toThrow(/newer version of nestjs-harness/);
  });

  it('reports malformed JSON actionably', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    await ensureConfig(root, v111);
    resetConfigCache();

    await writeFile(harnessPaths(root).configFile, '{ broken');
    await expect(loadConfig(root)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a config that is not an object', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    await ensureConfig(root, v111);
    resetConfigCache();

    await writeFile(harnessPaths(root).configFile, '[1,2,3]');
    await expect(loadConfig(root)).rejects.toThrow(/must contain a JSON object/);
  });
});
