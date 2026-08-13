import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectRegistration, registerServer } from '../generators/ai-code-mcp.js';
import { cleanupTempDirs, makeProject } from './helpers.js';

afterEach(cleanupTempDirs);

const readMcpJson = async (root: string) =>
  JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));

describe('Claude Code MCP registration', () => {
  it('reports an unregistered project', async () => {
    const root = await makeProject({ constraint: '^5.4' });
    const state = await inspectRegistration(root, 'nestjs-docs');

    expect(state).toMatchObject({ fileExists: false, registered: false, current: false });
  });

  it('creates .mcp.json with the server entry', async () => {
    const root = await makeProject({ constraint: '^5.4' });
    const result = await registerServer(root, 'nestjs-docs');

    expect(result.changed).toBe(true);
    // The npx argument is the *package* name — the unscoped binary name would
    // resolve to a different package on the registry.
    expect((await readMcpJson(root)).mcpServers['nestjs-docs']).toEqual({
      command: 'npx',
      args: ['-y', '@andygo.dev/nestjs-harness', 'mcp', 'start'],
    });
  });

  it('is idempotent — registering twice writes one entry', async () => {
    const root = await makeProject({ constraint: '^5.4' });
    await registerServer(root, 'nestjs-docs');
    const second = await registerServer(root, 'nestjs-docs');

    expect(second.changed).toBe(false);
    expect(Object.keys((await readMcpJson(root)).mcpServers)).toEqual(['nestjs-docs']);
  });

  it('merges into an existing file without disturbing other servers', async () => {
    const root = await makeProject({ constraint: '^5.4' });
    await writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            postgres: { command: 'docker', args: ['run', 'pg-mcp'] },
          },
        },
        null,
        2,
      ),
    );

    await registerServer(root, 'nestjs-docs');
    const config = await readMcpJson(root);

    expect(config.mcpServers.postgres).toEqual({ command: 'docker', args: ['run', 'pg-mcp'] });
    expect(config.mcpServers['nestjs-docs']).toBeDefined();
  });

  it('preserves unrelated top-level keys', async () => {
    const root = await makeProject({ constraint: '^5.4' });
    await writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ $schema: 'https://example.com/schema.json', mcpServers: {} }, null, 2),
    );

    await registerServer(root, 'nestjs-docs');
    expect((await readMcpJson(root)).$schema).toBe('https://example.com/schema.json');
  });

  it('leaves a customised entry for our server alone', async () => {
    const root = await makeProject({ constraint: '^5.4' });
    const custom = { command: 'node', args: ['./scripts/my-nestjs-mcp.js'] };
    await writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'nestjs-docs': custom } }, null, 2),
    );

    const result = await registerServer(root, 'nestjs-docs');

    expect(result.changed).toBe(false);
    expect(result.current).toBe(false);
    expect((await readMcpJson(root)).mcpServers['nestjs-docs']).toEqual(custom);
  });

  it('lists other configured servers so setup can report them', async () => {
    const root = await makeProject({ constraint: '^5.4' });
    await writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }),
    );

    expect((await inspectRegistration(root, 'nestjs-docs')).otherServers.sort()).toEqual(['a', 'b']);
  });

  it('refuses to touch a malformed .mcp.json', async () => {
    const root = await makeProject({ constraint: '^5.4' });
    await writeFile(path.join(root, '.mcp.json'), '{ not json');

    await expect(inspectRegistration(root, 'nestjs-docs')).rejects.toThrow(/not valid JSON/);
  });
});
