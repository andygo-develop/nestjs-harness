import { describe, expect, it } from 'vitest';

import { hashContent, parsePage, sectionForPath, urlForPath } from '../rags/manuals/parser.js';
import { parseFrontMatter, slugify, splitFrontMatter, toExcerpt } from '../rags/manuals/normalizer.js';
import { FIXTURE_DOCS } from './helpers.js';

const parse = (path: string, source: string) =>
  parsePage({ docsLine: '11.0.0', lang: 'en', path, source });

describe('normalizer', () => {
  it('splits front matter from the body', () => {
    const { frontMatter, body } = splitFrontMatter('---\ntitle: "X"\n---\n# Heading\n');
    expect(frontMatter).toBe('title: "X"');
    expect(body).toBe('# Heading\n');
  });

  it('handles a document with no front matter', () => {
    const { frontMatter, body } = splitFrontMatter('# Heading\n');
    expect(frontMatter).toBeUndefined();
    expect(body).toBe('# Heading\n');
  });

  it('reads quoted and unquoted scalars', () => {
    const meta = parseFrontMatter('title: "Database"\ndescription: Plain text\nempty:');
    expect(meta).toEqual({ title: 'Database', description: 'Plain text' });
  });

  it.each([
    ['Database Queries', 'database-queries'],
    ['The `Repository` Class', 'the-repository-class'],
    ['canActivate()', 'canactivate'],
    ['ManyToMany Relations', 'manytomany-relations'],
  ])('slugifies %s', (heading, slug) => {
    expect(slugify(heading)).toBe(slug);
  });

  it('unwraps markdown escapes and emphasis in excerpts', () => {
    expect(toExcerpt('`class` \\\\**Repository**<Entity> provides access')).toContain('\\Repository<Entity>');
  });

  it('truncates long excerpts on a word boundary', () => {
    const excerpt = toExcerpt('word '.repeat(200), 50);
    expect(excerpt.length).toBeLessThanOrEqual(51);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('paths and urls', () => {
  it('derives a section label from the directory', () => {
    expect(sectionForPath('techniques/sql.md')).toBe('Techniques');
    expect(sectionForPath('recipes/prisma.md')).toBe('Recipes');
    expect(sectionForPath('graphql/resolvers.md')).toBe('GraphQL');
  });

  it('derives a section for a root-level page', () => {
    expect(sectionForPath('controllers.md')).toBe('Controllers');
  });

  it('builds the public docs.nestjs.com URL', () => {
    expect(urlForPath('11.0.0', 'en', 'techniques/sql.md')).toBe(
      'https://docs.nestjs.com/techniques/sql',
    );
  });

  it('appends the heading anchor', () => {
    expect(urlForPath('11.0.0', 'en', 'techniques/sql.md', 'creating-a-repository')).toBe(
      'https://docs.nestjs.com/techniques/sql#creating-a-repository',
    );
  });

  it('does not encode the docs line or language into the URL', () => {
    // docs.nestjs.com is a single current site, unlike a per-major book — the
    // same path always produces the same public URL regardless of which
    // frozen branch a chunk was synced from.
    expect(urlForPath('11.0.0', 'en', 'guards.md')).toBe(urlForPath('10.0.0', 'fr', 'guards.md'));
  });
});

describe('page parsing', () => {
  const chunks = parse('techniques/sql.md', FIXTURE_DOCS['techniques/sql.md']!);

  it('produces an intro chunk plus one per H2', () => {
    expect(chunks.map((chunk) => chunk.heading)).toEqual([
      undefined,
      'Creating a Repository',
      'Querying Rows',
    ]);
  });

  it('takes the title from front matter and applies it to every chunk', () => {
    expect(chunks.every((chunk) => chunk.title === 'Database')).toBe(true);
  });

  it('does not treat a # comment inside a code fence as a heading', () => {
    const creating = chunks.find((chunk) => chunk.heading === 'Creating a Repository')!;
    expect(creating.content).toContain('This hash must not be treated as a heading');
    expect(chunks.some((chunk) => chunk.heading?.includes('This hash'))).toBe(false);
  });

  it('generates stable, unique ids', () => {
    const ids = chunks.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[1]).toBe('11.0.0:en:techniques/sql.md#creating-a-repository');
    expect(ids[0]).toBe('11.0.0:en:techniques/sql.md#_intro');
  });

  it('is deterministic across runs', () => {
    const again = parse('techniques/sql.md', FIXTURE_DOCS['techniques/sql.md']!);
    expect(again.map((c) => [c.id, c.hash])).toEqual(chunks.map((c) => [c.id, c.hash]));
  });

  it('changes the hash when content changes, but keeps the id', () => {
    const edited = parse(
      'techniques/sql.md',
      FIXTURE_DOCS['techniques/sql.md']!.replace('repository-based interface', 'repository-driven interface'),
    );
    expect(edited[0]!.id).toBe(chunks[0]!.id);
    expect(edited[0]!.hash).not.toBe(chunks[0]!.hash);
  });

  it('carries version, section and url onto every chunk', () => {
    for (const chunk of chunks) {
      expect(chunk.docsLine).toBe('11.0.0');
      expect(chunk.section).toBe('Techniques');
      expect(chunk.url).toContain('docs.nestjs.com/techniques/sql');
    }
  });

  it('deduplicates anchors when headings repeat', () => {
    const repeated = parse('x/y.md', '# Page\n\n## Options\n\na\n\n## Options\n\nb\n');
    expect(repeated.map((chunk) => chunk.anchor)).toEqual(['options', 'options-1']);
  });

  it('falls back to the H1 when there is no front-matter title', () => {
    const [chunk] = parse('x/y.md', '# Fallback Title\n\nBody text.\n');
    expect(chunk!.title).toBe('Fallback Title');
  });

  it('falls back to the filename when there is no heading at all', () => {
    const [chunk] = parse('x/some-page.md', 'Just body text.\n');
    expect(chunk!.title).toBe('Some Page');
  });

  it('skips empty sections', () => {
    const parsed = parse('x/y.md', '# Page\n\n## Empty\n\n## Real\n\nContent.\n');
    expect(parsed.map((chunk) => chunk.heading)).toEqual(['Real']);
  });

  it('splits very large sections instead of emitting one huge chunk', () => {
    const huge = `# Page\n\n## Big\n\n${'paragraph text here.\n\n'.repeat(1200)}`;
    const parsed = parse('x/y.md', huge);
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed.every((chunk) => chunk.content.length <= 13_000)).toBe(true);
  });

  it('hashes content stably', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });

  it('suffixes repeated headings', () => {
    const parsed = parse('x/y.md', '# Page\n\n## Usage\n\nfirst.\n\n## Usage\n\nsecond.\n');
    expect(parsed.map((chunk) => chunk.anchor)).toEqual(['usage', 'usage-1']);
  });

  /**
   * `documents.id` is a primary key, so two chunks resolving to the same anchor
   * is not a cosmetic duplicate — the insert fails and aborts the whole index
   * run. "Usage" twice plus a literal "Usage 1" all want `usage-1`.
   */
  it('keeps anchors unique when a suffix collides with a real heading', () => {
    const parsed = parse(
      'x/y.md',
      '# Page\n\n## Usage\n\nfirst.\n\n## Usage 1\n\nsecond.\n\n## Usage\n\nthird.\n',
    );

    const anchors = parsed.map((chunk) => chunk.anchor);
    const ids = parsed.map((chunk) => chunk.id);

    expect(anchors).toEqual(['usage', 'usage-1', 'usage-2']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
