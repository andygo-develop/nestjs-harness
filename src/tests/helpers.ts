/**
 * Test helpers: build throwaway NestJS projects with a fixture manual corpus.
 *
 * Everything here is offline — no test may reach the network.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { harnessPaths } from '../cli/nestjs/project.js';
import { ensureConfig, resetConfigCache } from '../generators/config-generator/config.js';
import { buildVersion } from '../cli/nestjs/version.js';
import type { EmbeddingProvider } from '../rags/embeddings/provider.js';
import { indexManuals } from '../rags/manuals/indexer.js';
import { ManualRepository } from '../rags/manuals/repository.js';

/**
 * A deterministic, dependency-free, offline stand-in for a real embedding
 * model — used everywhere hybrid search is tested. Never imports or exercises
 * the real `@huggingface/transformers` provider, which needs a network-fetched
 * model and is out of scope for "fully offline by design" tests (see
 * `src/rags/embeddings/transformers-provider.ts`).
 *
 * Vectors are character-bigram hash counts, normalised to unit length. That is
 * enough to give texts sharing vocabulary a higher cosine similarity than
 * texts that share none — sufficient to test storage, ranking and blending
 * logic — without claiming to model actual semantics the way a real
 * sentence-embedding model would.
 */
export function makeFakeEmbeddingProvider(model = 'fake-test-model', dims = 32): EmbeddingProvider {
  const embedOne = (text: string): Float32Array => {
    const vector = new Float32Array(dims);
    const normalized = text.toLowerCase();

    for (let i = 0; i < normalized.length - 1; i += 1) {
      const gram = normalized.slice(i, i + 2);
      let hash = 0;
      for (let j = 0; j < gram.length; j += 1) {
        hash = (hash * 31 + gram.charCodeAt(j)) >>> 0;
      }
      vector[hash % dims] += 1;
    }

    let norm = 0;
    for (const value of vector) {
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i += 1) {
      vector[i] /= norm;
    }

    return vector;
  };

  return {
    model,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map(embedOne);
    },
  };
}

const createdDirs: string[] = [];

export async function makeTempDir(prefix = 'nestjs-harness-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  resetConfigCache();
}

export interface MakeProjectOptions {
  /** npm version range, e.g. "^11.0.0". Omit to write no package.json. */
  constraint?: string;
  /** Exact version for package-lock.json, e.g. "11.1.29". */
  lockVersion?: string;
  /** Write a package.json without @nestjs/core. */
  nonNestJs?: boolean;
}

/** Creates a temporary project directory with a package.json / package-lock.json. */
export async function makeProject(options: MakeProjectOptions = {}): Promise<string> {
  const root = await makeTempDir();

  if (options.nonNestJs) {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'acme-plain', dependencies: { express: '^4.19.0' } }, null, 2),
    );
    return root;
  }

  if (options.constraint) {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        { name: 'acme-blog', dependencies: { '@nestjs/core': options.constraint, '@nestjs/common': options.constraint } },
        null,
        2,
      ),
    );
  }

  if (options.lockVersion) {
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify(
        {
          packages: {
            '': { name: 'acme-blog' },
            'node_modules/@nestjs/core': { version: options.lockVersion },
          },
        },
        null,
        2,
      ),
    );
  }

  return root;
}

/** A small but realistic fixture corpus, keyed by path under the content root. */
export const FIXTURE_DOCS: Record<string, string> = {
  'techniques/sql.md': `---
title: "Database"
description: "Persistence with TypeORM in NestJS."
---

# Database

\`class\` **Repository**<Entity>

TypeORM integration provides a repository-based interface for interacting with
your database.

## Creating a Repository

The easiest way to work with an entity is to inject its \`Repository\` with
\`@InjectRepository()\`.

\`\`\`ts
# This hash must not be treated as a heading
@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}
}
\`\`\`

## Querying Rows

Use \`find()\` with an \`order\` option to sort results.

\`\`\`ts
this.users.find({ order: { createdAt: 'DESC' } });
\`\`\`
`,
  'techniques/mongodb.md': `---
title: "Mongo"
---

# Mongo

\`class\` **Model**<Document>

Mongoose integration provides schema-based access to a MongoDB collection.

## Basic Usage

Use \`save()\` to persist a document built from validated input.
`,
  'guards.md': `---
title: "Guards"
---

# Guards

Guards decide whether a given request is handled by the route handler.

## Authorization Guard

Implement \`CanActivate\` to build your own guard.

\`\`\`ts
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return true;
  }
}
\`\`\`

## Binding Guards

Apply a guard with \`@UseGuards()\` at the controller or handler level.
`,
  'controllers.md': `---
title: "Controllers"
---

# Controllers

Controllers handle incoming requests and return a response.

## Thin Controllers

Keep business logic out of route handlers.
`,
};

/** Writes a fixture corpus into `<harness>/manuals/nestjs-<line>/`. */
export async function writeFixtureManuals(
  root: string,
  docsLine: string,
  docs: Record<string, string> = FIXTURE_DOCS,
): Promise<string> {
  const paths = harnessPaths(root);
  const manualDir = paths.manualDir(docsLine);

  for (const [relative, content] of Object.entries(docs)) {
    const target = path.join(manualDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  await writeFile(
    paths.manualMetaFile(docsLine),
    JSON.stringify(
      {
        framework: 'nestjs',
        version: docsLine,
        docsLine,
        lang: 'en',
        source: `https://github.com/nestjs/docs.nestjs.com/tree/${docsLine}/content`,
        branch: docsLine,
        commit: `fixture${docsLine}`,
        syncedAt: new Date().toISOString(),
        fileCount: Object.keys(docs).length,
      },
      null,
      2,
    ),
  );

  return manualDir;
}

export interface IndexedProject {
  root: string;
  docsLine: string;
}

/**
 * Full offline setup: project + config + fixture manuals + built index.
 * `versions` may list several lines to test version isolation.
 */
export async function makeIndexedProject(
  options: {
    constraint?: string;
    lockVersion?: string;
    versions?: string[];
    docs?: Record<string, string>;
    /** Also embeds every chunk — pass makeFakeEmbeddingProvider() for hybrid tests. */
    embeddings?: EmbeddingProvider;
  } = {},
): Promise<IndexedProject> {
  const constraint = options.constraint ?? '^11.1.0';
  const root = await makeProject({ constraint, lockVersion: options.lockVersion });

  const major = Number(/(\d+)/.exec(constraint)![1]);
  const minor = /\d+\.(\d+)/.exec(constraint)?.[1];
  const version = buildVersion(
    { major, minor: minor ? Number(minor) : undefined },
    'package.json',
  );

  await ensureConfig(root, version);

  const paths = harnessPaths(root);
  const lines = options.versions ?? [version.docsLine];

  const repository = ManualRepository.open(paths.indexFile);
  try {
    for (const line of lines) {
      await writeFixtureManuals(root, line, options.docs);
      await indexManuals({
        repository,
        manualDir: paths.manualDir(line),
        docsLine: line,
        lang: 'en',
        commit: `fixture${line}`,
        embeddings: options.embeddings,
      });
    }
  } finally {
    repository.close();
  }

  return { root, docsLine: version.docsLine };
}
