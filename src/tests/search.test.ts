import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { harnessPaths } from '../cli/nestjs/project.js';
import { indexManuals } from '../rags/manuals/indexer.js';
import { ManualRepository } from '../rags/manuals/repository.js';
import { buildMatchExpression, searchManuals, tokenizeQuery } from '../rags/manuals/search.js';
import { cleanupTempDirs, makeIndexedProject } from './helpers.js';

afterEach(cleanupTempDirs);

describe('query tokenization', () => {
  it('splits a natural language query', () => {
    expect(tokenizeQuery('authorization guard')).toEqual(['authorization', 'guard']);
  });

  it('splits a scoped package name on separators', () => {
    expect(tokenizeQuery('@nestjs/common')).toEqual(['nestjs', 'common']);
  });

  it('drops call parentheses from a method name', () => {
    expect(tokenizeQuery('canActivate()')).toEqual(['canActivate']);
  });

  it('handles operator characters that would break raw FTS5 syntax', () => {
    expect(tokenizeQuery('this.usersService.find()')).toEqual(['this', 'usersService', 'find']);
    expect(tokenizeQuery('a OR b AND (c NOT d)')).toEqual(['a', 'OR', 'b', 'AND', 'c', 'NOT', 'd']);
  });

  it('keeps quoted phrases together', () => {
    expect(tokenizeQuery('"authorization guard" ordering')).toEqual(['authorization guard', 'ordering']);
  });

  it('returns nothing for a query with no usable characters', () => {
    expect(tokenizeQuery('!!! ???')).toEqual([]);
  });

  it('quotes every term so operators are never interpreted', () => {
    expect(buildMatchExpression(['a', 'OR', 'b'])).toBe('"a" AND "OR" AND "b"');
  });

  it('escapes embedded double quotes', () => {
    expect(buildMatchExpression(['say"hi'])).toBe('"say""hi"');
  });
});

describe('search', () => {
  let root: string;
  let repository: ManualRepository;

  beforeEach(async () => {
    ({ root } = await makeIndexedProject({ constraint: '^11.1.0' }));
    repository = ManualRepository.open(harnessPaths(root).indexFile);
  });

  afterEach(() => repository.close());

  const search = (query: string, limit = 5) =>
    searchManuals({ repository, docsLine: '11.0.0', lang: 'en', query, limit });

  it('finds documents for a natural language query', async () => {
    const { hits } = await search('authorization guard');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe('Guards');
  });

  it('finds an exact NestJS class name', async () => {
    const { hits } = await search('Repository');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((hit) => hit.title)).toContain('Database');
  });

  it('finds a method name written as a call', async () => {
    const { hits } = await search('canActivate()');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe('Guards');
  });

  it('does not throw on queries full of FTS5 operator characters', async () => {
    for (const query of ['find()', 'this.usersService', 'a AND (b OR c)', '@InjectRepository(User)', '"']) {
      await expect(search(query)).resolves.not.toThrow();
    }
  });

  it('ranks a title match above an incidental mention', async () => {
    const { hits } = await search('guards');
    expect(hits[0]!.title).toBe('Guards');
  });

  it('returns scores in ascending bm25 order (best first)', async () => {
    const { hits } = await search('guards');
    const scores = hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });

  it('respects the limit', async () => {
    expect((await search('the', 2)).hits.length).toBeLessThanOrEqual(2);
  });

  it('widens from all-terms to any-term when nothing matches everything', async () => {
    const strict = await search('guards nonexistentterm');
    expect(strict.strategy).toBe('any-term');
    expect(strict.hits.length).toBeGreaterThan(0);
  });

  it('falls back to prefix matching for a partial word', async () => {
    const outcome = await search('guar');
    expect(outcome.strategy).toBe('prefix');
    expect(outcome.hits.length).toBeGreaterThan(0);
  });

  it('reports no results for a query that matches nothing', async () => {
    const outcome = await search('zzzznotpresentanywhere');
    expect(outcome.hits).toEqual([]);
    expect(outcome.strategy).toBe('none');
  });

  it('returns an empty result for an unusable query rather than throwing', async () => {
    expect((await search('!!!')).hits).toEqual([]);
  });

  it('includes a snippet and full metadata on each hit', async () => {
    const [hit] = (await search('authorization guard')).hits;
    expect(hit).toMatchObject({
      docsLine: '11.0.0',
      lang: 'en',
      section: 'Guards',
    });
    expect(hit!.url).toContain('docs.nestjs.com/guards');
    expect(hit!.snippet.length).toBeGreaterThan(0);
  });
});

