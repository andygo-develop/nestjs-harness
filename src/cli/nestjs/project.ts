/**
 * Locating and describing the NestJS project we are operating on.
 */
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import { notANestJsProject } from '../../errors.js';
import { detectNestJsVersion } from './detect-version.js';
import type { NestJsVersion } from './version.js';

export const HARNESS_DIR = '.nestjs-harness';

export interface NestJsProject {
  /** Absolute path to the project root (the directory holding package.json). */
  root: string;
  /** Absolute path to `<root>/.nestjs-harness`. */
  harnessDir: string;
  version: NestJsVersion;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walks upward looking for a project root, preferring a directory that already
 * has a harness directory, then falling back to the nearest package.json.
 * This lets commands run from a subdirectory of the project.
 */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string | undefined> {
  let current = path.resolve(startDir);
  let packageRoot: string | undefined;

  for (;;) {
    if (await isDirectory(path.join(current, HARNESS_DIR))) {
      return current;
    }
    if (!packageRoot && (await exists(path.join(current, 'package.json')))) {
      packageRoot = current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return packageRoot;
}

/**
 * Resolves the NestJS project for the current directory.
 * Throws an actionable error when this is not a NestJS project.
 */
export async function requireNestJsProject(startDir: string = process.cwd()): Promise<NestJsProject> {
  const root = await findProjectRoot(startDir);
  if (!root) {
    throw notANestJsProject(path.resolve(startDir));
  }

  const version = await detectNestJsVersion(root);
  if (!version) {
    throw notANestJsProject(root);
  }

  return { root, harnessDir: path.join(root, HARNESS_DIR), version };
}

/** Standard paths inside the harness directory. */
export function harnessPaths(root: string) {
  const harnessDir = path.join(root, HARNESS_DIR);
  return {
    harnessDir,
    configFile: path.join(harnessDir, 'config.json'),
    manualsDir: path.join(harnessDir, 'manuals'),
    indexDir: path.join(harnessDir, 'index'),
    indexFile: path.join(harnessDir, 'index', 'docs.sqlite'),
    cacheDir: path.join(harnessDir, 'cache'),
    /** Where a given documentation line is stored, e.g. manuals/nestjs-11.0.0. */
    manualDir: (docsLine: string) => path.join(harnessDir, 'manuals', `nestjs-${docsLine}`),
    manualMetaFile: (docsLine: string) =>
      path.join(harnessDir, 'manuals', `nestjs-${docsLine}`, '.meta.json'),
  };
}

export type HarnessPaths = ReturnType<typeof harnessPaths>;
