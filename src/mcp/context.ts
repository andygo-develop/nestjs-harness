/**
 * Shared plumbing for the MCP tools.
 *
 * Every tool call re-resolves the project so that a long-running server picks
 * up a newly synced index, or a changed NestJS version, without a restart.
 */
import { requireNestJsProject } from '../cli/nestjs/project.js';
import { reconcileConfig, requireConfig } from '../generators/config-generator/config.js';
import { isHarnessError } from '../errors.js';
import { openCorpus, type ResolvedCorpus } from '../rags/manuals/corpus.js';

export interface McpContext {
  /** Directory the server was started in — normally the project root. */
  cwd: string;
  openCorpus(): Promise<ResolvedCorpus>;
}

export function createMcpContext(cwd: string): McpContext {
  return {
    cwd,
    async openCorpus(): Promise<ResolvedCorpus> {
      const project = await requireNestJsProject(cwd);
      const stored = await requireConfig(project.root);
      // Re-check the project's NestJS version on every call: a long-running
      // server must not keep serving the corpus it started with.
      const config = await reconcileConfig(project.root, project.version, stored);
      return openCorpus({ root: project.root, config });
    },
  };
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Renders an error as a tool result rather than throwing.
 *
 * Agents act on tool output, so a missing index must come back as readable,
 * actionable text — "run `nestjs-harness manuals update`" — not as a
 * transport-level failure the model cannot interpret.
 */
export function toolError(error: unknown): ToolResult {
  if (isHarnessError(error)) {
    const text = error.hint ? `${error.message}\n\n${error.hint}` : error.message;
    return { content: [{ type: 'text', text }], isError: true };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `NestJS documentation lookup failed: ${message}` }],
    isError: true,
  };
}
