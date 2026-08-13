/**
 * The core guarantee: a project is served documentation for its own NestJS
 * major version, or an explicit error — never another version's docs.
 */
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { harnessPaths } from '../cli/nestjs/project.js';
import { loadContext } from '../cli/context.js';
import { requireConfig, resetConfigCache } from '../generators/config-generator/config.js';
import { openCorpus } from '../rags/manuals/corpus.js';
import { createMcpContext } from '../mcp/context.js';
import { runSearchTool } from '../mcp/tools/search-manual.js';
import { cleanupTempDirs, makeIndexedProject } from './helpers.js';

afterEach(cleanupTempDirs);

async function open(root: string, versionOverride?: string) {
  const config = await requireConfig(root);
  return openCorpus({ root, config, versionOverride });
}

describe('corpus resolution', () => {
  it('opens the corpus matching the project version', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    const corpus = await open(root);

    try {
      expect(corpus.docsLine).toBe('11.0.0');
      expect(corpus.projectVersion).toBe('11.1');
      expect(corpus.documentCount).toBeGreaterThan(0);
    } finally {
      corpus.close();
    }
  });

  it('errors when the index file does not exist at all', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await rm(harnessPaths(root).indexFile, { force: true });

    await expect(open(root)).rejects.toMatchObject({
      message: expect.stringContaining('index is missing'),
      hint: expect.stringContaining('nestjs-harness manuals update'),
    });
  });

  it('refuses to fall back to another major version', async () => {
    // The project is on 10.4, but only 11.0.0 documentation has been indexed.
    const { root } = await makeIndexedProject({ constraint: '^10.4.0', versions: ['11.0.0'] });

    await expect(open(root)).rejects.toMatchObject({
      message: expect.stringContaining('NestJS 10.4 documentation has not been synchronized'),
    });
  });

  it('names the other indexed versions but states they will not be used', async () => {
    const { root } = await makeIndexedProject({ constraint: '^10.4.0', versions: ['11.0.0'] });

    await expect(open(root)).rejects.toMatchObject({
      hint: expect.stringContaining('will not be used'),
    });
    await expect(open(root)).rejects.toMatchObject({
      hint: expect.stringContaining('nestjs-11.0.0'),
    });
  });

  it('tells the user exactly which commands to run', async () => {
    const { root } = await makeIndexedProject({ constraint: '^10.4.0', versions: ['11.0.0'] });

    await expect(open(root)).rejects.toMatchObject({
      hint: expect.stringContaining('nestjs-harness manuals sync'),
    });
  });

  it('honours an explicit --version override when that corpus is indexed', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0', versions: ['11.0.0', '10.0.0'] });
    const corpus = await open(root, '10');

    try {
      expect(corpus.docsLine).toBe('10.0.0');
    } finally {
      corpus.close();
    }
  });

  it('still refuses an explicit override for a version that is not indexed', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0', versions: ['11.0.0'] });

    await expect(open(root, '10')).rejects.toThrow(/has not been synchronized/);
  });

  it('rejects a nonsensical version override', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await expect(open(root, 'banana')).rejects.toThrow(/Could not understand NestJS version/);
  });

  it('rejects a version with no published documentation', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await expect(open(root, '5')).rejects.toThrow(/No NestJS documentation is available/);
  });
});

/**
 * Regression: the stored config caches a detected version, so it goes stale as
 * soon as someone bumps @nestjs/core. Before this was fixed, a project
 * upgraded from 11.1 to 12.0 kept being served 11.x documentation, labelled as
 * though it were correct.
 */
describe('config drift after a NestJS upgrade', () => {
  /** Rewrites package.json to a new range, leaving the config stale. */
  async function upgradeProject(root: string, constraint: string): Promise<void> {
    const { writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'acme-blog', dependencies: { '@nestjs/core': constraint } }, null, 2),
    );
    await rm(join(root, 'package-lock.json'), { force: true });
    resetConfigCache();
  }

  it('refuses to serve the old corpus after a major upgrade', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await upgradeProject(root, '^12.0.0');

    await expect(loadContext(root)).rejects.toMatchObject({
      message: expect.stringContaining('This project is now NestJS 12.0'),
      hint: expect.stringContaining('Refusing to use NestJS 11.0.0 documentation'),
    });
  });

  it('tells the user to re-run setup', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await upgradeProject(root, '^12.0.0');

    await expect(loadContext(root)).rejects.toMatchObject({
      hint: expect.stringContaining('nestjs-harness setup'),
    });
  });

  it('blocks the MCP tools too, rather than answering from the old corpus', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await upgradeProject(root, '^12.0.0');

    const result = await runSearchTool(createMcpContext(root), { query: 'guards' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('This project is now NestJS 12.0');
    expect(result.content[0]!.text).not.toContain('docs.nestjs.com');
  });

  it('also blocks a downgrade to an older major', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await upgradeProject(root, '^10.4.0');

    await expect(loadContext(root)).rejects.toThrow(/now NestJS 10.4/);
  });

  it('accepts a minor upgrade and refreshes the recorded version', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await upgradeProject(root, '^11.2.0');

    const context = await loadContext(root);
    expect(context.config.nestjs.version).toBe('11.2');
    expect(context.config.nestjs.docsLine).toBe('11.0.0');

    // The refreshed version is persisted, not just returned.
    resetConfigCache();
    expect((await requireConfig(root)).nestjs.version).toBe('11.2');
  });

  it('lets a minor upgrade keep searching normally', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    await upgradeProject(root, '^11.2.0');

    const result = await runSearchTool(createMcpContext(root), { query: 'guards' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ version: '11.0.0', projectVersion: '11.2' });
  });
});
