# Persistence

NestJS ships no ORM of its own. `@nestjs/typeorm` (wrapping TypeORM) is the
most-documented first-party integration, but Prisma, Mongoose (via
`@nestjs/mongoose`), Sequelize and MikroORM are all common in real projects.
**Check which one this project actually depends on before assuming any of
the patterns below apply verbatim** — the DI-injection shape and the
`Module.forRoot()`/`forFeature()` wiring differ per integration, and the MCP
manual covers the framework-side integration for each, not just TypeORM.
The examples here use TypeORM, since it is what NestJS's own docs lean on
most heavily.

## Entities and repositories

An entity is a plain class decorated with `@Entity()`; a repository is
injected per-entity, not written by hand.

```ts
@Entity()
export class Article {
  @PrimaryGeneratedColumn() id: number;
  @Column() title: string;
  @Column({ default: false }) published: boolean;
  @ManyToOne(() => User, (user) => user.articles) author: User;
  @ManyToMany(() => Tag) @JoinTable() tags: Tag[];
  @CreateDateColumn() createdAt: Date;
}
```

```ts
@Injectable()
export class ArticlesService {
  constructor(@InjectRepository(Article) private readonly repo: Repository<Article>) {}
}
```

## Relations

| Decorator | Meaning | FK location |
|---|---|---|
| `@ManyToOne` | Article belongs to one User | on `article` |
| `@OneToMany` | User has many Articles | on `article` (inverse side) |
| `@OneToOne` | User has one Profile | either side, `@JoinColumn()` marks owner |
| `@ManyToMany` | Article ↔ Tags | join table, `@JoinTable()` on owning side |

Load relations explicitly rather than relying on lazy access in a loop —
the latter produces N+1 queries.

```ts
this.repo.find({
  where: { published: true },
  relations: { author: true, tags: true },
  order: { createdAt: 'DESC' },
});
```

Or with the query builder, for anything the `find()` options shape cannot
express:

```ts
this.repo
  .createQueryBuilder('article')
  .leftJoinAndSelect('article.author', 'author')
  .where('article.published = :published', { published: true })
  .orderBy('article.createdAt', 'DESC')
  .getMany();
```

## Custom queries

Reusable query logic belongs in the service (or a custom repository class),
not repeated across controllers.

```ts
findPublished(): Promise<Article[]> {
  return this.repo.find({ where: { published: true }, order: { createdAt: 'DESC' } });
}
```

## Repository classes

For a component with more than a couple of ad hoc queries, promote the
repository from "whatever `@InjectRepository()` gives you" to an injectable
class of its own, with named, intention-revealing methods, registered from
that component's own `<name>-db.module.ts` (see `references/architecture.md`):

```ts
@Injectable()
export class OrdersRepository extends Repository<Order> {
  constructor(@InjectRepository(Order) repo: Repository<Order>) {
    super(repo.target, repo.manager, repo.queryRunner);
  }

  pendingForCustomer(customerId: number): Promise<Order[]> {
    return this.find({ where: { customerId, status: OrderStatus.PENDING } });
  }

  overdueSince(date: Date): Promise<Order[]> {
    return this.find({ where: { status: OrderStatus.PENDING, createdAt: LessThan(date) } });
  }
}
```

```ts
@Module({
  imports: [TypeOrmModule.forFeature([Order])],
  providers: [OrdersRepository],
  exports: [OrdersRepository],
})
export class OrdersDbModule {}
```

The service then calls `this.orders.pendingForCustomer(id)` instead of
building that `where` clause inline — and a second caller that needs the
same query gets the tested method instead of a second, possibly-subtly-wrong
copy of it. This is a project-level pattern, not something TypeORM requires;
confirm whether a given codebase does this before assuming
`@InjectRepository()` directly in the service is "wrong" — both are
legitimate, and consistency with what's already there matters more than
which one.

## Read-only views

A query that exists purely to read pre-aggregated or heavily-joined data
(a leaderboard, a report, a denormalised search index) is sometimes better
expressed as a database view than as application-level query logic repeated
on every request. TypeORM maps a `VIEW` to its own entity class:

```ts
@ViewEntity({
  expression: (connection) => connection
    .createQueryBuilder()
    .select('order.customerId', 'customerId')
    .addSelect('SUM(order.totalAmount)', 'lifetimeValue')
    .from(Order, 'order')
    .groupBy('order.customerId'),
})
export class CustomerLifetimeValueView {
  @ViewColumn() customerId: number;
  @ViewColumn() lifetimeValue: number;
}
```

It behaves like any other entity for reads (`repository.find()`,
relations), but is never written to directly and needs a migration to create
the underlying view. Reach for this once a query is expensive or reused
enough to be worth optimising at the database layer — not as a default way
to model read data.

## Saving

```ts
async create(request: TCreateArticleRequest, author: User): Promise<Article> {
  const article = this.repo.create({ ...request, author });
  return this.repo.save(article);
}
```

`repo.create()` builds an entity instance from a plain object without
touching the database; `repo.save()` performs the insert/update and returns
the persisted entity, throwing on failure (a DB constraint violation surfaces
as `QueryFailedError`) — there is no "returns false" convention to check.
Never pass a raw request body straight to `create()`/`save()`; build the
object explicitly, or ensure the DTO/type is the sole source of assignable
fields (see `references/security.md`). Note the parameter here is
`TCreateArticleRequest`, the plain type the DTO implements, not the DTO class
itself — the service has no business depending on a `class-validator`-decorated
class. See `references/conventions.md`.

For multi-step writes that must succeed together, use a transaction:

```ts
await this.dataSource.transaction(async (manager) => {
  await manager.save(order);
  await manager.decrement(Inventory, { sku: item.sku }, 'quantity', item.qty);
});
```

## Validation vs domain rules

Two distinct mechanisms, and using the wrong one is a common design error —
directly analogous to keeping shape-validation and integrity-checking
separate in any layered architecture.

**DTO validation** — shape of incoming data, no database needed. Runs in the
`ValidationPipe`, before the handler is even called.

```ts
export type TCreateArticleRequest = {
  title: string;
  contactEmail?: string;
};

export class CreateArticleRequestDto implements TCreateArticleRequest {
  @IsString() @IsNotEmpty() @MaxLength(255) title: string;
  @IsEmail() @IsOptional() contactEmail?: string;
}
```

**Domain rules** — integrity that requires the database (uniqueness,
referential checks, business invariants). These cannot live in a DTO, because
a DTO is constructed and validated before any repository is involved. Put
them in the service, right before (or wrapped in the same transaction as) the
save:

```ts
async create(request: TCreateUserRequest): Promise<User> {
  const exists = await this.repo.exists({ where: { email: request.email } });
  if (exists) {
    throw new ConflictException('Email already registered');
  }
  return this.repo.save(this.repo.create(request));
}
```

A unique index at the database level is still worth having as a backstop
against races between the check and the write — catch the resulting
`QueryFailedError` and translate it to the same `ConflictException` rather
than letting a raw database error escape as a 500.

## Lifecycle hooks

For behaviour that must run whenever an entity is inserted/updated/removed
regardless of which service triggered it (denormalising a field, invalidating
a cache, emitting an event), TypeORM offers both entity-level decorators
(`@BeforeInsert()`, `@AfterUpdate()` on the entity class itself) and a
separate `EntitySubscriberInterface` class per entity for the same hooks kept
out of the entity file:

```ts
@EventSubscriber()
export class OrderSubscriber implements EntitySubscriberInterface<Order> {
  listenTo() { return Order; }

  afterInsert({ entity }: InsertEvent<Order>): void {
    // e.g. emit an event, invalidate a cache entry
  }
}
```

Reach for a subscriber over inline entity decorators once the hook needs
injected dependencies (a logger, an event emitter) that an entity class — a
plain data shape, not a DI-managed provider — cannot receive. Keep hooks
narrow: business logic spanning multiple entities belongs in a service, not
a subscriber reacting to a side effect of persistence.

## Performance

- Load only the relations you actually need (`relations: {...}` or an
  explicit join); avoid N+1 access inside loops.
- `select` only the columns required for large result sets.
- Paginate anything unbounded — see `references/controllers.md`.
- For bulk writes, prefer `repo.insert()`/a single `UPDATE ... WHERE` over
  per-entity `save()` in a loop — but note bulk operations bypass entity
  lifecycle hooks (`@BeforeInsert()`, etc.) by design, same trade-off as any
  ORM's bulk-update escape hatch.
