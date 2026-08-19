# @andygo.dev/nestjs-harness

A local AI development harness for NestJS projects.

It gives AI coding agents **version-aware, local, authoritative NestJS
knowledge**, while keeping *how to write NestJS code* separate from *what the
framework actually does*:

- **Guidance** — development conventions, architecture and testing practice
- **Roles** — `nestjs-expert`, `nestjs-code-reviewer`, `nestjs-test-writer`
  and `nestjs-planner`, which verify APIs against the docs instead of
  recalling them
- **Manuals + MCP** — the official NestJS documentation for *your* version
- **Project specs** *(optional)* — your own docs and specs, in a separate corpus
- **Config** — how this specific project should be developed

The problem it solves: an agent confidently inventing a NestJS API, or
answering an NestJS 11 question from NestJS 10 memory.

It works with **Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI and
OpenCode** — one source of guidance, rendered into whatever each tool reads, so
a team on mixed tooling cannot end up with two versions of "how we write NestJS
here".

```
Developer
    │  npx @andygo.dev/nestjs-harness setup
    ▼
NestJS Harness ── detects version ── installs guidance ── syncs manuals ── indexes ── serves MCP
                                                                                        │
                                                                                        ▼
                                                      Claude Code · Cursor · Codex · Gemini CLI · OpenCode
```

## Requirements

- Node.js **>= 22.13** (uses the built-in `node:sqlite`)
- A NestJS project with a `package.json` depending on `@nestjs/core`

No native modules, no compilation, no database server.

## Quick start

```bash
cd my-nestjs-project
npx @andygo.dev/nestjs-harness setup
```

Or install the CLI once and run the binary:

```bash
npm install -g @andygo.dev/nestjs-harness
cd my-nestjs-project
nestjs-harness setup
```

That detects your NestJS version, detects which coding agents the project
already uses, installs the guidance and roles for each of them, downloads and
indexes the matching manuals, and offers to register the MCP server with each
agent.

To choose the agents yourself:

```bash
nestjs-harness setup --target claude-code --target cursor
```

Then:

```bash
nestjs-harness manuals search "guards and route access control"
```

```
1. Guards › Authorization guard
   Section: (root)
   Version: 11.0.0 (project: 11.1)
   URL: https://docs.nestjs.com/guards#authorization-guard
   Id:  11.0.0:en:guards.md#authorization-guard

   …the CanActivate interface implemented by every guard. Each guard has a…
```

## Checking your setup

```bash
nestjs-harness doctor
```

```
✓ NestJS project detected
✓ NestJS version: 11.1
✓ Manuals synchronized
✓ Documentation index available
✓ NestJS Skill installed
✓ Cursor guidance installed
✓ MCP server available
✓ search_nestjs_manual available
✓ get_nestjs_manual available
✓ search_nestjs_api available

Available commands:
  nestjs-harness setup                       Run the full idempotent setup flow
  nestjs-harness doctor                      Check setup health and list available commands
  nestjs-harness init                        Detect the project and create .nestjs-harness/
  nestjs-harness manuals sync                Download the official NestJS manuals
  nestjs-harness manuals index               Build the manual search index
  nestjs-harness manuals update              Sync manuals and update the index
  nestjs-harness manuals search <query>      Search the NestJS manuals
  nestjs-harness manuals status              Show synchronized and indexed manual status
  nestjs-harness manuals versions            List documentation lines and local status
  nestjs-harness specs index                 Index this project's own specs
  nestjs-harness specs search <query>        Search this project's own specs
  nestjs-harness specs status                Show project spec search status
  nestjs-harness targets list                List coding agents and their setup state
  nestjs-harness targets add <agent>         Set this project up for another coding agent
  nestjs-harness targets remove <agent>      Stop maintaining files for a coding agent
  nestjs-harness targets install             Reinstall files for every configured agent
  nestjs-harness skill install                Install the NestJS guidance
  nestjs-harness skill update                 Update the NestJS guidance
  nestjs-harness agent install                Install the NestJS roles
  nestjs-harness agent update                 Update the NestJS roles
  nestjs-harness mcp start                    Run the MCP server on stdio
  nestjs-harness mcp status                   Show MCP registration and readiness
```

