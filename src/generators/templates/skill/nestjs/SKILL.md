---
name: nestjs
description: Development conventions, architecture and testing practices for NestJS applications. Use when writing, reviewing or refactoring NestJS code — modules, controllers, providers, guards, pipes, interceptors, DTOs, persistence, or tests. Pairs with the NestJS documentation MCP server for verified framework APIs.
---

# NestJS Development

How to write NestJS code well. This skill holds **conventions and judgement**;
the authoritative **framework reference** lives in the documentation MCP server.
Keep those roles separate — do not guess at APIs that the MCP can confirm.

## Verify before you assert

The single most damaging failure mode in NestJS work is a confidently invented
API: a decorator option that never existed, a provider registration pattern
from a different major version, a lifecycle hook whose signature changed.
NestJS's public surface is fairly stable release to release, but the
ecosystem around it — TypeORM, class-validator, Passport strategies, the
Express/Fastify adapters — moves independently and is exactly where stale
memory bites.

**Consult the documentation MCP before writing code whenever:**

- you are unsure a decorator, class or its options exist;
- behaviour may be version-specific (adapter differences, DI scope rules);
- a module's `forRoot()`/`forRootAsync()` options are uncertain;
- guard, pipe, interceptor or exception-filter execution order is uncertain;
- ORM, validation or authentication behaviour is uncertain;
- you are about to describe framework behaviour to the user as fact.

Tools available:

| Tool | Use |
|---|---|
| `search_nestjs_manual` | Find documentation for a topic, class or decorator |
| `get_nestjs_manual` | Fetch a full document by `documentId` from a search hit |
| `search_nestjs_api` | Look up a specific class, decorator or method |

The MCP server is already scoped to **this project's NestJS version**. Results
it returns are correct for the version in use; your memory may not be.

> Prefer verified information from the NestJS Documentation MCP over
> assumptions or memory. Never invent decorators, methods, module options
> or framework behaviour — look them up.

If the MCP reports that documentation is not synchronized, tell the user to run
`nestjs-harness manuals update` rather than falling back to guesswork.

## Project specs are separate

Some projects also index their own specs, ADRs and design notes. Use these for
application-specific requirements and expected behaviour, not for NestJS
framework facts.

| Tool | Use |
|---|---|
| `search_project_specs` | Find this project's own requirements, design notes and ADRs |
| `get_project_spec` | Fetch a full project spec by `documentId` from a search hit |

Search project specs when planning features, writing tests for business rules,
or checking whether a domain behaviour is already documented. Keep the corpora
distinct in your reasoning and reporting: NestJS manual results explain the
framework; project specs explain this application's intended behaviour.

## Architecture in one page

NestJS is a conventions-first, DI-driven framework built on Express or
Fastify. Request flow:

```
Request
  → main.ts bootstrap    (NestFactory.create — global pipes/filters/interceptors)
  → Middleware            (functional or class; cross-cutting, no ExecutionContext)
  → Guards                (CanActivate — authn/authz gate before the handler)
  → Interceptors (pre)    (around-advice, runs before the handler)
  → Pipes                 (per-parameter validation/transformation)
  → Controller handler    (thin: coordinate, don't compute)
  → Provider / Service    (business logic, injected via DI)
  → Repository / ORM      (persistence)
  → Interceptors (post)   (transform the outgoing response)
  → Exception filters     (catch and format anything thrown above)
```

Layer responsibilities:

- **Component** — the architectural folder for one business domain or one
  infrastructure integration; can contain several modules. Not a NestJS
  concept by that name — this skill's vocabulary for the directory unit.
- **Controller** — read input, delegate, choose a response shape. No business logic.
- **Provider / Service** — business logic; takes its collaborators via constructor (or property) injection.
- **Module** — the unit of composition: declares controllers, providers, imports, exports. A component typically owns several — see `references/architecture.md`.
- **Guard** — `CanActivate`; decides whether a request may proceed at all.
- **Interceptor** — wraps the handler; transforms requests/responses, logging, caching.
- **Pipe** — validates and transforms individual arguments (DTOs, route params).
- **Exception filter** — turns a thrown error into a well-shaped HTTP response.
- **Repository** — persistence, with named query methods, behind the service, not the controller.
- **Serializer** — shapes what a response actually exposes; separate from the entity it's built from.
- **CLI command** — an operational script wired into the same DI graph as the app, not a standalone script.

