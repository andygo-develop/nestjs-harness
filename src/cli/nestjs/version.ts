/**
 * The NestJS version model.
 *
 * Unlike frameworks that publish a living documentation branch per major
 * line, `docs.nestjs.com` (nestjs/docs.nestjs.com) keeps one frozen snapshot
 * branch per major once that major has shipped — `10.0.0`, `11.0.0`, and so
 * on — rather than a branch that keeps moving under an already-released
 * major. We pin every known major to its own frozen branch deliberately: the
 * corpus a project syncs today is byte-for-byte the corpus it syncs next
 * month, not something that can silently drift out from under an index
 * between two runs of `manuals update`.
 *
 * `master` is not "the current major's documentation" — it is the *stopgap*
 * for a major newer than anything in `DOCS_BRANCH_BY_MAJOR` below, used only
 * because no frozen branch exists for it yet. The first time upstream cuts
 * one, that major should move from the fallback into the map as a normal,
 * pinned entry.
 *
 * We still track two related but distinct things:
 *
 *   - `version`     the project's NestJS version ("11.1"), for display/config
 *   - `docsLine`    the documentation branch it maps to ("11.0.0", "10.0.0", …)
 *
 * Version safety is defined at the major-line boundary: an 11.x project must
 * never be served 10.x documentation, and vice versa.
 */
import { HarnessError } from '../../errors.js';

export interface NestJsVersion {
  /** Exact version when resolved from package-lock.json, e.g. "11.1.29". */
  exact?: string;
  /** Display version, "major.minor" when known, otherwise "major". */
  version: string;
  major: number;
  minor?: number;
  /** Documentation branch/corpus identifier, e.g. "11.0.0" or "10.0.0". */
  docsLine: string;
  /** Where the version came from. */
  source: 'package-lock.json' | 'package.json' | 'config' | 'explicit';
}

/**
 * Frozen documentation branches that exist in nestjs/docs.nestjs.com,
 * verified against the repository's branch list. Each is a snapshot cut the
 * day that major shipped — stable and reproducible, never rewritten under an
 * index that already synced it.
 */
const DOCS_BRANCH_BY_MAJOR: Record<number, string> = {
  10: '10.0.0',
  11: '11.0.0',
};

/**
 * The newest major line this map knows about. A project on a *newer* major
 * than this (one that shipped after this file was last updated, and does not
 * have a frozen branch yet) is pointed at `master` as a stopgap, since that
 * is the only documentation upstream has for it — the alternative is
 * refusing a project on legitimate, current NestJS outright. This map should
 * gain an explicit, pinned entry for that major the first time upstream cuts
 * a frozen branch for it.
 */
const LATEST_KNOWN_MAJOR = Math.max(...Object.keys(DOCS_BRANCH_BY_MAJOR).map(Number));

export const SUPPORTED_MAJORS = Object.keys(DOCS_BRANCH_BY_MAJOR).map(Number);

export function docsLineForMajor(major: number): string {
  const line = DOCS_BRANCH_BY_MAJOR[major];
  if (line) {
    return line;
  }
  if (major > LATEST_KNOWN_MAJOR) {
    return 'master';
  }
  throw new HarnessError(`No NestJS documentation is available for major version ${major}.`, {
    hint:
      `Known documentation branches: ${Object.entries(DOCS_BRANCH_BY_MAJOR)
        .map(([m, line]) => `${m} → ${line}`)
        .join(', ')}.\n` +
      'NestJS upstream does not keep documentation branches further back than this.',
  });
}

/** The major version number a docs line covers, e.g. "10.0.0" -> 10. */
export function majorForDocsLine(docsLine: string): number {
  if (docsLine === 'master') {
    return LATEST_KNOWN_MAJOR;
  }
  const entry = Object.entries(DOCS_BRANCH_BY_MAJOR).find(([, line]) => line === docsLine);
  if (!entry) {
    throw new HarnessError(`Unknown NestJS documentation branch: ${docsLine}`, {
      hint: `Known documentation branches: ${Object.values(DOCS_BRANCH_BY_MAJOR).join(', ')}.`,
    });
  }
  return Number(entry[0]);
}

/**
 * Extracts the highest major.minor pair from an npm version range.
 *
 * npm ranges are varied: "^11.0.0", "~11.0.0", "11.0.0", ">=10.0.0 <12.0.0",
 * "^10.0.0 || ^11.0.0". We take the highest major mentioned — for an
 * either/or range the newest line is the one a project is realistically on
 * — and the highest minor within it.
 *
 * With one exception, and it is a version-safety one: a version behind an
 * *exclusive* `<` is the one version the project provably is **not** on.
 * Reading `>=10.0.0 <11.0.0` as "major 11" would hand a 10.x project the 11.x
 * manual, which is exactly the mix-up this whole tool exists to prevent, so
 * exclusive upper bounds are dropped before picking the highest. `<=` is a
 * real, reachable bound and still counts.
 *
 * A range consisting of nothing but exclusive bounds ("<12") leaves no
 * candidate at all; rather than declare the project's NestJS undetectable, we
 * fall back to the highest mentioned, since a rejected project helps nobody.
 */
export function parseConstraint(constraint: string): { major: number; minor?: number } | undefined {
  const matches = [...constraint.matchAll(/(<=?)?\s*v?(\d+)(?:\.(\d+|[x*]))?/gi)];
  if (matches.length === 0) {
    return undefined;
  }

  let best: { major: number; minor?: number } | undefined;
  let fallback: { major: number; minor?: number } | undefined;

  for (const match of matches) {
    const exclusiveUpperBound = match[1] === '<';
    const major = Number(match[2]);
    const rawMinor = match[3];
    const minor = rawMinor && /^\d+$/.test(rawMinor) ? Number(rawMinor) : undefined;

    const higherThan = (current: { major: number; minor?: number } | undefined): boolean =>
      !current ||
      major > current.major ||
      (major === current.major && (minor ?? -1) > (current.minor ?? -1));

    if (higherThan(fallback)) {
      fallback = { major, minor };
    }
    if (!exclusiveUpperBound && higherThan(best)) {
      best = { major, minor };
    }
  }

  return best ?? fallback;
}

/** Parses an exact version such as "11.1.29" or "v11.1.29". */
export function parseExact(version: string): { major: number; minor?: number } | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function formatVersion(major: number, minor?: number): string {
  return minor === undefined ? String(major) : `${major}.${minor}`;
}

/** Builds a full NestJsVersion from a major/minor pair. */
export function buildVersion(
  parts: { major: number; minor?: number },
  source: NestJsVersion['source'],
  exact?: string,
): NestJsVersion {
  return {
    exact,
    version: formatVersion(parts.major, parts.minor),
    major: parts.major,
    minor: parts.minor,
    docsLine: docsLineForMajor(parts.major),
    source,
  };
}

/**
 * Builds a version from a user-supplied string such as "11.1" or "11".
 * Used by `--version` flags.
 */
export function versionFromString(input: string, source: NestJsVersion['source'] = 'explicit'): NestJsVersion {
  const parts = parseConstraint(input);
  if (!parts) {
    throw new HarnessError(`Could not understand NestJS version "${input}".`, {
      hint: 'Use a version like 11, 11.1 or 10.',
    });
  }
  return buildVersion(parts, source);
}