describe('version isolation', () => {
  it('never returns documents from another major version', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0', versions: ['11.0.0', '10.0.0'] });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);

    try {
      // Both corpora are indexed and contain the same fixture content.
      expect(repository.countDocuments('11.0.0', 'en')).toBeGreaterThan(0);
      expect(repository.countDocuments('10.0.0', 'en')).toBeGreaterThan(0);

      const { hits } = await searchManuals({
        repository,
        docsLine: '11.0.0',
        lang: 'en',
        query: 'guards',
        limit: 20,
      });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.docsLine === '11.0.0')).toBe(true);
      expect(hits.every((hit) => hit.url.startsWith('https://docs.nestjs.com/'))).toBe(true);
    } finally {
      repository.close();
    }
  });

  it('keeps identical content in separate corpora under distinct ids', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0', versions: ['11.0.0', '10.0.0'] });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);

    try {
      expect(repository.getDocument('11.0.0:en:guards.md#authorization-guard')).toBeDefined();
      expect(repository.getDocument('10.0.0:en:guards.md#authorization-guard')).toBeDefined();
    } finally {
      repository.close();
    }
  });
});

describe('incremental indexing', () => {
  /**
   * A page whose heading slugs collide used to produce two chunks with one id,
   * and the resulting primary-key violation did not skip that page — it threw
   * out of `indexManuals` and left the entire corpus unindexed.
   */
  it('indexes a page whose headings resolve to colliding anchors', async () => {
    const { root } = await makeIndexedProject({
      constraint: '^11.1.0',
      docs: {
        'guards.md':
          '---\ntitle: "Guards"\n---\n\n# Guards\n\n## Usage\n\nFirst.\n\n## Usage 1\n\nSecond.\n\n## Usage\n\nThird.\n',
      },
    });

    const repository = ManualRepository.open(harnessPaths(root).indexFile);
    try {
      expect(repository.countDocuments('11.0.0', 'en')).toBe(3);
    } finally {
      repository.close();
    }
  });

  it('reports no work on an unchanged re-index', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    const paths = harnessPaths(root);
    const repository = ManualRepository.open(paths.indexFile);

    try {
      const result = await indexManuals({
        repository,
        manualDir: paths.manualDir('11.0.0'),
        docsLine: '11.0.0',
        lang: 'en',
      });

      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.unchanged).toBeGreaterThan(0);
    } finally {
      repository.close();
    }
  });

  it('updates only the chunks whose content changed', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    const paths = harnessPaths(root);

    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const target = join(paths.manualDir('11.0.0'), 'controllers.md');
    await writeFile(
      target,
      '---\ntitle: "Controllers"\n---\n\n# Controllers\n\nControllers handle incoming requests and return a response.\n\n## Thin Controllers\n\nCompletely rewritten guidance about thin controllers.\n',
      'utf8',
    );

    const repository = ManualRepository.open(paths.indexFile);
    try {
      const result = await indexManuals({
        repository,
        manualDir: paths.manualDir('11.0.0'),
        docsLine: '11.0.0',
        lang: 'en',
      });

      expect(result.updated).toBe(1);
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    } finally {
      repository.close();
    }
  });

  it('removes documents for files deleted upstream', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    const paths = harnessPaths(root);

    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(paths.manualDir('11.0.0'), 'controllers.md'));

    const repository = ManualRepository.open(paths.indexFile);
    try {
      const result = await indexManuals({
        repository,
        manualDir: paths.manualDir('11.0.0'),
        docsLine: '11.0.0',
        lang: 'en',
      });

      expect(result.removed).toBeGreaterThan(0);
      expect(repository.getDocument('11.0.0:en:controllers.md#thin-controllers')).toBeUndefined();
    } finally {
      repository.close();
    }
  });

  it('keeps the FTS index in step after an update, dropping superseded text', async () => {
    const { root } = await makeIndexedProject({ constraint: '^11.1.0' });
    const paths = harnessPaths(root);

    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const page = join(paths.manualDir('11.0.0'), 'controllers.md');
    const write = (body: string) =>
      writeFile(
        page,
        `---\ntitle: "Controllers"\n---\n\n# Controllers\n\nIntro.\n\n## Thin Controllers\n\n${body}\n`,
        'utf8',
      );
    const reindex = (repository: ManualRepository) =>
      indexManuals({ repository, manualDir: paths.manualDir('11.0.0'), docsLine: '11.0.0', lang: 'en' });
    const find = async (repository: ManualRepository, query: string) =>
      (await searchManuals({ repository, docsLine: '11.0.0', lang: 'en', query, limit: 5 })).hits;

    const repository = ManualRepository.open(paths.indexFile);
    try {
      await write('Contains originaluniquetoken here.');
      await reindex(repository);
      expect(await find(repository, 'originaluniquetoken')).toHaveLength(1);

      await write('Contains replacementuniquetoken here.');
      await reindex(repository);

      // The new text is searchable...
      expect(await find(repository, 'replacementuniquetoken')).toHaveLength(1);
      // ...and the superseded text is genuinely gone, not merely outranked.
      expect(await find(repository, 'originaluniquetoken')).toHaveLength(0);
    } finally {
      repository.close();
    }
  });
});
