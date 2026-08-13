/**
 * Text normalisation for indexing and excerpting.
 *
 * Documentation content is untrusted input. It is only ever treated as text:
 * never executed, never interpolated into a shell command, and never allowed
 * to influence control flow.
 */

/** Splits front matter from body. Returns the raw YAML block and the rest. */
export function splitFrontMatter(source: string): { frontMatter?: string; body: string } {
  const normalised = source.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalised);
  if (!match) {
    return { body: normalised };
  }
  return { frontMatter: match[1], body: normalised.slice(match[0].length) };
}

/**
 * Reads scalar keys from a front-matter block.
 *
 * Deliberately minimal: NestJS's front matter is flat `key: "value"` pairs,
 * and a full YAML parser would be a dependency (and a parsing surface) we do
 * not need. Nested structures are ignored rather than guessed at.
 */
export function parseFrontMatter(frontMatter: string | undefined): Record<string, string> {
  if (!frontMatter) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of frontMatter.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    let value = (match[2] ?? '').trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

/** Strips inline markdown decoration so headings read as plain text. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\\(.)/g, '$1')
    .trim();
}

/**
 * Slug used for the `#anchor` fragment of a heading.
 *
 * Matches the VitePress/GitHub convention the NestJS book already uses in its
 * own cross-references (e.g. `database-basics#database-queries`).
 */
export function slugify(heading: string): string {
  return stripInlineMarkdown(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Flattens markdown into text suited to BM25 matching and excerpting.
 *
 * Code fences keep their contents — a query for `SelectQuery` or `find()`
 * should match the example that uses it — but the fence markers, container
 * directives and table pipes are dropped so they do not pollute tokens.
 */
export function toSearchText(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^:::+\s*\w*/gm, '')
    .replace(/^\s*\|/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Collapses text to a single-line excerpt of at most `maxLength` characters.
 *
 * Unlike `toSearchText`, this also unwraps bold/italic markers and markdown
 * backslash escapes so an excerpt reads as `app.module.ts` rather than
 * `app\.module\.**ts**`. That transformation is display-only — it is never
 * applied to indexed content, where unescaping could corrupt code samples.
 */
export function toExcerpt(text: string, maxLength = 320): string {
  const flat = toSearchText(text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxLength) {
    return flat;
  }
  const clipped = flat.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
