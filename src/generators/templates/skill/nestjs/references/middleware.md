# The request pipeline

NestJS spreads cross-cutting concerns across five distinct mechanisms rather
than one middleware stack. Knowing which one a piece of logic belongs in —
and the order they run in — matters as much as knowing any single one of
them.

## Execution order

```
Middleware → Guards → Interceptors (pre) → Pipes → Route handler
                                                         │
Exception filters ← Interceptors (post) ←───────────────┘
```

- **Middleware** runs first, before routing has fully resolved which handler
  and guards apply. No `ExecutionContext`, no knowledge of which controller
  method will run.
- **Guards** run next, per matched route. They decide whether the request may
  proceed at all — authentication and authorization belong here.
- **Interceptors** wrap the handler on both sides: code before
  `next.handle()` runs pre-handler, code in the `pipe()` after it runs
  post-handler, once a response exists.
- **Pipes** run per-parameter, immediately before the handler receives that
  argument — validation and transformation.
- **Exception filters** catch anything thrown by guards, interceptors, pipes
  or the handler itself, anywhere in the chain, and turn it into an HTTP
  response.

## Where these files live

Same rule as anything else — see `references/architecture.md`. A guard,
interceptor, pipe or filter used by one component only (a payments-specific
interceptor, an auth-specific guard) lives in that component's own
`guards/`/`interceptors/`/`pipes/`/`filters/` folder. One genuinely applied
everywhere — a global `ValidationPipe`, a project-wide `HttpExceptionFilter`
— lives in the `app` component instead, registered once (`app.useGlobalPipes()`
etc. in `main.ts`, or an `APP_PIPE`/`APP_GUARD`/`APP_INTERCEPTOR`/`APP_FILTER`
provider in `app.module.ts`) rather than reapplied per component. Being
usable by several components is not by itself a reason to move something
into `app` — see `references/architecture.md` for why.

## Middleware

Implements `NestMiddleware`, or is a plain function. Configured in a module's
`configure()`, not via a decorator — this is one of the few places NestJS
still wires things up imperatively rather than declaratively.

```ts
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLoggerMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    this.logger.log(`${req.method} ${req.originalUrl}`);
    next();
  }
}

@Module({ ... })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestLoggerMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
```

Call `next()` exactly once for a normal pass-through. Middleware operates on
the underlying platform's request/response (Express or Fastify) — mutate
them directly rather than expecting PSR-style immutability.

Use middleware for genuinely platform-level, pre-routing concerns (request
logging, `helmet`, body parsing). Logic that needs to know which handler is
about to run, or needs the DI-resolved `ExecutionContext`, belongs in a guard
or interceptor instead.

## Guards

Implement `CanActivate`. Return (or resolve to) `true` to allow the request,
`false` or a thrown exception to reject it.

```ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string[]>('roles', context.getHandler());
    if (!required) return true;

    const { user } = context.switchToHttp().getRequest();
    return required.some((role) => user?.roles?.includes(role));
  }
}
```

`Reflector` is how a guard reads metadata attached by a custom decorator
(`@Roles('admin')`) — this is the standard pattern for parameterising a
guard per-route. Apply guards with `@UseGuards()` on a controller or handler,
or globally via `app.useGlobalGuards()` / an `APP_GUARD` provider.

## Interceptors

Implement `NestInterceptor`. `intercept(context, next)` runs before the
handler; calling `next.handle()` invokes it and returns an RxJS `Observable`
you can `pipe()` to transform the response, time it, or catch and rethrow.

```ts
@Injectable()
export class TimingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    return next.handle().pipe(
      tap(() => Logger.log(`${Date.now() - start}ms`, TimingInterceptor.name)),
    );
  }
}
```

Common uses: response shaping (`ClassSerializerInterceptor` applying
`@Exclude()`), caching, logging, timeouts. Business logic does not belong
here — an interceptor should not decide *whether* a request is valid (that's
a guard or pipe), only *observe or transform* it.

## Pipes

Implement `PipeTransform`. `transform(value, metadata)` validates and/or
converts a single argument before the handler sees it.

```ts
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, ObjectId> {
  transform(value: string): ObjectId {
    if (!ObjectId.isValid(value)) {
      throw new BadRequestException(`"${value}" is not a valid id`);
    }
    return new ObjectId(value);
  }
}
```

`ValidationPipe` (built in, backed by `class-validator`/`class-transformer`)
is the one nearly every project registers globally — see
`references/security.md` for the options that make it a real mass-assignment
defence, not just a shape check.

## Exception filters

Implement `ExceptionFilter`, decorated with `@Catch()` (unfiltered, or scoped
to specific exception types). `catch(exception, host)` turns a thrown error
into a response.

```ts
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();

    res.status(status).json({
      statusCode: status,
      path: ctx.getRequest<Request>().url,
      message: exception.message,
    });
  }
}
```

Nest's built-in filter already does something reasonable with no
configuration; write a custom one to normalise the error *shape* across the
API, not to replace error handling that already works.

## When each one is the wrong tool

Business logic never belongs in middleware, a guard, or an interceptor —
those layers exist to gate, observe or transform, not to compute. Logic that
applies to a handful of specific handlers usually belongs in the service
those handlers already call, not in a new pipeline component reused by
coincidence.

Verify exact interfaces, constructor options and registration APIs with the
MCP — the shape of `ExecutionContext`, and how globally-registered pipes and
filters interact with DI, are exactly the kind of detail that has shifted
across major versions.
