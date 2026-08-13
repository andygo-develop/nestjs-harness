/**
 * Synchronises the official NestJS documentation.
 *
 * Source of truth is the nestjs/docs.nestjs.com repository — the source for
 * docs.nestjs.com — which keeps Markdown under `content/**\/*.md` with no
 * per-language subdirectory (the site is English-only). Unlike frameworks
 * that publish a single living branch per major line, upstream cuts a frozen
 * snapshot branch once a major ships (`10.0.0`, `11.0.0`, …) and that branch
 * never moves again. `docsLine` (see `../../cli/nestjs/version.ts`) is
 * therefore a real branch name, not a synthetic label — `master` only
 * appears as a stopgap for a major newer than any frozen branch we know
 * about yet.
 *
 * Sync is cheap when nothing changed: we ask the GitHub API for the branch
 * head SHA first and skip the download entirely if it matches what we already
 * have. Only on a real change do we pull the branch tarball — one request
 * rather than hundreds of per-file fetches.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

import { HarnessError } from '../../errors.js';
import { logger } from '../../logger.js';

export const DEFAULT_REPOSITORY = 'nestjs/docs.nestjs.com';
const USER_AGENT = 'nestjs-harness';

/**
 * Request headers, authenticated when the environment offers a token.
 *
 * Unauthenticated GitHub API requests are rate-limited per IP, which a shared
 * office address or CI runner burns through quickly — and the rate-limit error
 * below tells people to set `GITHUB_TOKEN`, so the token has to actually be
 * sent. `GH_TOKEN` is accepted too, since that is what `gh` writes.
 *
 * The token is read at call time rather than at module load so a shell that
 * exports it mid-session does not need a restart, and it is only ever sent to
 * github.com hosts.
 */
function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    'User-Agent': USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export interface ManualMeta {
  framework: 'nestjs';
  /** Project version this corpus serves, e.g. "11.1". */
  version: string;
  /** Documentation branch, e.g. "11.0.0" or "10.0.0". */
  docsLine: string;
  /**
   * Language of the synced corpus. Always "en" today — docs.nestjs.com has
   * no translated mirror — but kept as a real field rather than hardcoded
   * inline, since it is threaded through config, search and the MCP tools
   * the same way a genuinely multi-language corpus would need.
   */
  lang: string;
  source: string;
  branch: string;
  commit: string;
  syncedAt: string;
  fileCount: number;
}

export interface SyncResult {
  docsLine: string;
  lang: string;
  /** False when the remote head already matched what we had on disk. */
  changed: boolean;
  commit: string;
  previousCommit?: string;
  fileCount: number;
  meta: ManualMeta;
}

/**
 * Validates a tar entry and maps it to its destination path.
 *
 * Downloaded archives are untrusted. An entry is accepted only when it is a
 * regular Markdown file inside `<root>/content/`, with no absolute path and
 * no `..` segment anywhere. Anything else — symlinks, hardlinks, paths
 * escaping the target directory — is rejected outright.
 *
 * Returns the path relative to the content directory, or undefined to skip.
 */
export function safeDocPath(entryPath: string): string | undefined {
  const normalised = entryPath.replace(/\\/g, '/');

  if (normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) {
    return undefined;
  }
  if (normalised.split('/').some((segment) => segment === '..')) {
    return undefined;
  }

  // <repo>-<branch>/content/<rest>.md
  const match = /^[^/]+\/content\/(.+)$/.exec(normalised);
  if (!match) {
    return undefined;
  }

  const relative = match[1]!;
  if (!relative.endsWith('.md') || relative.includes('\0')) {
    return undefined;
  }

  return relative;
}

/** Asserts that `target` stays inside `root` once resolved. */
export function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new HarnessError('Refusing to write documentation outside the manuals directory.', {
      hint: `Blocked path:\n\n  ${resolvedTarget}`,
    });
  }
}

async function githubJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: githubHeaders({ Accept: 'application/vnd.github+json' }),
    });
  } catch (cause) {
    throw new HarnessError(`Could not reach GitHub at ${url}`, {
      hint: 'Check your network connection or proxy settings, then try again.',
      cause,
    });
  }

  if (response.status === 403 || response.status === 429) {
    throw new HarnessError('GitHub rate limit reached while checking for documentation updates.', {
      hint:
        'Wait a few minutes and try again, or set GITHUB_TOKEN (or GH_TOKEN) in your\n' +
        'environment — an authenticated request gets a far higher rate limit.',
    });
  }
  if (response.status === 404) {
    throw new HarnessError(`Documentation branch not found: ${url}`, {
      hint: 'Run `nestjs-harness manuals versions` to see the available documentation lines.',
    });
  }
  if (!response.ok) {
    throw new HarnessError(`GitHub returned HTTP ${response.status} for ${url}`);
  }

  return (await response.json()) as T;
}

