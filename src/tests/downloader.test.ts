/**
 * Security-focused tests for the sync layer.
 *
 * Downloaded archives are untrusted input, so the extraction guard is the most
 * safety-critical code in the package.
 */
import { mkdir, readdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertInside,
  extractDocsTarball,
  fetchHeadCommit,
  readManualMeta,
  safeDocPath,
} from '../rags/manuals/downloader.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

afterEach(cleanupTempDirs);

describe('safeDocPath', () => {
  it('accepts a documentation file under content/', () => {
    expect(safeDocPath('docs.nestjs.com-11.0.0/content/techniques/sql.md')).toBe('techniques/sql.md');
  });

  it('accepts a root-level documentation file', () => {
    expect(safeDocPath('docs.nestjs.com-11.0.0/content/controllers.md')).toBe('controllers.md');
  });

  it('rejects files outside the content directory', () => {
    expect(safeDocPath('docs.nestjs.com-11.0.0/README.md')).toBeUndefined();
    expect(safeDocPath('docs.nestjs.com-11.0.0/.github/workflows/ci.yml')).toBeUndefined();
  });

  it('rejects non-Markdown files', () => {
    expect(safeDocPath('docs.nestjs.com-11.0.0/content/script.sh')).toBeUndefined();
    expect(safeDocPath('docs.nestjs.com-11.0.0/content/image.png')).toBeUndefined();
  });

  it.each([
    'docs.nestjs.com-11.0.0/content/../../../../etc/passwd.md',
    'docs.nestjs.com-11.0.0/content/../../escape.md',
    '../../../evil.md',
    'docs.nestjs.com-11.0.0/content/nested/../../../../evil.md',
  ])('rejects path traversal: %s', (entry) => {
    expect(safeDocPath(entry)).toBeUndefined();
  });

  it.each(['/etc/passwd.md', '/docs.nestjs.com-11.0.0/content/a.md', 'C:/Windows/system.md'])(
    'rejects absolute path: %s',
    (entry) => {
      expect(safeDocPath(entry)).toBeUndefined();
    },
  );

  it('rejects a path containing a null byte', () => {
    expect(safeDocPath('docs.nestjs.com-11.0.0/content/evil\0.md')).toBeUndefined();
  });

  it('normalises backslashes before validating', () => {
    expect(safeDocPath('docs.nestjs.com-11.0.0\\content\\..\\..\\evil.md')).toBeUndefined();
  });
});

describe('assertInside', () => {
  it('allows a path within the root', () => {
    expect(() => assertInside('/tmp/manuals', '/tmp/manuals/techniques/sql.md')).not.toThrow();
  });

  it('rejects a sibling directory that shares a prefix', () => {
    expect(() => assertInside('/tmp/manuals', '/tmp/manuals-evil/x.md')).toThrow();
  });

  it('rejects an escaping path', () => {
    expect(() => assertInside('/tmp/manuals', '/tmp/manuals/../../etc/passwd')).toThrow();
  });
});

describe('extractDocsTarball', () => {
  /** Builds a tarball shaped like a GitHub branch archive of docs.nestjs.com. */
  async function buildTarball(): Promise<{ tarball: string; target: string }> {
    const workspace = await makeTempDir('tarball-');
    const source = path.join(workspace, 'src');
    const root = path.join(source, 'docs.nestjs.com-11.0.0');

    await mkdir(path.join(root, 'content', 'techniques'), { recursive: true });

    await writeFile(path.join(root, 'content', 'controllers.md'), '# Controllers\n');
    await writeFile(path.join(root, 'content', 'techniques', 'sql.md'), '# SQL\n');
    await writeFile(path.join(root, 'README.md'), '# Repo readme\n');
    await writeFile(path.join(root, 'content', 'script.sh'), 'rm -rf /\n');
    await symlink('/etc/passwd', path.join(root, 'content', 'link.md'));

    const tarball = path.join(workspace, 'docs.tar.gz');
    await tar.c({ file: tarball, cwd: source, gzip: true }, ['docs.nestjs.com-11.0.0']);

    return { tarball, target: path.join(workspace, 'out') };
  }

  it('extracts only Markdown under content/, stripping the archive prefix', async () => {
    const { tarball, target } = await buildTarball();
    const count = await extractDocsTarball(tarball, target);

    expect(count).toBe(2);
    expect(await readdir(target)).toEqual(expect.arrayContaining(['controllers.md', 'techniques']));
    expect(await readdir(path.join(target, 'techniques'))).toEqual(['sql.md']);
  });

  it('does not extract non-Markdown files, symlinks or files outside content/', async () => {
    const { tarball, target } = await buildTarball();
    await extractDocsTarball(tarball, target);

    const entries = await readdir(target, { recursive: true });
    expect(entries).not.toContain('script.sh');
    expect(entries).not.toContain('link.md');
    expect(entries).not.toContain('README.md');
  });

  it('fails loudly when the archive has no Markdown files under content/', async () => {
    const workspace = await makeTempDir('tarball-empty-');
    const source = path.join(workspace, 'src');
    const root = path.join(source, 'docs.nestjs.com-11.0.0');
    await mkdir(path.join(root, 'content'), { recursive: true });
    await writeFile(path.join(root, 'content', 'not-markdown.txt'), 'nope\n');

    const tarball = path.join(workspace, 'docs.tar.gz');
    await tar.c({ file: tarball, cwd: source, gzip: true }, ['docs.nestjs.com-11.0.0']);

    await expect(extractDocsTarball(tarball, path.join(workspace, 'out'))).rejects.toThrow(
      /no Markdown files under content\//,
    );
  });
});

/**
 * `fetch` is stubbed rather than called: these assert which headers we *send*,
 * and the suite never reaches the network.
 */
describe('GitHub authentication', () => {
  const stubFetch = (): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sha: 'abc123' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends no Authorization header when no token is set', async () => {
    vi.stubEnv('GITHUB_TOKEN', undefined);
    vi.stubEnv('GH_TOKEN', undefined);
    const fetchMock = stubFetch();

    await fetchHeadCommit('nestjs/docs.nestjs.com', '11.0.0');

    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['User-Agent']).toBe('nestjs-harness');
  });

  /**
   * The rate-limit error tells people to set GITHUB_TOKEN, so it has to be a
   * hint that actually does something.
   */
  it.each(['GITHUB_TOKEN', 'GH_TOKEN'])('authenticates with %s when set', async (variable) => {
    vi.stubEnv('GITHUB_TOKEN', undefined);
    vi.stubEnv('GH_TOKEN', undefined);
    vi.stubEnv(variable, 'secret-token');
    const fetchMock = stubFetch();

    await fetchHeadCommit('nestjs/docs.nestjs.com', '11.0.0');

    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
  });
});

describe('readManualMeta', () => {
  it('returns undefined when there is no metadata file', async () => {
    const dir = await makeTempDir();
    expect(await readManualMeta(path.join(dir, '.meta.json'))).toBeUndefined();
  });

  it('reads metadata back', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.meta.json');
    await writeFile(file, JSON.stringify({ framework: 'nestjs', version: '11.1', commit: 'abc' }));

    expect(await readManualMeta(file)).toMatchObject({ framework: 'nestjs', version: '11.1' });
  });
});
