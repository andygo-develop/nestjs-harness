# Architecture

Verify specific signatures with `search_nestjs_manual` before relying on them.

## Application lifecycle

`src/main.ts` creates the application instance, registers global
pipes/filters/interceptors, and starts listening. It stays a thin bootstrap
script — the actual composition root is `AppModule`, in the `app` component
(see "Directory layout" below).

```ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './components/app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  app.enableCors({ origin: ['https://example.com'] });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

`AppModule` is the root module. It composes feature modules; it should not
itself accumulate business logic.

```ts
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), UsersModule, AuthModule],
})
export class AppModule {}
```

## Directory layout

Every module's code lives inside a **component** — a self-contained folder
for one business domain (`orders`, `auth`) or one infrastructure integration
(`database`, `stripe`). A component is an architectural unit, not a single
`@Module()` — see "A component's modules" below. Nothing business-specific
sits loose at the top of `src/`: it holds exactly two entrypoints and one
directory.

```
src/
├── main.ts                        HTTP app bootstrap
├── main-cli.ts                    CLI bootstrap — see "The CLI subsystem" below
└── components/
    ├── app/                       composition root + cross-cutting code — see below
    │   ├── app.module.ts
    │   ├── app-cli.module.ts
    │   ├── configs/
    │   ├── guards/
    │   ├── filters/
    │   ├── interceptors/
    │   ├── pipes/
    │   ├── decorators/
    │   └── cli/
    │       └── base.command.ts
    ├── database/                  provider component — infrastructure, not a business rule
    │   ├── database.module.ts
    │   └── configs/
    ├── stripe/                    provider component
    │   ├── stripe.module.ts
    │   ├── configs/
    │   │   └── stripe.config.ts    this component's own settings — see Configuration below
    │   └── services/
    │       └── stripe.service.ts
    ├── auth/                      feature component
    │   ├── auth.module.ts
    │   ├── configs/
    │   │   └── auth.config.ts
    │   ├── services/
    │   │   └── auth.service.ts
    │   ├── guards/
    │   │   └── jwt-auth.guard.ts
    │   └── strategies/
    │       └── jwt.strategy.ts
    └── orders/                    feature component, split into several modules
        ├── orders.module.ts                the exported service surface
        ├── orders-controllers.module.ts    HTTP controllers
        ├── orders-db.module.ts             TypeOrmModule.forFeature + repositories
        ├── orders-constraints.module.ts    async class-validator constraints
        ├── configs/
        │   └── orders.config.ts
        ├── controllers/
        │   └── orders.controller.ts
        ├── services/
        │   └── orders.service.ts
        ├── repositories/
        │   └── orders.repository.ts
        ├── constraints/
        │   └── is-valid-sku.constraint.ts
        ├── dtos/
        │   └── create-order.dto.ts
        ├── entities/
        │   └── order.entity.ts
        └── cli/
            ├── orders-cli.module.ts
            └── commands/
                └── backfill-order-totals.command.ts
```

Every component — feature, provider, or `app` — lives at the same level
under `components/`. There is no separate top-level `providers/` directory:
"provider" is a *role* a component plays (it wraps an external dependency
and would need to change only if that dependency's API changed), not a
different place it lives. `app` is a component for the same reason — it is
simply where genuinely cross-cutting code lives (`AppModule` itself, base
classes, generic decorators, app-wide guards/filters/interceptors/pipes)
precisely *because* it has no more specific domain to belong to. Code that
supports one particular domain — an auth-specific guard, a
payments-specific interceptor — stays in that domain's own component even
when several other components depend on it; being widely used does not by
itself make something "common," and being depended on is not by itself
evidence that something belongs in `app`.

Because nothing in the physical layout marks the feature/provider boundary,
holding it is a matter of discipline, not directory structure: a feature
component may import a provider component (`OrdersModule` imports
`StripeModule`); a provider component should not import a feature
component. If `stripe/` starts importing something from `orders/`, business
logic has leaked into the infrastructure layer — that has to be caught in
review, since the folder layout alone will not flag it.

Within any component, files are grouped by role in their own subfolder:
`services/` for services, `repositories/` for repository classes,
`controllers/`, `entities/`, `dtos/`, and so on. There is no size threshold
below which a service is allowed to sit directly in the component root — a
component with a single service still gets a `services/` folder, so where a
given piece of code lives is never a guess. See `references/conventions.md`
for the full set of per-role subfolders.

### A component's modules

Once a component has more than a controller and a service, it typically
splits into several `@Module()`s, each owning one concern:

| Module file | Owns | Imported by |
|---|---|---|
| `<name>.module.ts` | The component's services — its exported, reusable surface | Other components that need this component's services |
| `<name>-controllers.module.ts` | The component's HTTP controllers | `AppModule` only — nothing else should need a controller |
| `<name>-db.module.ts` | `TypeOrmModule.forFeature([...])` and the repository providers | The component's own `.module.ts`; other components only if they need this component's repositories directly |
| `<name>-cli.module.ts` (in the component's `cli/` folder) | The component's CLI commands | `AppCliModule` |
| `<name>-constraints.module.ts` | Async, database-backed `class-validator` constraints — see `references/security.md` | Wherever a DTO, in this or another component, uses one of its `@Validate()` decorators |

Not every component needs all five — a small one might be just
`orders.module.ts`, declaring a controller, a service and a repository
directly. Split out one of the files above once it is doing too much to
scan at a glance, the same rule as any other refactor: split by concern
when the concern becomes real, not ahead of it. See
`references/conventions.md` for the code-level mechanics of each split.

## The CLI subsystem

Operational scripts (backfills, one-off migrations of data rather than
schema, admin tooling) belong in the application's own dependency graph, not
in a disconnected standalone script that reimplements DI, config loading and
logging from scratch. [`nest-commander`](https://docs.nestjs.com/recipes/nest-commander)
gives the CLI its own bootstrap that reuses the app's modules:

```ts
// main-cli.ts — a second entrypoint, separate from main.ts
import { CommandFactory } from 'nest-commander';
import { AppCliModule } from './components/app/app-cli.module';

