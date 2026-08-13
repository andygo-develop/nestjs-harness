# Conventions

NestJS infers less from naming than some frameworks — routing and DI wiring
are explicit, driven by decorators, not filename magic. But the ecosystem has
strong naming conventions of its own, and the Nest CLI generates code that
follows them. Deviating costs discoverability rather than working code.

## Files

kebab-case, suffixed by role:

| Role | File |
|---|---|
| Module | `users.module.ts` |
| Controller | `users.controller.ts` |
| Provider / service | `users.service.ts` |
| Repository | `users.repository.ts` |
| Serializer | `user.serializer.ts` |
| Config | `stripe.config.ts` (in that component's own `configs/`) |
| DTO | `create-user-request.dto.ts`, `update-user-request.dto.ts` — implements a `T<Name>Request` type, see below |
| Entity | `user.entity.ts` |
| Enum | `order-status.enum.ts` (in that component's own `enums/`) |
| Interface | `payment-gateway.interface.ts` (in that component's own `interfaces/`) |
| Type | `order-summary.type.ts` (in that component's own `types/`) |
| Guard | `jwt-auth.guard.ts` |
| Pipe | `parse-object-id.pipe.ts` |
| Interceptor | `logging.interceptor.ts` |
| Exception filter | `http-exception.filter.ts` |
| Custom decorator | `current-user.decorator.ts` |
| Custom validator constraint | `is-valid-sku.constraint.ts` (paired with `is-valid-sku.decorator.ts`) |
| Event listener | `orders.listener.ts` |
| Queue processor | `export.processor.ts` |
| CLI command | `backfill-avatars.command.ts` |
| Unit test | `users.service.spec.ts` (in `tests/services/`, mirroring `services/`) — some codebases use `.test.ts` instead; match whichever the project already uses |
| e2e test | `users.e2e-spec.ts` (in `tests/controllers/`, mirroring `controllers/`, full HTTP stack) |

## Classes

PascalCase, suffixed to match the file's role: `UsersController`,
`UsersService`, `UsersRepository`, `UserSerializer`, `UsersModule`,
`CreateUserRequestDto`, `JwtAuthGuard`. Entities are typically the bare noun
with no suffix: `User`, not `UserEntity` — though plenty of real codebases do
the opposite consistently (`UserEntity`) to keep entity, DTO and serializer
names visually distinct at a glance; either is fine as long as it is applied
uniformly.

Methods and variables: `camelCase`. Constants: `UPPER_SNAKE_CASE`.

Type aliases, interfaces and enums each get a letter prefix and their own
subfolder, so the shape of an unfamiliar import is obvious both from its
name and from where it lives, without opening the file:

| Kind | Prefix | Example | Folder |
|---|---|---|---|
| Type alias | `T` | `TUser`, `TCreateArticleRequest` | `types/` |
| Interface | `I` | `IUserProvider`, `IPaymentGateway` | `interfaces/` |
| Enum | `E` | `EUserRole`, `EOrderStatus` | `enums/` |

This is a project convention, not a NestJS one — NestJS itself has no
opinion on prefixing — but it applies uniformly here: every type alias,
interface and enum gets its letter prefix and lives in its kind's subfolder,
not just the ones in a codebase that happened to adopt the habit already.

## Request DTOs and their type contract

A DTO class exists to satisfy `class-validator`/`class-transformer` at the
HTTP boundary — `ValidationPipe` needs a real, decorated class it can
instantiate and run validators against. Nothing past the controller needs
that: a service typed directly against the DTO class couples business logic
to a validation-layer detail it has no reason to know about. Pair every
request DTO with a plain `T<Name>Request` type describing its shape — its own
file in `types/`, per the prefix/folder rule above — and have the DTO
implement it:

```ts
// types/create-article-request.type.ts
export type TCreateArticleRequest = {
  title: string;
  contactEmail?: string;
};
```

```ts
// dtos/create-article-request.dto.ts
import { TCreateArticleRequest } from '../types/create-article-request.type';

export class CreateArticleRequestDto implements TCreateArticleRequest {
  @IsString() @IsNotEmpty() @MaxLength(255) title: string;
  @IsEmail() @IsOptional() contactEmail?: string;
}
```

The controller still binds `@Body()`/`@Query()` to the concrete
`CreateArticleRequestDto` — NestJS needs a real class there for validation to
run. Everything past that boundary — service methods, repository calls, unit
test fixtures — takes `TCreateArticleRequest` instead, so that code has no
import-time dependency on a `class-validator`-decorated class it has no use
for. See `references/controllers.md` and `references/orm.md`.

## Directory layout

Every module's code lives inside a **component** — a folder for one business
domain or one infrastructure integration — and within a component, files
are grouped by role in their own subfolder. There is no size threshold below
which that stops applying: even a component with a single service still
gets a `services/` folder, so where a given file lives is never a guess.

```
src/orders/
├── orders.module.ts
├── orders-controllers.module.ts    optional — see "Splitting a large component" below
├── orders-db.module.ts
├── orders-constraints.module.ts
├── configs/
│   └── orders.config.ts            this component's own settings, not app.module.ts's
├── controllers/
│   └── orders.controller.ts
├── services/
│   └── orders.service.ts
├── repositories/
│   └── orders.repository.ts
├── serializers/
│   └── order.serializer.ts
├── dtos/
│   ├── create-order-request.dto.ts
│   └── list-orders-request.dto.ts
├── entities/
│   └── order.entity.ts
├── enums/
│   └── order-status.enum.ts             EOrderStatus
├── interfaces/
│   └── payment-gateway.interface.ts     IPaymentGateway
├── types/
│   ├── create-order-request.type.ts     TCreateOrderRequest
│   └── list-orders-request.type.ts      TListOrdersRequest
├── listeners/
│   └── orders.listener.ts          @nestjs/event-emitter handlers
├── processors/
│   └── export.processor.ts         @nestjs/bullmq (or similar) queue workers
├── constraints/
│   └── is-valid-sku.constraint.ts  custom class-validator rule
├── decorators/
│   └── is-valid-sku.decorator.ts   composes the constraint into a usable decorator
├── cli/
│   ├── orders-cli.module.ts
│   └── commands/
│       └── backfill-order-totals.command.ts
└── tests/
    ├── services/
    │   └── orders.service.spec.ts          unit test
    └── controllers/
        └── orders.controller.e2e-spec.ts   e2e test, full HTTP stack
```

Every component owns one `tests/` folder for everything that tests it — unit
and end-to-end alike — mirroring the component's own role subfolders one
level down (`tests/services/`, `tests/controllers/`, and so on). There is no
project-wide `test/` directory and no colocating a spec file next to the
source file it tests; see `references/testing.md` for the full testing
conventions.

`@Module()` files (`orders.module.ts` and its split-out siblings, below) sit
directly in the component root, since there are only ever a handful of
them; everything else — the actual code — goes in its role's subfolder.
See `references/architecture.md` for where components sit relative to
`src/`, for the shared `app` component, and for the full table of what each
split-out module file (`-controllers`, `-db`, `-cli`, `-constraints`) owns.

Not layer-per-domain across the *whole app* (`src/controllers/`,
`src/services/`, `src/entities/` each holding every component's files, with
no per-component grouping at all) — the component boundary is the unit of
composition and of testing, and grouping by technical layer at the top level
scatters a single feature across the tree. The subfolders above are a
different, reasonable thing: they organise what's *inside* one component,
they don't fight the component boundary.

## Separating features from infrastructure

A component is either a *feature* (it encodes a business rule — orders,
users, billing) or a *provider* (it wraps an external dependency — the
database, Redis, a payment gateway); both kinds live side by side under
`components/`, and nothing in the folder layout marks which is which. The
rule that matters: a feature component may depend on a provider component
(`OrdersModule` imports `StripeModule`); a provider component should not
depend on a feature component. See `references/architecture.md` for the
full reasoning and why this has to be caught in review rather than by the
directory structure.

## Splitting a large component into several modules

A component with many controllers, a persistence layer, and a scheduled job
does not have to cram everything into one `@Module()`. Splitting by concern
keeps each module's `imports` array honest about what it actually needs —
see `references/architecture.md` for the full table of which split-out
module owns what and who is allowed to import it:

```ts
// orders-db.module.ts — owns the repository and its TypeORM registration
@Module({
  imports: [TypeOrmModule.forFeature([Order])],
  providers: [OrdersRepository],
  exports: [OrdersRepository],
})
export class OrdersDbModule {}
```

```ts
// orders.module.ts — the component's services, importable by other components
@Module({
  imports: [OrdersDbModule],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
```

```ts
// orders-controllers.module.ts — wired into AppModule; nothing else imports this one
@Module({
  imports: [OrdersModule],
  controllers: [OrdersController],
})
export class OrdersControllersModule {}
```

```ts
// orders-constraints.module.ts — the domain's async class-validator constraints,
// each needing its own injected dependency (see references/security.md)
@Module({
  imports: [OrdersDbModule],
  providers: [IsValidSkuConstraint],
  exports: [IsValidSkuConstraint],
})
export class OrdersConstraintsModule {}
```

This only pays for itself once a component is genuinely large — for the
common case, one `orders.module.ts` declaring everything is simpler and
should stay that way. Introduce the split when the single module file
becomes hard to scan, not preemptively.

## Splitting controllers and DTOs by audience

When the same resource is exposed very differently to different callers — an
admin endpoint that returns everything, a customer-facing endpoint that
returns a filtered subset, a partner-facing endpoint with its own auth —
prefer several small, purpose-named controllers over one controller with
scattered role checks:

```
src/orders/controllers/
├── admin.controller.ts     @Controller('admin/orders')
├── customer.controller.ts  @Controller('orders')
└── partner.controller.ts   @Controller('partner/orders')
```

DTOs can follow the same split when the accepted shape genuinely differs per
audience (`dtos/admin/update-order-request.dto.ts` vs
`dtos/customer/place-order-request.dto.ts`) — but only when the shapes
actually differ. Don't fork a DTO that would be identical in both folders
just to mirror the controller split.

## Path aliases

Deeply nested relative imports (`../../../../orders/entities/order.entity`)
get unreadable fast in a component-per-domain layout. Map each top-level
directory to an alias in `tsconfig.json`:

```json
"paths": {
  "@app/*": ["./src/*"],
  "@components/*": ["./src/components/*"]
}
```

```ts
import { OrdersRepository } from '@components/orders/repositories/orders.repository';
import { StripeService } from '@components/stripe/services/stripe.service';
```

One alias covers every component regardless of whether it's a feature or a
provider — they live under the same `components/` directory, so there is no
second alias to keep in sync with a directory split that no longer exists.

Nest's build (`tsc` or `swc`) resolves these at compile time; nothing extra
is needed at runtime beyond what the project's build already does. Confirm
which aliases (if any) a project has already defined before introducing a
new one — a second, overlapping alias scheme is worse than none.

## Nest CLI

`nest generate` (aliased `nest g`) scaffolds a resource with the conventional
name and location, and wires it into the nearest module automatically:

```bash
nest g module orders
nest g controller orders
nest g service orders
nest g resource orders    # module + controller + service + CRUD DTOs together
```

Prefer it over hand-rolling boilerplate — consistent naming across a large
codebase matters more than the few seconds it saves.

## Barrel files

Nest's own style guide advises against `index.ts` barrel re-exports inside
feature modules — they are a common source of circular-import errors between
modules that Nest's DI graph then reports confusingly. Import directly from
the file that defines what you need.

## Code style

ESLint + Prettier, configured by the Nest CLI's default project template:

```bash
npm run lint
npm run format
```

Match the surrounding code in the project you are editing — indentation,
import ordering and whether `interface` or `type` is preferred are project
decisions, not framework ones.

## When to break convention

Genuinely cross-cutting code (a pipe every component needs, a base class
with no domain of its own) belongs in the `app` component
(`src/components/app/`, see `references/architecture.md`), imported
explicitly by whatever component needs it — not duplicated per component,
and not dumped into `app` just because it's convenient, when it actually
belongs to one specific domain. Override the specific thing that differs,
where it differs; do not adopt a project-wide alternative layout so a
handful of legacy components do not have to be moved.