The MCP checks are not assertions — `doctor` stands the server up over an
in-memory transport, lists its tools and calls them, so a tool that is
registered but broken (stale index, version drift) is reported as broken.
Failures print the command that fixes them, and the exit code is non-zero,
which makes it usable as a CI gate. `doctor` also prints the complete command
catalog so it doubles as command discovery. `--json` emits the full report,
including the command catalog.

## Commands

| Command | What it does |
|---|---|
| `setup` | Everything below, in one idempotent command |
| `doctor` | Check setup health and list available commands (`--json`) |
| `init` | Detect the project and create `.nestjs-harness/` (no downloads) |
| `manuals sync` | Download the official manuals for your version |
| `manuals index` | Build the SQLite/FTS5 search index |
| `manuals update` | Sync, then incrementally reindex — the everyday command |
| `manuals search <query>` | Search the manuals (`--limit`, `--full`, `--version`) |
| `manuals status` | What is synced and indexed (`--json`) |
| `manuals versions` | Documentation lines and their local status |
| `specs index` | Index this project's own specs (opt-in; enables spec search) |
| `specs search <query>` | Search this project's own specs (`--limit`, `--full`) |
| `specs status` | Whether project spec search is enabled and current (`--json`) |
| `targets list` | Coding agents, and whether each is set up (`--json`) |
| `targets add <agent>` | Set the project up for another agent and install its files |
| `targets remove <agent>` | Stop maintaining an agent's files (deletes nothing) |
| `targets install` | Reinstall guidance, roles and MCP for every configured agent |
| `skill install` / `skill update` | Install or refresh the guidance, for every agent |
| `agent install` / `agent update` | Install or refresh the roles, for every agent |
| `mcp start` | Run the MCP server on stdio (your coding agent launches this) |
| `mcp status` | Registration per agent and documentation readiness (`--json`) |

Add `--verbose` to any command for diagnostics and stack traces. `setup`,
`targets install`, `skill install` and `agent install` accept `--target <agent>`
(repeatable) to work on one agent at a time.

Every command is safe to run repeatedly. `manuals update` detects that nothing
changed and does no work; nothing will clobber your local edits.

## What gets created

Always:

```
.nestjs-harness/
├── config.json                       project configuration
├── manuals/nestjs-11.0.0/            synced Markdown + .meta.json
├── index/docs.sqlite                 FTS5 search index (framework manual)
├── index/specs.sqlite                FTS5 search index (project specs, optional)
├── targets/<agent>.json              what the harness installed, per agent
└── cache/                            download cache
```

Then, per coding agent — only for the ones your project is set up for:

```
Claude Code       .claude/skills/nestjs/        SKILL.md + references/
                  .claude/agents/*.md           four subagents
                  .mcp.json

Cursor            .cursor/rules/nestjs.mdc      rule, auto-attached to **/*.ts
                  .cursor/commands/*.md         four role playbooks
                  .cursor/mcp.json

OpenAI Codex CLI  AGENTS.md                     a marked-off block, merged in
                  .codex/config.toml

Gemini CLI        GEMINI.md                     a marked-off block, merged in
                  .gemini/commands/nestjs/*.toml   /nestjs:expert, …
                  .gemini/settings.json

OpenCode          AGENTS.md                     a marked-off block, merged in
                  .opencode/agent/*.md          four subagents
                  opencode.json
```

Agents that do not keep guidance in a self-contained directory share one copy of
the reference documents at `.nestjs-harness/instructions/references/`, which
their guidance file links to.

MCP registration files are only written if you approve the prompt.

The npm package contains the tooling. Documentation is downloaded locally by
`manuals sync`, never bundled.