async function bootstrap() {
  await CommandFactory.run(AppCliModule, ['error', 'warn']);
}
bootstrap();
```

`AppCliModule` (in the `app` component, alongside `AppModule`) composes
whichever components' `-cli.module.ts` the tooling needs — not necessarily
all of them, since a CLI-only build has no reason to wire up the HTTP
controllers. A command itself lives in that component's own `cli/commands/`
folder:

```ts
// orders/cli/commands/backfill-order-totals.command.ts
@Command({ name: 'backfill-order-totals', arguments: '[applyChanges]' })
export class BackfillOrderTotalsCommand extends CommandRunner {
  constructor(private readonly orders: OrdersRepository) {}

  async run([applyChangesArg]: string[]): Promise<void> {
    const applyChanges = applyChangesArg === 'true';
    // ...
  }
}
```

A shared abstract base command is worth introducing once there is more than
one command, so exit codes and error logging are consistent rather than
reimplemented per script:

```ts
export abstract class BaseCommand extends CommandRunner {
  async run(params: string[], options?: Record<string, unknown>): Promise<void> {
    try {
      await this.runHandler(params, options);
      process.exit(0);
    } catch (error) {
      Logger.error(error);
      process.exit(1);
    }
  }

  abstract runHandler(params: string[], options?: Record<string, unknown>): Promise<void>;
}
```

Verify the exact `nest-commander` API (`@Command()` options, `CommandRunner`,
`@Option()` parsers) with the MCP before relying on it — it is a separate
package from `@nestjs/core` and versions independently.

## Where logic belongs

Decide the layer before writing code:

| Concern | Home |
|---|---|
| Interpreting a request, choosing a response shape | Controller |
| Reusable query | Method on the service (or a custom repository) |
| Rule about one field's shape (required, format, length) | DTO + `class-validator` |
| Rule needing the database (uniqueness, referential integrity) | Service, before/around the save |
| Logic across several entities, or external I/O (payment provider, email) | Service / dedicated provider |
| Behaviour applied to every request | Middleware |
| Authn/authz gate before a handler runs | Guard |
| Cross-cutting request/response transform (logging, caching, shaping output) | Interceptor |
| Per-parameter validation/transformation | Pipe |
| Turning a thrown error into an HTTP response | Exception filter |
| Scheduled / operational task | `@nestjs/schedule` cron provider, or a CLI script |

A service is a plain injectable class. It takes its collaborators via the
constructor, returns values or throws, and knows nothing about HTTP. That is
what makes it testable without booting the HTTP layer.

## Modules and dependency injection

`@Module()` is the unit of composition. `providers` are what the module makes
injectable; `exports` is what other modules that `import` this one may use;
anything not exported stays private to the module.

```ts
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

Providers are resolved by constructor injection, using the class (or an
injection token) as the key:

```ts
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly config: ConfigService,
  ) {}
}
```

Prefer constructor injection over `new SomeService()` or a global/static
lookup inside domain code — it keeps the dependency graph explicit and
substitutable in tests.

Property injection (`@Inject()` on a class field, instead of a constructor
parameter) is a valid alternative NestJS supports, and some codebases adopt
it deliberately once a class has enough dependencies that the constructor
signature stops being readable:

```ts
@Injectable()
export class OrdersService {
  @Inject()
  protected readonly repository: OrdersRepository;

  @Inject()
  protected readonly config: ConfigService;
}
```

It resolves the same way and is just as testable via
`module.get(OrdersService)` in a `TestingModule`. The trade-off: a
constructor parameter is enforced at the call site (you cannot construct the
class without it), while a property-injected field is only ever populated by
Nest's container — instantiating the class by hand (`new OrdersService()`,
which should not happen in application code anyway) silently leaves it
`undefined`. Pick one style and apply it consistently across a codebase
rather than mixing both within the same class.

Providers default to a singleton (`Scope.DEFAULT`) shared across the whole
app. `Scope.REQUEST` creates a new instance per incoming request — it is
sometimes necessary (per-request state) but is a real performance cost, and
any provider that depends on a request-scoped provider becomes request-scoped
too. Do not reach for it by default.

Custom providers (`useValue`, `useClass`, `useFactory`) exist for anything
that is not "just a class" — configuration objects, third-party clients,
values that depend on other providers to construct. Verify exact syntax with
the MCP; the options object shape has grown over major versions.

## Events

NestJS's core does not dispatch framework lifecycle events the way an ORM
might. For genuinely cross-cutting reactions — notifications, auditing,
decoupling a side effect from the operation that triggers it — reach for
`@nestjs/event-emitter` (`EventEmitter2`) or, for more structured
command/query/event flows, `@nestjs/cqrs`. Both are optional packages, not
part of the core framework; confirm which (if either) a given project
actually depends on before assuming the pattern is in use. Overusing events
makes control flow hard to follow — prefer a direct method call unless the
decoupling is actually needed.

## Configuration

Every component owns its own configuration, in its own `configs/` folder —
not just providers. `app/configs/` is not "the config folder for everything
else's leftovers"; it holds specifically the *application's* main
configuration: the `ConfigModule.forRoot()` call itself, environment
validation, and settings with no more specific owner (`PORT`, `NODE_ENV`).
Anything scoped to one component — Stripe's API key, an auth token TTL,
Orders' default page size — belongs in that component's own `configs/`,
right next to the code that reads it.

`@nestjs/config`'s `registerAs()` gives each component a namespaced,
independently-typed config factory:

```ts
// components/stripe/configs/stripe.config.ts
export const STRIPE_CONFIG = 'stripe';

export const StripeConfig = registerAs(STRIPE_CONFIG, () => ({
  apiKey: process.env.STRIPE_API_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
}));

export type TStripeConfig = ReturnType<typeof StripeConfig>;
```

The component's own module registers just that slice with
`ConfigModule.forFeature()`, and reads it back through the same namespace
token — never `process.env.STRIPE_API_KEY` directly, which is exactly the
scattering a dedicated config file exists to prevent:

```ts
// components/stripe/stripe.module.ts
@Module({
  imports: [ConfigModule.forFeature(StripeConfig)],
  providers: [{
    provide: Stripe,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => new Stripe(config.get<TStripeConfig>(STRIPE_CONFIG).apiKey),
  }],
  exports: [Stripe],
})
export class StripeModule {}
```

The app-level config follows the same `registerAs()` shape, just loaded
once, globally, from `AppModule`:

```ts
// components/app/configs/app.config.ts
export const APP_CONFIG = 'app';

export const AppConfig = registerAs(APP_CONFIG, () => ({
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV ?? 'development',
}));
```

```ts
// components/app/app.module.ts
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [AppConfig], validationSchema }),
    OrdersModule, AuthModule, StripeModule,
  ],
})
export class AppModule {}
```

`isGlobal: true` on the one `forRoot()` call is what lets `ConfigService`
be injected anywhere without every component re-importing `ConfigModule` —
each component's `forFeature()` only registers *its own* namespace, it
doesn't re-load the whole environment. `validationSchema` (a Joi schema, or
a `class-validator` DTO passed as `validate`) belongs in `app/configs/`
too, since it validates the environment the *whole* app depends on, not
one component's slice of it — a missing or malformed variable then fails
fast at boot, not mid-request, no matter which component would have hit it
first.

Read configuration through `ConfigService`, never `process.env` scattered
through domain code — the indirection is what makes tests able to supply
their own values without setting real environment variables. Secrets
(API keys, webhook secrets, the database password) belong in the
environment, never hardcoded in a `configs/*.config.ts` file or committed
to version control — the config file describes *how to read* the secret,
it does not contain it.

## Logging

Use Nest's built-in `Logger` (or a configured logger adapter like `pino`)
rather than `console.log`. Scope it to its context so output is attributable:

```ts
private readonly logger = new Logger(UsersService.name);
```

Log at a level that matches severity, and never log credentials, tokens,
full request bodies, or other personal data.