/** Head commit SHA of a documentation branch. */
export async function fetchHeadCommit(repository: string, branch: string): Promise<string> {
  const data = await githubJson<{ sha?: string }>(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`,
  );
  if (!data.sha) {
    throw new HarnessError(`GitHub did not return a commit for ${repository}@${branch}.`);
  }
  return data.sha;
}

async function downloadTarball(repository: string, branch: string, destination: string): Promise<void> {
  const url = `https://codeload.github.com/${repository}/tar.gz/refs/heads/${encodeURIComponent(branch)}`;
  logger.debug(`Downloading ${url}`);

  let response: Response;
  try {
    response = await fetch(url, { headers: githubHeaders() });
  } catch (cause) {
    throw new HarnessError(`Could not download documentation from ${url}`, {
      hint: 'Check your network connection or proxy settings, then try again.',
      cause,
    });
  }

  if (!response.ok || !response.body) {
    throw new HarnessError(`Failed to download documentation (HTTP ${response.status}).`, {
      hint: `Source: ${url}`,
    });
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destination));
}

/**
 * Extracts the Markdown out of a branch tarball. Returns the number of files
 * written.
 */
export async function extractDocsTarball(tarball: string, targetDir: string): Promise<number> {
  await mkdir(targetDir, { recursive: true });
  let fileCount = 0;

  await tar.x({
    file: tarball,
    cwd: targetDir,
    // Drop "<repo>-<branch>/content" so files land at the corpus root.
    strip: 2,
    filter: (entryPath, entry) => {
      // tar types this as `Stats | ReadEntry` because the option is shared with
      // create mode; during extraction it is always a ReadEntry. Only regular
      // files are accepted — symlinks and hardlinks are rejected outright.
      const isRegularFile = 'type' in entry ? entry.type === 'File' : entry.isFile();
      if (!isRegularFile) {
        return false;
      }
      const relative = safeDocPath(entryPath);
      if (!relative) {
        return false;
      }
      assertInside(targetDir, path.join(targetDir, relative));
      fileCount += 1;
      return true;
    },
  });

  if (fileCount === 0) {
    throw new HarnessError('The documentation archive contained no Markdown files under content/.', {
      hint: 'The upstream layout may have changed. Please report this at https://github.com/nestjs/docs.nestjs.com',
    });
  }

  return fileCount;
}

export async function readManualMeta(metaFile: string): Promise<ManualMeta | undefined> {
  try {
    return JSON.parse(await readFile(metaFile, 'utf8')) as ManualMeta;
  } catch {
    return undefined;
  }
}

export interface SyncOptions {
  docsLine: string;
  lang: string;
  version: string;
  repository?: string;
  manualDir: string;
  metaFile: string;
  cacheDir: string;
  /** Re-download even when the remote head matches the local copy. */
  force?: boolean;
}

export async function syncManuals(options: SyncOptions): Promise<SyncResult> {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const branch = options.docsLine;
  const existing = await readManualMeta(options.metaFile);

  logger.debug(`Checking ${repository}@${branch} for updates`);
  const commit = await fetchHeadCommit(repository, branch);

  if (!options.force && existing?.commit === commit && existing.lang === options.lang) {
    return {
      docsLine: options.docsLine,
      lang: options.lang,
      changed: false,
      commit,
      previousCommit: existing.commit,
      fileCount: existing.fileCount,
      meta: existing,
    };
  }

  const tarball = path.join(options.cacheDir, `docs-${branch}-${commit.slice(0, 12)}.tar.gz`);
  await downloadTarball(repository, branch, tarball);

  // Extract to a staging directory and swap, so a failed sync leaves the
  // previous corpus intact and files deleted upstream disappear locally.
  const staging = `${options.manualDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });

  let fileCount: number;
  try {
    fileCount = await extractDocsTarball(tarball, staging);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  await rm(options.manualDir, { recursive: true, force: true });
  await mkdir(path.dirname(options.manualDir), { recursive: true });
  await rename(staging, options.manualDir);
  await rm(tarball, { force: true });

  const meta: ManualMeta = {
    framework: 'nestjs',
    version: options.version,
    docsLine: options.docsLine,
    lang: options.lang,
    source: `https://github.com/${repository}/tree/${branch}/content`,
    branch,
    commit,
    syncedAt: new Date().toISOString(),
    fileCount,
  };

  await writeFile(options.metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return {
    docsLine: options.docsLine,
    lang: options.lang,
    changed: true,
    commit,
    previousCommit: existing?.commit,
    fileCount,
    meta,
  };
}
