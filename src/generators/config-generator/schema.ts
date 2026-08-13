/**
 * The `.nestjs-harness/config.json` schema.
 *
 * `configVersion` exists so future releases can migrate older files rather
 * than breaking on them. Unknown keys are preserved on write so that a newer
 * harness writing extra fields does not lose them when an older one saves.
 */
import { z } from 'zod';

import { TARGET_IDS } from '../targets/types.js';

export const CURRENT_CONFIG_VERSION = 1;

/**
 * Default local embedding model for hybrid search.
 *
 * A small sentence-embedding model runnable fully offline via a WASM/ONNX
 * pipeline (no server, no API key) — see `src/rags/embeddings/`. Only loaded
 * (and only ever downloaded) when `index.searchStrategy` is actually `hybrid`;
 * the default `bm25` strategy never touches it.
 */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

export const configSchema = z.object({
  configVersion: z.number().int().positive(),
  nestjs: z.object({
    /** Project version for display, "major.minor" when known, e.g. "11.1". */
    version: z.string(),
    /** Exact resolved version when known from package-lock.json, e.g. "11.1.29". */
    exactVersion: z.string().optional(),
    /** Documentation branch this project maps to, e.g. "11.0.0" or "10.0.0". */
    docsLine: z.string(),
  }),
  manuals: z.object({
    source: z.literal('official').default('official'),
    language: z.string().default('en'),
    /** Git repository the manuals are synced from. */
    repository: z.string().default('nestjs/docs.nestjs.com'),
  }),
  index: z.object({
    engine: z.literal('sqlite').default('sqlite'),
    /**
     * `bm25` — lexical full-text search only (default, no extra dependency).
     * `hybrid` — blends bm25 with local semantic embeddings (see
     * `embeddingModel` below), combined by reciprocal rank fusion. Opting in
     * requires reindexing (`manuals update` / `specs index`) so vectors exist
     * to search against.
     */
    searchStrategy: z.enum(['bm25', 'hybrid']).default('bm25'),
    /** Local embedding model used when searchStrategy is "hybrid". */
    embeddingModel: z.string().default(DEFAULT_EMBEDDING_MODEL),
  }),
  mcp: z.object({
    transport: z.literal('stdio').default('stdio'),
    /** Server name registered in each coding agent's MCP configuration. */
    serverName: z.string().default('nestjs-docs'),
  }),
  /**
   * Which coding agents this project is set up for.
   *
   * Defaults to Claude Code so a config written before targets existed keeps
   * behaving exactly as it did. `init` proposes what it detects, but only when
   * creating the file — once this list is recorded it is the team's decision,
   * and detection must never quietly add to it.
   */
  targets: z.array(z.enum(TARGET_IDS)).min(1).default(['claude-code']),
  /**
   * Optional indexing of the project's own written specs and docs.
   *
   * Off by default: scanning a developer's repository is opt-in, and enabling
   * it is what `nestjs-harness specs index` does. Kept in a corpus entirely
   * separate from the framework manual so project notes can never be returned
   * as if they were NestJS documentation.
   */
  specs: z
    .object({
      enabled: z.boolean().default(false),
      include: z.array(z.string()).default(['docs/**/*.md', 'specs/**/*.md', '*.md']),
      exclude: z
        .array(z.string())
        .default([
          'vendor/**',
          // `**/` matters in a workspace: a monorepo has a node_modules per
          // package, and only the prefixed form prunes those from the walk
          // instead of descending into every one of them.
          '**/node_modules/**',
          '.nestjs-harness/**',
          // Everything the harness installs for a coding agent. These hold
          // *framework* guidance; indexing them here would let NestJS
          // conventions come back out of `search_project_specs` dressed as this
          // project's own requirements, which is exactly the mixing the two
          // separate corpora exist to prevent.
          '.claude/**',
          '.cursor/**',
          '.codex/**',
          '.gemini/**',
          '.opencode/**',
          'AGENTS.md',
          'CLAUDE.md',
          'GEMINI.md',
          'tmp/**',
          'logs/**',
        ]),
    })
    // prefault (not default): feeds `{}` through the schema so the inner
    // defaults apply, which also makes a partially-written `specs` block valid.
    .prefault({}),
});

export type HarnessConfig = z.infer<typeof configSchema>;

/** A partial config as it may appear on disk before defaults are applied. */
export type HarnessConfigInput = z.input<typeof configSchema>;

export function defaultConfig(
  nestjs: {
    version: string;
    exactVersion?: string;
    docsLine: string;
  },
  targets?: readonly HarnessConfig['targets'][number][],
): HarnessConfig {
  return configSchema.parse({
    configVersion: CURRENT_CONFIG_VERSION,
    nestjs,
    manuals: {},
    index: {},
    mcp: {},
    ...(targets && targets.length > 0 ? { targets: [...targets] } : {}),
  });
}
