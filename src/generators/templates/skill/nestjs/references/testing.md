# Testing

NestJS projects default to Jest. Run them with `npm test` (unit) and
`npm run test:e2e` (end-to-end) — verify the actual script names in this
project's `package.json`, since the CLI-generated defaults are a starting
point, not a guarantee.

## Layout

```
src/
└── orders/
    ├── services/
    │   └── orders.service.ts
    ├── controllers/
    │   └── orders.controller.ts
    └── tests/
        ├── services/
        │   └── orders.service.spec.ts          unit test
        └── controllers/
            └── orders.controller.e2e-spec.ts   end-to-end test, full HTTP stack
```

Every component owns one `tests/` folder for everything that tests it — unit
and end-to-end alike — and `tests/` mirrors the component's own role
subfolders one level down: a service's test lives in `tests/services/`, a
controller's in `tests/controllers/`, and so on for any other role that gets
tests. Nothing sits next to the source file it tests, and nothing is collected
in a project-wide `test/` directory. `.spec.ts` is the Nest CLI default; some
codebases use `.test.ts` instead — that is just a Jest `testMatch`
configuration choice, and either is fine as long as it is applied
consistently. The mirrored `tests/` layout is this harness's convention
regardless of which naming a project uses; if an existing project already has
an established, different test layout, match that instead of introducing a
second one.

## Sharing test-module setup across a large suite

A component with several controllers and many e2e tests ends up
re-declaring the same `imports`/mocked providers in every test file if each
one calls `Test.createTestingModule({...})` from scratch. Once that
duplication is real, factor the common setup into one helper the
component's tests share:

```ts
// orders/tests/orders-testing.module.ts
export async function createOrdersTestingModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [OrdersModule, OrdersControllersModule],
    providers: [{ provide: PAYMENT_GATEWAY, useValue: paymentGatewayMock() }],
  }).compile();
}
```

Each test file then calls the helper instead of repeating the module graph
and mocks:

```ts
describe('OrdersController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await createOrdersTestingModule();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  // ...
});
```

This is worth introducing once a component has enough tests that the
boilerplate is the thing changing between files, not the assertions — for a
handful of tests, the plain `Test.createTestingModule()` call inline is
simpler and should stay that way.

## Unit tests

Build a minimal `TestingModule` with only the providers under test, and
override anything that would otherwise need real infrastructure.

```ts
describe('UsersService', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockRepo() },
      ],
    }).compile();

    service = module.get(UsersService);
    repo = module.get(getRepositoryToken(User));
  });

  it('rejects a duplicate email', async () => {
    repo.exists.mockResolvedValue(true);

    await expect(service.create({ email: 'a@example.com' } as TCreateUserRequest))
      .rejects.toThrow(ConflictException);
  });
});
```

`overrideProvider(Token).useValue(...)` on the `TestingModuleBuilder` is the
alternative when a module already declares the provider and you just need to
swap its implementation for the test, rather than declaring providers from
scratch.

Providers that take their dependencies through the constructor need no
module bootstrap beyond what's declared above and no real database — that is
the payoff for keeping domain logic in services rather than controllers.

## End-to-end tests

Boot the real module graph and drive it over HTTP with Supertest — this is
the right tool for "does this endpoint behave correctly", including guards,
pipes and validation.

```ts
describe('ArticlesController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /articles returns published articles', () => {
    return request(app.getHttpServer())
      .get('/articles')
      .expect(200)
      .expect((res) => {
        expect(res.body).toContainEqual(expect.objectContaining({ title: 'First Article' }));
      });
  });

  it('POST /articles requires authentication', () => {
    return request(app.getHttpServer())
      .post('/articles')
      .send({ title: 'x' })
      .expect(401);
  });
});
```

Register the same global pipes/filters/interceptors the real `main.ts` does
— an e2e test built against a bare `AppModule` with no `ValidationPipe`
registered will pass while the deployed app behaves differently, which
defeats the point of testing at this level.

For a real database in e2e tests, prefer an actual (test/ephemeral) database
over mocking the ORM — a mocked repository cannot catch a broken migration,
a bad relation, or a query that is invalid SQL. Confirm how this project
provisions its test database before assuming a particular approach (a
disposable container, an in-memory SQLite substitute, a shared test schema).

## Mocking

Mock at the provider boundary (`jest.fn()`/`jest.Mocked<T>` for a repository
or an external client), not the module under test. Do not mock the service
whose logic the test exists to verify.

## What to test

Worth testing:

- Guards and pipes reject what they should — an unauthenticated request, an
  invalid DTO, a param that fails a custom pipe.
- DTO validation rejects bad input and accepts good input (edge cases:
  missing required fields, wrong types, extra unexpected fields with
  `forbidNonWhitelisted`).
- Service-level domain rules — uniqueness, business invariants — actually
  block violations, including via a real database in an e2e/integration
  test, not just a mock that assumes the constraint exists.
- Authorization: a user without the required role is refused, not just "the
  happy path returns 200".
- Response shape: a serialized response exposes only what its serializer
  declares — assert a sensitive field (`passwordHash`, `internalCostBasis`)
  is genuinely absent from `res.body`, not just that the happy-path fields
  are present.
- Domain/service logic, including error paths.
- Anything that has broken before.

Not worth testing: that the framework itself works, or that a third-party
library does what its own tests already prove.

Test behaviour, not implementation. Asserting on the exact SQL a query
builder call produces makes refactoring painful for no safety gain — assert
on the rows/response actually returned.
