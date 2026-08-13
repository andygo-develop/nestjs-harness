# Controllers

## Keep them thin

A handler should read input, delegate to a service, and choose a response
shape. If a handler contains business rules, multi-step domain logic or
complex queries, that logic belongs in a service. It should also never hand
back an entity as-is — every response is wrapped in a serializer, so what
leaves the API is an explicit, reviewable shape rather than whatever columns
and relations the ORM happens to expose (see "Serializing responses with
dedicated classes" below).

```ts
@UseInterceptors(ClassSerializerInterceptor)
@Controller('articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Get()
  async findAll(@Query() query: ListArticlesRequestDto): Promise<ArticleSerializer[]> {
    const articles = await this.articles.findPublished(query);
    return articles.map((article) => new ArticleSerializer(article));
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<ArticleSerializer> {
    return new ArticleSerializer(await this.articles.getByIdOrThrow(id));
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Body() dto: CreateArticleRequestDto, @CurrentUser() user: User): Promise<ArticleSerializer> {
    return new ArticleSerializer(await this.articles.create(dto, user));
  }
}
```

Note the shape: decorators declare the route and extract typed input; the
body is a couple of lines that delegate and wrap the result in a serializer.
Deviating from it — extra branching, reaching into request internals, or
returning the bare entity — is usually a sign logic is leaking into the
wrong layer.

## Request

```ts
@Param('id') id: string                 // route parameter
@Query() query: ListArticlesRequestDto  // query string, ideally typed via a DTO
@Body() dto: CreateArticleRequestDto    // request body, always via a DTO
@Headers('authorization') auth: string
@Req() req: Request                     // the raw request — reach for this only when nothing else fits
```

Never trust request data directly. Route params and query strings should be
parsed/validated with a pipe (`ParseIntPipe`, a custom pipe, or a query DTO);
bodies must go through a DTO with `class-validator` decorators and a
`ValidationPipe` configured with `whitelist: true` — see
`references/security.md`.

## Response

Whatever a handler returns is serialized to JSON automatically. Use
decorators for anything that deviates from "200 with the returned value":

```ts
@Post()
@HttpCode(201)
create(@Body() dto: CreateArticleRequestDto) { ... }

@Get('legacy')
@Redirect('https://example.com/new-location', 301)
legacy() {}
```

Never return an entity — or anything built directly from one — straight from
a handler. Route every response through a serializer class (below) so what's
exposed is an explicit, reviewable allow-list instead of whatever columns and
relations the ORM happens to know about. A global `class-transformer`
`@Exclude()` plus `ClassSerializerInterceptor` is a floor, not a substitute
for that: it only hides the fields someone remembered to mark, not the ones a
future migration adds. See `references/security.md` for the
mass-assignment/leakage angle.

## Serializing responses with dedicated classes

An entity's shape and an endpoint's response shape are different things —
the entity has every column and relation the ORM knows about, and no single
endpoint should return all of it. A dedicated serializer class per response
shape keeps that mapping explicit instead of leaking storage details into
the API:

```ts
@Exclude()
export class OrderSerializer implements Partial<Order> {
  @Expose() readonly id: number;
  @Expose() readonly status: OrderStatus;
  @Expose() readonly totalAmount: number;
  // internalCostBasis, supplierNotes etc. are on the entity but not exposed here
}
```

Applied via the built-in interceptor, scoped per handler or per controller
— never left to a single app-wide interceptor to cover every shape in the
codebase:

```ts
@UseInterceptors(ClassSerializerInterceptor)
@Get(':id')
async findOne(@Param('id') id: number): Promise<OrderSerializer> {
  return new OrderSerializer(await this.orders.getByIdOrThrow(id));
}
```

Once a codebase has many endpoints doing this, wrapping the interceptor in a
custom `@Serialize(SomeSerializer)` decorator (built with `applyDecorators()`
around `@UseInterceptors()` plus a `Reflector`-read metadata key naming the
target class) removes the per-handler boilerplate and lets Swagger's
`@ApiOkResponse({ type: SomeSerializer })` stay in sync with what's actually
returned. That convenience wrapper is a project-level decision, not a NestJS
default — verify whether this project already has one before introducing a
second one; the underlying rule, that every response is a serializer
instance and never the raw entity, is not optional, only the sugar around
applying it is.

One serializer per *shape*, not per entity: an order list view, an order
detail view, and an admin view of the same order are three different
serializers if they expose different fields, named for the audience or
context they serve (`OrderCompactSerializer`, `OrderDetailedSerializer`,
`AdminOrderSerializer`) rather than forcing one serializer to grow optional
fields for every caller.

## Not-found handling

Throw, don't return null-and-hope:

```ts
async getByIdOrThrow(id: number): Promise<Article> {
  const article = await this.repo.findOneBy({ id });
  if (!article) {
    throw new NotFoundException(`Article ${id} not found`);
  }
  return article;
}
```

`NotFoundException` (and the rest of the built-in HTTP exception classes) is
caught by Nest's default exception filter and turned into the right status
code and JSON error shape. Don't wrap this in a try/catch that swallows it
into a 200 with empty content.

## Cross-cutting controller behaviour

NestJS has no single "base controller" convention the way some frameworks
do. Shared request-handling behaviour — auth checks, response shaping,
logging — is expressed as a guard, interceptor or pipe applied at the
controller or method level (`@UseGuards()`, `@UseInterceptors()`,
`@UsePipes()`), or globally in `main.ts`/via an `APP_*` provider. See
`references/middleware.md`. Reach for a shared base *class* only for
literal, small, controller-specific helper methods — not as a place to hide
business logic that belongs in a service.

## Splitting controllers by audience

A single resource accessed very differently by different callers — an admin
who sees everything, a customer who sees their own records, a partner
integration with its own auth — is often better served by several small
controllers than one controller with scattered role checks:

```ts
// components/orders/controllers/admin.controller.ts
@Controller('admin/orders')
export class AdminController { /* ... */ }

// components/orders/controllers/customer.controller.ts
@Controller('orders')
export class CustomerController { /* ... */ }
```

The class stays `AdminController`, not `AdminOrdersController` — the
`orders` component the file lives in already says which resource this is,
so the class name only needs to say who it's for. Each controller stays
thin and its `@UseGuards()`/route prefix documents who it's for at a
glance, instead of every handler branching on the caller's role internally.
Reach for this once the role-based branching inside one controller gets
hard to follow — a resource with one audience doesn't need it.

All of a component's controllers are wired into its own
`<name>-controllers.module.ts`, not into `<name>.module.ts` — see
`references/architecture.md` for why that split exists and
`references/conventions.md` for the full file layout.

## Pagination

Always paginate unbounded lists. NestJS has no built-in pagination the way
some frameworks do — express it explicitly through a query DTO:

```ts
export type TListArticlesRequest = {
  offset: number;
  limit: number;
};

export class ListArticlesRequestDto implements TListArticlesRequest {
  @IsOptional() @IsInt() @Min(0) offset = 0;
  @IsOptional() @IsInt() @Min(1) @Max(100) limit = 25;
}
```

The controller binds `@Query()` to the concrete `ListArticlesRequestDto`, so
`ValidationPipe` has a real class to instantiate and validate — but the
service takes the plain `TListArticlesRequest` type, not the DTO class, since
it has no reason to depend on a `class-validator`-decorated type. See
`references/conventions.md`.

```ts
findPublished({ offset, limit }: TListArticlesRequest) {
  return this.repo.find({
    where: { published: true },
    order: { createdAt: 'DESC' },
    skip: offset,
    take: limit,
  });
}
```

Cap `limit` (validated above, not just documented) so a client cannot request
an unbounded page. Confirm the project's actual pagination convention — a
cursor-based approach is common for large or frequently-changing result sets
— before assuming offset/limit is what this codebase uses.