Package name:
[`@andygo.dev/nestjs-harness`](https://www.npmjs.com/package/@andygo.dev/nestjs-harness).
The installed CLI binary is still `nestjs-harness`.

## Coding agents

Which agents a project is set up for is recorded in `config.json` as `targets`,
and `init` proposes what it can detect (`.cursor/`, `.codex/`, `GEMINI.md`,
`opencode.json`, …). Detection only ever informs a *new* config — once the list
is recorded it is your decision, and adding `.cursor/` to a repository will not
silently start writing Cursor files.

```bash
nestjs-harness targets list
```

```
Agent        Set up   Detected   MCP
claude-code  yes      yes        yes
cursor       yes      yes        yes
codex        —        yes        —
gemini       —        —          —
opencode     —        —          —
```

```bash
nestjs-harness targets add codex
nestjs-harness targets remove cursor
```

`targets remove` stops maintaining an agent's files; it never deletes them. They
are in your repository, possibly committed and possibly edited, and quietly
deleting them because a config list changed is not a trade this tool makes. It
prints exactly what was left behind.

### One source of guidance

The conventions are written once, in this package's Skill templates, and
rendered per agent. The four roles are written once as subagent definitions and
re-expressed as whatever the tool actually supports:

| Agent | Roles become | Permissions |
|---|---|---|
| Claude Code | subagents in `.claude/agents/` | native `tools:` list |
| OpenCode | subagents in `.opencode/agent/` | translated to `tools: {write: false, …}` |
| Gemini CLI | commands — `/nestjs:expert`, … | not expressible |
| Cursor | commands in `.cursor/commands/` | not expressible |
| OpenAI Codex CLI | playbook documents it is pointed at | not expressible |

Two details there are load-bearing. Claude Code namespaces MCP tools as
`mcp__<server>__<tool>` and other clients do not, so the prefix is stripped for
them — a role telling Gemini CLI to call `mcp__nestjs-docs__search_nestjs_manual`
would simply never look anything up. And the reviewer's read-only restriction is
translated rather than dropped where the syntax differs; where a tool cannot
express it at all, that is stated rather than assumed.

`AGENTS.md` is shared by Codex and OpenCode, so a project set up for both gets
**one** block describing both, rather than each overwriting the other's on every
run.

## MCP tools

Once registered, your coding agent gains these tools:

| Tool | Purpose |
|---|---|
| `search_nestjs_manual` | Ranked search; returns compact excerpts + `documentId` |
| `get_nestjs_manual` | Full document text for a `documentId` |
| `search_nestjs_api` | Look up a class, decorator or method |
| `search_project_specs` | Search this project's own specs (optional, see below) |
| `get_project_spec` | Full text of one of this project's spec documents |

Results are deliberately small — title, section, version, URL, excerpt,
`documentId` — so a search never floods the context window. The agent fetches
full documents only when it needs them.

## Project specs (optional)

Beyond the framework manual, the harness can index **your project's own** specs,
design notes and ADRs — the knowledge that explains how *this* application is
meant to behave.

It is opt-in. Nothing scans your repository until you run:

```bash
nestjs-harness specs index
nestjs-harness specs search "invoice numbering"
```

```
1. Billing Rules › Invoice Numbering
   Section: docs
   File: docs/billing.md#invoice-numbering
   Id:   spec:docs/billing.md#invoice-numbering

   Invoice numbers use the prefix ACME- followed by a zero-padded sequence…
```

Which files count is configurable:

```json
"specs": {
  "enabled": true,
  "include": ["docs/**/*.md", "specs/**/*.md", "*.md"],
  "exclude": ["vendor/**", "node_modules/**", ".nestjs-harness/**", ".claude/**",
              ".cursor/**", ".codex/**", ".gemini/**", ".opencode/**",
              "AGENTS.md", "CLAUDE.md", "GEMINI.md"]
}
```

Discovery prunes excluded directories rather than walking them, skips symlinks
so it cannot escape the project, and indexes incrementally by content hash like
the manual does.

The excludes cover every file the harness installs for a coding agent. Those
hold *framework* guidance, and indexing them here would let NestJS conventions
come back out of `search_project_specs` dressed as this project's own
requirements.

**The two corpora never mix.** Project specs live in their own SQLite database
(`index/specs.sqlite`) with their own tools, so a project design note cannot be
returned by `search_nestjs_manual` — that separation is structural, not a
filter that could be got wrong. The tool descriptions and the server
instructions both state which corpus is which, so an agent does not present
your internal ADR as NestJS framework behaviour.

## The NestJS roles

`setup` installs four roles for every coding agent the project is set up for:

| Role | Does | Tools |
|---|---|---|
| `nestjs-expert` | Implements and refactors NestJS code | full (reads, edits, runs) |
| `nestjs-code-reviewer` | Reviews NestJS code for defects | **read-only** + MCP lookups |
| `nestjs-test-writer` | Writes and repairs tests | read/write + Bash + MCP lookups |
| `nestjs-planner` | Plans features, refactors and migrations before implementation | **read-only** + MCP lookups |

In Claude Code and OpenCode they are subagents:

```
> use the nestjs-expert agent to add rate limiting to the auth module
> use the nestjs-planner agent to plan the billing refactor
> use the nestjs-code-reviewer agent on my changes
> use the nestjs-test-writer agent to cover UsersService
```

In Gemini CLI they are commands (`/nestjs:expert`, `/nestjs:code-reviewer`,
`/nestjs:test-writer`, `/nestjs:planner`); in Cursor, commands in
`.cursor/commands/`; in Codex, playbook documents its `AGENTS.md` block points
at.

### Forcing a role

Only `nestjs-expert`'s description says `Use PROACTIVELY`, so it is the one
role a coding agent may reach for on its own for NestJS implementation work.
The other three — `nestjs-planner`, `nestjs-code-reviewer`, `nestjs-test-writer`
— only run when you ask for them by name; left unnamed, the agent is free to
handle planning, review or tests inline itself instead of delegating.

To force a specific role rather than leaving that choice to the agent, invoke
it explicitly:

- **Claude Code / OpenCode** — name the subagent in your prompt, as in the
  examples above (`use the nestjs-code-reviewer agent to review this`). Naming
  it dispatches the whole task to that subagent instead of the top-level agent
  answering inline.
- **Gemini CLI** — run its command directly: `/nestjs:expert`,
  `/nestjs:planner`, `/nestjs:code-reviewer`, `/nestjs:test-writer`.
- **Cursor** — run the matching command from `.cursor/commands/`.
- **Codex** — there is no separate role to invoke. Its playbook is folded into
  the ambient `AGENTS.md` block and applies on every turn, so there is nothing
  to force on.

Those are all per-prompt. For a standing rule, edit `CLAUDE.md` — the harness
never writes to it (Claude Code's guidance lives in `.claude/skills/nestjs/`
and `.claude/agents/*.md` instead, see the layout above), so it is a clean
place to add project-wide delegation policy without colliding with anything
`skill update`/`agent update` maintain. For example:

```markdown
## Subagent policy

- Always use the nestjs-code-reviewer subagent to review NestJS changes
  before reporting a task done.
- Always use the nestjs-test-writer subagent when adding or fixing tests
  for NestJS code.
```

That turns delegation into the default for that kind of work project-wide,
instead of something asked for each time — effectively a project-scoped
`Use PROACTIVELY` for a role that doesn't carry it by default. The same idea
applies to the other targets' own ambient files (`AGENTS.md` for Codex/
OpenCode, `GEMINI.md` for Gemini CLI, `.cursor/rules/` for Cursor) — but
those already carry a harness-managed block, so add project-specific policy
like this outside of it, not inside the marked-off section `agent
update`/`skill update` own.

