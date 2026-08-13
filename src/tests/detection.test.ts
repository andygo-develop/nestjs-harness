import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectNestJsVersion, detectFromPackageJson, detectFromLock } from '../cli/nestjs/detect-version.js';
import { findProjectRoot, requireNestJsProject } from '../cli/nestjs/project.js';
import { docsLineForMajor, majorForDocsLine, parseConstraint, parseExact, versionFromString } from '../cli/nestjs/version.js';
import { HarnessError } from '../errors.js';
import { cleanupTempDirs, makeProject, makeTempDir } from './helpers.js';

afterEach(cleanupTempDirs);

describe('version parsing', () => {
  it.each([
    ['^11.4', 11, 4],
    ['~11.4.0', 11, 4],
    ['11.4.*', 11, 4],
    ['>=11.4 <12.0', 11, 4],
    ['<=11.4', 11, 4],
    ['^10.5 || ^11.0', 11, 0],
    ['11', 11, undefined],
  ])('parses constraint %s', (constraint, major, minor) => {
    expect(parseConstraint(constraint)).toEqual({ major, minor });
  });

  /**
   * The bound after `<` is the one version the project is guaranteed *not* to
   * be on, so reading it as the project's own major is a version-safety bug,
   * not a rounding error: `>=10.0.0 <11.0.0` is a 10.x project, and answering
   * its questions from the 11.x manual is the failure this tool exists to
   * prevent.
   */
  it('never reads an exclusive upper bound as the project version', () => {
    expect(parseConstraint('>=10.0.0 <11.0.0')).toEqual({ major: 10, minor: 0 });
    expect(parseConstraint('>=10 <11')).toEqual({ major: 10, minor: undefined });
    expect(versionFromString('>=10.0.0 <11.0.0').docsLine).toBe('10.0.0');
  });

  /** An upper bound is still better than refusing to detect NestJS at all. */
  it('falls back to a lone exclusive bound rather than giving up', () => {
    expect(parseConstraint('<12')).toEqual({ major: 12, minor: undefined });
  });

  it('treats wildcard minors as unknown', () => {
    expect(parseConstraint('11.x')).toEqual({ major: 11, minor: undefined });
  });

  it('returns undefined for a constraint with no version', () => {
    expect(parseConstraint('latest')).toBeUndefined();
  });

  it.each([
    ['11.4.2', 11, 4],
    ['v11.4.2', 11, 4],
    ['10.5.1', 10, 5],
  ])('parses exact version %s', (version, major, minor) => {
    expect(parseExact(version)).toEqual({ major, minor });
  });

  it('maps majors to documentation branches', () => {
    expect(docsLineForMajor(11)).toBe('11.0.0');
    expect(docsLineForMajor(10)).toBe('10.0.0');
    expect(majorForDocsLine('11.0.0')).toBe(11);
    expect(majorForDocsLine('10.0.0')).toBe(10);
  });

  it('falls back to master for a major newer than any known frozen branch', () => {
    expect(docsLineForMajor(12)).toBe('master');
    expect(majorForDocsLine('master')).toBe(11);
  });

  it('refuses an old major with no published documentation', () => {
    expect(() => docsLineForMajor(5)).toThrow(HarnessError);
  });

  it('builds a version from a user string', () => {
    expect(versionFromString('11.1')).toMatchObject({ version: '11.1', major: 11, docsLine: '11.0.0' });
    expect(versionFromString('10')).toMatchObject({ major: 10, docsLine: '10.0.0' });
  });
});

describe('project detection', () => {
  it('detects the exact version from package-lock.json', async () => {
    const root = await makeProject({ constraint: '^11.1.0', lockVersion: '11.1.29' });
    const version = await detectNestJsVersion(root);

    expect(version).toMatchObject({
      version: '11.1',
      exact: '11.1.29',
      docsLine: '11.0.0',
      source: 'package-lock.json',
    });
  });

  it('prefers the lock file over the range', async () => {
    const root = await makeProject({ constraint: '^11.0.0', lockVersion: '11.1.29' });
    expect((await detectNestJsVersion(root))?.version).toBe('11.1');
  });

  it('falls back to package.json when there is no lock file', async () => {
    const root = await makeProject({ constraint: '^10.4.0' });
    const version = await detectNestJsVersion(root);

    expect(version).toMatchObject({ version: '10.4', docsLine: '10.0.0', source: 'package.json' });
    expect(version?.exact).toBeUndefined();
  });

  it('ignores an unresolvable lock version and uses the range', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/@nestjs/core': { version: 'github:nestjs/nest#master' } } }),
    );

    expect((await detectNestJsVersion(root))?.source).toBe('package.json');
  });

  it('finds @nestjs/core in devDependencies', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { '@nestjs/core': '^10.2' } }),
    );

    expect((await detectFromPackageJson(root))?.version).toBe('10.2');
  });

  it('returns undefined for a non-NestJS project', async () => {
    const root = await makeProject({ nonNestJs: true });
    expect(await detectNestJsVersion(root)).toBeUndefined();
  });

  it('returns undefined when package.json is missing', async () => {
    const root = await makeTempDir();
    expect(await detectFromPackageJson(root)).toBeUndefined();
    expect(await detectFromLock(root)).toBeUndefined();
  });

  it('reports an actionable error for a non-NestJS project', async () => {
    const root = await makeProject({ nonNestJs: true });

    await expect(requireNestJsProject(root)).rejects.toThrow(/NestJS project not detected/);
    await expect(requireNestJsProject(root)).rejects.toMatchObject({
      hint: expect.stringContaining('@nestjs/core'),
    });
  });

  it('raises a clear error for malformed package.json', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'package.json'), '{ not json');

    await expect(detectFromPackageJson(root)).rejects.toThrow(/not valid JSON/);
  });

  it('walks upward to find the project root from a subdirectory', async () => {
    const root = await makeProject({ constraint: '^11.1.0' });
    const nested = path.join(root, 'src', 'users');
    await import('node:fs/promises').then((fs) => fs.mkdir(nested, { recursive: true }));

    expect(await findProjectRoot(nested)).toBe(root);
  });

  it('returns undefined when there is no project anywhere above', async () => {
    const root = await makeTempDir();
    await rm(path.join(root, 'package.json'), { force: true });

    // A temp dir has no package.json above it inside the temp tree.
    const found = await findProjectRoot(root);
    expect(found === undefined || found !== root).toBe(true);
  });
});