Details: `references/architecture.md`. For how these layers are organised once
a component (or the whole app) grows large — splitting a component into
several modules, separating feature components from provider components,
per-component configuration, actor-based controllers — see
`references/conventions.md`.

## Rules that matter most

1. **Thin controllers.** A handler that exceeds ~20 lines is usually doing work
   that belongs in a service. Controllers coordinate.
2. **Constructor injection, always.** Depend on abstractions the DI container
   provides; do not reach for `new Service()`, static access, or a service
   locator inside domain code. See `references/architecture.md`.
3. **DTO validation and domain rules are different things.** A DTO with
   `class-validator` decorators checks the *shape* of incoming data
   (required, format, length). A uniqueness check or a business invariant
   that needs the database belongs in the service layer. Use both, for their
   own purposes. See `references/orm.md`.
4. **Never bind a request body directly onto an entity or a `save()` call.**
   Go through a DTO, and register `ValidationPipe` with `whitelist: true` and
   `forbidNonWhitelisted: true`. This is NestJS's mass-assignment defence —
   see `references/security.md`.
5. **Query in the service, not the controller.** Reusable query logic belongs
   behind the repository/service, not repeated across handlers.
6. **Let the query builder or ORM parameterise.** Never string-concatenate
   user input into SQL, `.query()`, or a raw expression. See
   `references/security.md`.
7. **Test through the framework.** Use `Test.createTestingModule()` with
   Supertest for e2e HTTP-level behaviour, and plain Jest with
   `overrideProvider()` for unit tests. See `references/testing.md`.
8. **Never return an entity straight from a handler.** Route every response
   through a dedicated serializer class (`@Exclude()`/`@Expose()` applied via
   `ClassSerializerInterceptor`) so what's exposed is an explicit allow-list,
   not every column and relation the ORM knows about. See
   `references/controllers.md`.

## NestJS 11 traps

These are the mistakes most likely to appear from stale memory or from
ecosystem packages that moved independently of NestJS itself. When in doubt,
verify with the MCP.

| Don't | Do |
|---|---|
| Assume global pipes/filters/interceptors apply automatically | Register them explicitly — `app.useGlobalPipes(...)` in `main.ts`, or an `APP_PIPE`/`APP_FILTER`/`APP_INTERCEPTOR` provider if they need DI |
| `app.listen(3000)` and move on | `await app.listen(...)` — bootstrap is asynchronous |
| Treat Express-specific APIs as universal | Fastify is a first-class adapter; an Express-only API (some middleware, `res.` methods) will not work under it — verify |
| Assume a class is injectable by default | Providers need `@Injectable()`; forgetting it fails at DI resolution, not at compile time |
| Assume request-scoped providers (`Scope.REQUEST`) are free | They are re-instantiated per request and can cascade scope up the injection graph — real perf cost, use deliberately |
| Assume one canonical ORM | NestJS ships none. TypeORM (`@nestjs/typeorm`) is the most-documented first-party integration, but Prisma, Mongoose and MikroORM are all common — confirm which one this project actually uses before assuming its patterns apply |

Requirements also matter: NestJS 11 targets Node.js 18+ and TypeScript 5+.
Verify anything version-sensitive before relying on it.

## References

Load these as needed — they are not all relevant to every task.

| File | Covers |
|---|---|
| `references/architecture.md` | Bootstrap (HTTP + CLI), components, DI, per-component config, logging |
| `references/orm.md` | Entities, repository classes, relations, views, saving, validation vs rules |
| `references/controllers.md` | Handlers, request/response, DTOs, audience-based controllers, response serializers, pagination |
| `references/middleware.md` | The request pipeline: middleware, guards, interceptors, pipes, filters |
| `references/testing.md` | Unit tests, e2e tests, mocking providers, shared test setup, what to assert |
| `references/security.md` | Mass assignment, SQL injection, async DB-backed validation, auth, CSRF, secrets |
| `references/conventions.md` | Naming, component directory layout, module splitting, path aliases, Nest CLI |

## Working on a task

1. Identify which layer the change belongs in before writing code.
2. Look up uncertain framework APIs with the NestJS manual/API tools — do not
   guess.
3. Search project specs when requirements or business behaviour may already be
   documented.
4. Follow existing patterns in the project; match its structure, its ORM, and
   its style.
5. Add or update tests alongside the change.
6. Keep controllers thin and business logic testable in isolation from HTTP.