All four share one defining rule: **verify framework APIs against the
documentation before asserting them**. For the expert that means searching
before writing; for the planner it means grounding implementation steps in this
project's actual NestJS version; for the reviewer it means confirming an API
really is wrong before flagging it — a review that confidently flags correct
code is worse than no review; for the test writer it means checking that a
testing utility actually exists in this version before relying on it.

The **reviewer** is restricted to `Read, Grep, Glob, Bash` plus the three MCP
tools, so it cannot rewrite the code it is reviewing — translated to
`write: false, edit: false` for OpenCode, and stated in the prose for tools that
cannot enforce it. It reports findings as
Critical / Warning / Suggestion with `file:line` and a concrete fix, covering
NestJS-specific defects: DTOs accepted without a `ValidationPipe`, guards
ordered after the logic they are meant to protect, providers reaching for
`any` instead of constructor injection, N+1 queries from an eagerly-loaded
relation inside a loop, secrets read directly from `process.env` instead of
`ConfigService`, and missing `@nestjs/testing` coverage on a new endpoint.

The **test writer** carries two hard rules that tool permissions cannot express:
it never edits production code to make a test pass (a failing test it wrote is a
bug found, and it reports it instead), and it never claims a suite passes
without actually running it. It knows the NestJS testing surface —
`Test.createTestingModule()`, `overrideProvider()`, Supertest against the HTTP
server for e2e, and mocking a provider rather than the module under test — and
is told to cover failure paths, not just happy paths.

