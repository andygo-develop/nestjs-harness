# Security

## Mass assignment

A DTO bound with `@Body()` only has the properties it declares — but without
the right `ValidationPipe` configuration, extra properties on the incoming
JSON are silently accepted and can reach a `save()` call if the handler is
careless about how it builds the entity. Two controls, both required:

```ts
// main.ts — reject anything not declared on the DTO
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,            // strip unknown properties
  forbidNonWhitelisted: true, // reject the request instead of silently stripping
}));
```

```ts
// Service — never spread an unvalidated object over fields the client must not control
async create(request: TCreateArticleRequest, author: User) {
  const article = this.repo.create({ ...request, author, published: false });
  return this.repo.save(article);
}
```

Fields that establish ownership or a privileged state — `role`, `authorId`,
`isAdmin` — should be assigned from server-side context (the authenticated
user, a default), never read from the DTO even if a matching property exists
on it. If a DTO must not accept a field at all in some contexts, don't put it
on that DTO — use a separate DTO for the privileged operation instead of one
permissive DTO reused everywhere.

## SQL injection

Parameterise everything. The query builder binds values when you use its
placeholder syntax:

```ts
// Safe — the value is bound
this.repo.createQueryBuilder('a').where('a.title LIKE :term', { term: `%${term}%` });
```

```ts
// Unsafe — interpolated directly into the SQL string
this.repo.createQueryBuilder('a').where(`a.title LIKE '%${term}%'`);
```

The difference is whether user input reaches the query as a bound parameter
or as literal SQL text. The same rule applies to `repo.query()` — never build
its SQL string with template interpolation of anything user-supplied.

Identifiers — table names, column names, sort direction — cannot be bound as
parameters. Validate them against an allow-list before use (this is why the
pagination DTO in `references/controllers.md` restricts what's accepted
rather than passing a raw `orderBy` string through).

## Async, database-backed validation

Built-in `class-validator` decorators only check shape. When a field must
reference a real, valid row — a `supplierId` that must actually be a
supplier, not just any existing id — encode that as a custom async
constraint rather than trusting the client-supplied id and letting a
downstream query fail (or worse, silently associate the wrong kind of
record):

```ts
@ValidatorConstraint({ name: 'IsSupplierId', async: true })
@Injectable()
export class IsSupplierIdConstraint implements ValidatorConstraintInterface {
  constructor(private readonly suppliers: SuppliersRepository) {}

  async validate(supplierId: number): Promise<boolean> {
    return this.suppliers.existsBy({ id: supplierId });
  }

  defaultMessage(): string {
    return 'supplierId must reference an existing supplier';
  }
}
```

```ts
export function IsSupplierId(options?: ValidationOptions) {
  return applyDecorators(
    IsNotEmpty(options),
    IsNumber(undefined, options),
    Validate(IsSupplierIdConstraint, options),
  );
}
```

The constraint class needs `@Injectable()` and must be registered as a
provider for its own dependency — the repository — to be resolved;
`class-validator`'s decorator alone cannot reach the DI container. A
component with several of these often collects them into their own
`<name>-constraints.module.ts` (see `references/architecture.md`) rather
than scattering them across whichever module happened to need one first.
This is the general pattern for "the DTO shape is fine, but does this
reference actually exist / belong to who it claims to" — exactly the class
of bug DTO validation alone cannot catch and mass-assignment defences don't
cover either, since the id itself is "valid" input, just not a valid
*reference*.

## Authentication and authorization

Different concerns, and NestJS keeps them structurally separate:

- **Authentication** — who is this? Typically Passport strategies
  (`@nestjs/passport`, e.g. `JwtStrategy`) behind a guard
  (`@UseGuards(AuthGuard('jwt'))`). The resolved identity is attached to the
  request and read via a custom `@CurrentUser()` decorator.
- **Authorization** — may they do this? A `RolesGuard` (or a policy library
  like CASL) checking the authenticated identity against what the route
  requires.

Authorization must be enforced in a guard, server-side, on every protected
route. A hidden button or a client-side check is not authorization.

Look up the current setup for the auth packages this project actually uses
with the MCP rather than recalling it — Passport strategy registration and
guard composition are exactly the kind of thing that varies between
ecosystem package versions independent of NestJS core.

## CSRF

Primarily a concern for cookie/session-authenticated apps that also serve
HTML forms — a stateless, header-token-authenticated JSON API (the common
NestJS case) is generally not vulnerable to CSRF in the classic sense, since
there's no ambient cookie for a third-party site to ride. If the project does
use session cookies for authentication, add CSRF protection (a
double-submit-token middleware, or the platform's equivalent) — verify the
current recommended package with the MCP, since dedicated CSRF middleware in
the Node ecosystem has churned.

## Passwords and secrets

- Hash passwords with a proper KDF (`bcrypt`/`argon2`) — never `md5`/`sha1`,
  never a home-grown scheme.
- Keep secrets in the environment via `ConfigService`, never hardcoded or
  committed. `.env` belongs in `.gitignore`.
- Don't log secrets, tokens, or full request/response bodies that might
  contain them.

## Output / serialization

NestJS serializes return values to JSON by default — the sharper edge for an
API-first app is leaking a field (a password hash, an internal id) into a
response, not HTML-escaping. `@Exclude()` on the entity plus a global
`ClassSerializerInterceptor` is a floor, not a substitute for handler-level
discipline — it only hides fields someone remembered to mark, not fields a
future migration adds:

```ts
@Exclude() passwordHash: string;
```

Prefer routing every response through a dedicated serializer class scoped to
that endpoint's shape — an explicit allow-list via `@Expose()`, rather than a
deny-list of what to hide. See "Serializing responses with dedicated
classes" in `references/controllers.md`.

If the project also renders server-side views (a template engine, not just a
JSON API), then standard output-escaping rules apply there too: never
interpolate unescaped user content into rendered HTML.

## Errors in production

Don't leak stack traces, internal error messages, or configuration in HTTP
responses. `NODE_ENV=production` plus a project-wide exception filter should
normalise error responses to a safe, consistent shape; log the full detail
server-side instead.

## Also worth enabling

- `helmet` for standard security headers — `app.use(helmet())`.
- An explicit CORS origin allow-list — `app.enableCors({ origin: [...] })`,
  not a wildcard, for anything handling authenticated requests.
- Rate limiting on sensitive or expensive endpoints — `@nestjs/throttler`.

## Reviewing code

Check for: `ValidationPipe` missing `whitelist`/`forbidNonWhitelisted`;
request data spread onto an entity without going through a DTO;
string-interpolated query conditions; missing authorization guard on a
state-changing route; secrets in tracked files; sensitive entity fields
without `@Exclude()`; unbounded queries without pagination.