In Claude Code, tool names are namespaced by your MCP server name
(`mcp__nestjs-docs__search_nestjs_manual`), so all four roles are rendered with
the `mcp.serverName` from your config at install time — rename the server and
`agent update` rewires them.

Unlike the ambient guidance, a subagent runs in a separate context with its own
tool budget. Use the guidance for everyday NestJS work; reach for a role on
larger, self-contained tasks.

### Manual registration

`setup` asks before touching any MCP configuration file. To do it yourself, in
`.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) or `.gemini/settings.json`
(Gemini CLI):

```json
{
  "mcpServers": {
    "nestjs-docs": {
      "command": "npx",
      "args": ["-y", "@andygo.dev/nestjs-harness", "mcp", "start"]
    }
  }
}
```

In `opencode.json` (OpenCode):

```json
{
  "mcp": {
    "nestjs-docs": {
      "type": "local",
      "command": ["npx", "-y", "@andygo.dev/nestjs-harness", "mcp", "start"],
      "enabled": true
    }
  }
}
```

In `.codex/config.toml` (Codex CLI — it also reads `~/.codex/config.toml`):

```toml
[mcp_servers.nestjs-docs]
command = "npx"
args = ["-y", "@andygo.dev/nestjs-harness", "mcp", "start"]
```

Existing servers in these files are never modified, and an entry for our own
server that you have customised is left alone.

## Version safety

This is the point of the tool, so it is strict.

```
Claude → MCP → project config → NestJS version → version-specific index → search
```

Unlike frameworks that publish a single living documentation branch per major
line, `docs.nestjs.com` (built from `nestjs/docs.nestjs.com`) gets a frozen
snapshot branch the day each major ships — `10.0.0`, `11.0.0`, and so on —
and that branch never moves again. The harness pins every known major to its
own frozen branch on purpose: the corpus a project syncs today is the same
corpus it syncs next month, not something that can silently drift out from
under an already-built index. So the harness maps:

- the current major (**11**) → `11.0.0`, the frozen snapshot cut when NestJS
  11 shipped;
- the previous major (**10**) → `10.0.0`, the only documentation upstream
  still has for it;
- anything older → no documentation at all — upstream does not keep it;
- a future major newer than anything the harness knows about yet → `master`
  as a stopgap, since that is the only documentation upstream has for it
  until a frozen branch exists.

And it **never crosses a major-version boundary**: an 11.x project is never
served 10.x documentation, or vice versa.

If the right documentation is not available, you get an error, not a guess:

```
✖ NestJS 10.1 documentation has not been synchronized (corpus: nestjs-10.0.0, language: en).

Run:

  nestjs-harness manuals sync
  nestjs-harness manuals index

Indexed documentation for other versions is present but will not be used:
  nestjs-11.0.0 (en, 210 documents)
```

Version detection prefers `package-lock.json` (exact, `11.1.29`) and falls back
to the `package.json` range (`^11.0.0`).

## How it works

**Sync** asks GitHub for the head commit of the documentation branch for your
major line (`11.0.0` for the current major, `10.0.0` for the previous one). If
it matches what you have, nothing is downloaded. Otherwise it pulls the branch
tarball once and extracts only `content/**/*.md`.

**Indexing** splits each page into one document per `##` section — a section is
the unit a developer actually wants back, and whole pages rank badly and blow up
context. Each chunk is content-hashed, so re-indexing only touches what changed.

**Search** is BM25 via SQLite FTS5 by default, with title and heading weighted
above body text. Queries are tokenised and re-quoted before they reach FTS5, so
`@Injectable()`, `canActivate()` and `this.usersService` work rather than
throwing syntax errors. The search widens in stages: all terms → any term →
prefix.

**Hybrid search** *(optional)* blends that BM25 ranking with semantic
similarity from local embeddings, combined by reciprocal rank fusion — a query
phrased nothing like the manual's own wording (`"how do I stop a request body
from having extra unexpected fields"`) can still surface the right section. See
[Hybrid search](#hybrid-search-optional) below.

**Storage** is behind a repository interface so another backend can be added
later.

## Hybrid search (optional)

By default, search is BM25 only — lexical, offline, no extra dependency. Set
`index.searchStrategy` to `"hybrid"` in `.nestjs-harness/config.json` to also
rank by semantic similarity from a local embedding model, blended with BM25 by
[reciprocal rank fusion](https://en.wikipedia.org/wiki/Learning_to_rank#Ranking_SVM):

```json
"index": {
  "searchStrategy": "hybrid",
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

Then reindex — hybrid search needs embeddings to search *against*, not just
the FTS5 index:

```bash
nestjs-harness manuals update
nestjs-harness specs index
```

This works on an index you already have: nothing needs to change on disk for
the embeddings to be filled in, and neither command re-downloads or re-parses
anything it does not have to. It is also resumable — if the run is interrupted,
everything embedded so far is kept and the next run picks up exactly what is
still missing.

`manuals status` reports readiness (`210/210 documents embedded`), and
`manuals search` / `search_nestjs_manual` refuse to run hybrid search with a
message telling you to reindex, rather than silently falling back to bm25,
unless *every* document in the corpus has an embedding for the configured
model. Reading a document by id (`get_nestjs_manual`) and `doctor` never
require embeddings, so neither is affected while a corpus is still filling in.

Why bother: BM25 only ever matches vocabulary that is actually in the query.
A query phrased in the developer's own words — `"how do I stop a request body
from having extra unexpected fields"` — has almost no token overlap with the
manual's own heading, *Whitelisting*, but hybrid search still ranks it first,
because the embeddings capture that they mean the same thing.

**What's actually running:** a small sentence-embedding model
(`Xenova/all-MiniLM-L6-v2` by default) via
[`@huggingface/transformers`](https://github.com/huggingface/transformers.js) —
transformers.js, a local WASM/ONNX runtime. No API key, no server, no
outbound calls per query. The model downloads once on first use
(a few tens of MB), reporting progress as it goes, and is cached after that.

**Trade-offs worth knowing before you opt in:**

- It is the one path in this package that is not "no native modules": in
  Node, transformers.js runs its ONNX graph through `onnxruntime-node`, a
  small **prebuilt** (not compiled) native addon. The default `bm25` strategy
  is entirely unaffected — this only loads if `searchStrategy` is `hybrid`.
- `@huggingface/transformers` is listed as an `optionalDependencies` entry
  specifically so a `bm25`-only install never has to carry it. It pulls in
  `onnxruntime-node` and `sharp` (image handling the text-embedding path here
  never uses), both of which currently have open, unpatched high-severity
  advisories in their dependency chains at the time of writing — check
  `npm audit` before deciding whether that is acceptable for your project.
- Indexing a full manual corpus (~200 chunks) takes tens of seconds longer
  than bm25-only, since every added or changed chunk needs an embedding. A
  chunk that is unchanged *and* already has a vector for the configured model
  is never re-embedded.
- Similarity is a brute-force cosine scan over stored vectors at query time —
  fine at the corpus sizes this tool deals with (low thousands of documents),
  deliberately not a dedicated ANN index for a problem this size does not have.

## Security

Downloaded documentation is untrusted input:

- extracted entries must be regular Markdown files under `content/`
- absolute paths, `..` segments, symlinks and hardlinks are rejected
- every destination is verified to resolve inside the manuals directory
- content is only ever stored and displayed — never executed, never
  interpolated into a shell command, never able to influence control flow

## Programmatic use

```ts
import { detectNestJsVersion, openCorpus, searchManuals } from '@andygo.dev/nestjs-harness';
```

The version model, config, sync, index, search, MCP server and the target
installers are all exported. To set a project up for an agent from your own
tooling:

```ts
import { installTargets, registerTargetServer, TARGETS } from '@andygo.dev/nestjs-harness';

await installTargets(['claude-code', 'cursor'], { root, serverName: 'nestjs-docs' });
await registerTargetServer(root, TARGETS.cursor, 'nestjs-docs');
```

## Development

```bash
npm install
npm run build
npm test          # fully offline (hybrid search is tested against a fake embedding provider)
npm run typecheck
```

## License

MIT
