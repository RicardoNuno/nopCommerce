### How are the layers organised and what are the dependency rules between them?

nopCommerce closely follows an [onion architecture](https://docs.nopcommerce.com/en/developer/tutorials/architecture-of-nopCommerce.html), but not strictly. Dependencies only point inward (never outward). However, outer layers can reference any inner layer directly, not just the adjacent one.

![nopCommerce Architecture](nopCommerceArchitecture.png)

Note: the diagram shows separate test rings per layer, but the solution contains a single test project (`Nop.Tests`) with logical groupings inside it.

The solution is organised into the following physical directories under `src/`:

- **`Libraries/`** - the Application Core: `Nop.Core`, `Nop.Data`, and `Nop.Services`.
- **`Presentation/`** - the web-facing layer: `Nop.Web` and `Nop.Web.Framework`.
- **`Plugins/`** - all 31 plugin projects (source code lives here; build output deploys into `Presentation/Nop.Web/Plugins/`).
- **`Tests/`** - the single test project `Nop.Tests`.
- **`Build/`** - build and packaging scripts.

The dependency rules are enforced through project references in the `.csproj` files:

| Project | Depends on | Responsibility |
|---------|-----------|----------------|
| **Nop.Core** | (none) | Domain entities, caching abstractions, and event contracts |
| **Nop.Data** | Nop.Core | Data access layer using [linq2db](https://docs.nopcommerce.com/en/developer/tutorials/migrations.html#linq2db) and [FluentMigrator](https://docs.nopcommerce.com/en/developer/tutorials/migrations.html#fluentmigrator). Supports SQL Server, MySQL, and PostgreSQL |
| **Nop.Services** | Nop.Core, Nop.Data | Business logic: order processing, tax, shipping, catalog, logging, scheduled tasks |
| **Nop.Web.Framework** | Nop.Core, Nop.Data, Nop.Services | Presentation infrastructure shared by Nop.Web and Plugins: FluentValidation wiring, bundling/minification, and middleware pipeline |
| **Nop.Web** | Nop.Core, Nop.Data, Nop.Services, Nop.Web.Framework | ASP.NET Core MVC application with controllers, views, and model factories for the **public store** and **admin area** |
| **Plugins** | Nop.Web or Nop.Web.Framework (varies per plugin) | [Independent extensions](https://docs.nopcommerce.com/en/developer/plugins/index.html) that can include their own [data access](https://docs.nopcommerce.com/en/developer/plugins/plugin-with-data-access.html), controllers, and views |
| **Nop.Tests** | Nop.Web (transitively all) | Single test project |

Additionally, none of the built-in plugins reference another plugin, as observed from the codebase. However, this may not be considered a rule, since the framework supports inter-plugin dependencies through the [`DependsOnSystemNames` field in `plugin.json`](https://docs.nopcommerce.com/en/developer/plugins/plugin.json.html).

### How does nopCommerce handle events internally — what is IEventPublisher and how is it used?

Before covering events, it helps to understand how nopCommerce wires its dependencies. nopCommerce uses [Inversion of Control (IoC) through dependency injection](https://docs.nopcommerce.com/en/developer/tutorials/inversion-of-control.html) based on ASP.NET Core's built-in DI container. Services are registered in classes implementing the `INopStartup` interface (defined in Nop.Core), using the standard `IServiceCollection`. These implementations exist across the solution and are discovered automatically at startup.

The event system is a lightweight, in-process [observer pattern](https://docs.nopcommerce.com/en/developer/design/entity-events-system.html) built on two interfaces:

- `IEventPublisher` (defined in Nop.Core) has a single method: `PublishAsync<TEvent>(TEvent @event)`. Its implementation lives in Nop.Services.
- `IConsumer<T>` (defined in Nop.Services) has a single method: `HandleEventAsync(T eventMessage)`. Any class implementing this interface will automatically receive events of type `T`.

**How publishing works:**

When `PublishAsync` is called, the `EventPublisher` implementation resolves all registered `IConsumer<TEvent>` via the service locator (`EngineContext.Current.ResolveAll<>()`) rather than constructor injection. This means event dispatch cannot be wrapped with a decorator for tracing or metrics. It calls `HandleEventAsync` on each consumer sequentially. If a consumer throws an exception, it is caught and logged, and the next consumer still runs. If an event implements `IStopProcessingEvent` and a consumer sets `StopProcessing = true`, the chain halts early.

**How consumers are discovered:**

At startup, `NopStartup` in Nop.Web.Framework uses reflection to find every class implementing `IConsumer<>` across all loaded assemblies and registers each matching interface as a scoped DI service. No manual wiring is needed. Implementing `IConsumer<SomeEvent>` in any project is enough to start receiving events.

**Built-in event types:**

`EntityRepository<T>` in Nop.Data automatically fires entity lifecycle events on every CRUD operation:

- `EntityInsertedEvent<T>` after an insert
- `EntityUpdatedEvent<T>` after an update
- `EntityDeletedEvent<T>` after a delete

Other events are published explicitly by services and framework code, such as `AppStartedEvent`, `CustomerLoggedinEvent`, `AdminMenuCreatedEvent`, and `GenericRoutingEvent`.

**Key characteristics:**

- Synchronous dispatch: consumers run sequentially within the calling thread, not in parallel or on a background queue. A slow consumer blocks the publisher.
- In-process only: there is no message broker or external queue. Events do not cross process boundaries.
- Error isolation: a failing consumer does not prevent other consumers from running. Errors are logged with a nested try-catch to avoid cyclic failures (since the logger itself could trigger events).

### Where does the code make it easy to add observability, and where does it make it hard?

The onion layer structure works in favour of instrumentation: since all layers depend inward, any observability abstraction placed in an inner layer (e.g., a tracing interface in Nop.Core) is automatically available to every outer layer without adding new dependencies.

**Where it is easy:**

1. **ASP.NET Core middleware pipeline.** The startup code in `ApplicationBuilderExtensions` already registers exception-handling middleware that catches unhandled errors, logs them via `ILogger`, and handles 404/400 responses. Adding request-timing, correlation-ID, or OpenTelemetry middleware is a single `app.Use(...)` call.

2. **Event system.** As described above, every entity CRUD operation and many business actions fire events. An observability consumer (e.g., for metrics or audit trails) can be added by implementing `IConsumer<T>` without modifying existing code.

3. **Service-layer interfaces.** Business operations are behind DI-registered interfaces (`IOrderService`, `IProductService`, `IPaymentService`, etc.). This makes it possible to add decorator/wrapper services that time calls, count operations, or record errors without modifying existing implementations.

4. **[Scheduled task runner.](https://docs.nopcommerce.com/en/developer/tutorials/scheduled-tasks.html)** `ScheduleTaskRunner` already tracks `LastStartUtc`, `LastEndUtc`, and `LastSuccessUtc` for each task, and logs exceptions. Emitting metrics from here (task duration, failure counters) would be low-effort.

5. **HTTP clients use `IHttpClientFactory`.** Core services and plugins that make HTTP calls receive HTTP clients through DI, which means adding a delegating handler for request/response logging can be done centrally.

**Where it is hard:**

1. **Custom `ILogger` writes directly to the database.** nopCommerce defines its own [`ILogger`](https://docs.nopcommerce.com/en/running-your-store/system-administration/log.html) in Nop.Services (not `Microsoft.Extensions.Logging.ILogger`). The `DefaultLogger` inserts log rows into SQL via `IRepository<Log>`. The log schema stores `ShortMessage`, `FullMessage`, `IpAddress`, `PageUrl`, and `CustomerId` as plain columns, not structured key-value pairs. There is no integration with `Microsoft.Extensions.Logging` anywhere in the codebase, which means standard .NET logging sinks (Serilog, Application Insights, OpenTelemetry) cannot be used without a bridge or refactor. The admin log viewer depends on this database table, so replacing it has UI side effects.

2. **No distributed tracing.** There are no usages of `System.Diagnostics.Activity` or `ActivitySource` anywhere in the codebase. There are no correlation IDs or context propagation. Tracing a single user request across the event system, service calls, and database operations is not possible without retrofitting context propagation.

3. **Service locator pattern.** `EngineContext.Current.Resolve<>()` is used throughout the codebase, particularly in `ApplicationBuilderExtensions` and the middleware pipeline. Static resolution makes dependencies invisible and prevents injecting observability context (correlation IDs, spans, loggers) into those code paths.

4. **Swallowed exceptions.** The codebase contains empty `catch { }` blocks that silently discard errors, including in the task scheduler loop, HTTP client timeout configuration, and several admin model factories. These create blind spots where failures are invisible.

5. **Plugin isolation.** Each plugin manages its own HTTP clients and error handling independently. There is no shared observability contract, so a plugin's external calls (payment gateways, tax services) may not surface consistently in logs or metrics.

### What would you need to change structurally to instrument it properly — and is that change worth making?

The seams identified above (middleware, event consumers, DI interfaces, `IHttpClientFactory`) can be instrumented today without structural changes. For comprehensive instrumentation (structured logs, end-to-end tracing, unified metrics), three areas of the codebase would need to change:

1. **Logging.** The custom `ILogger` writes to a database table and has no connection to the standard .NET logging pipeline. There are two approaches: bridging the custom logger to `Microsoft.Extensions.Logging.ILoggerProvider`, or migrating call sites to use `Microsoft.Extensions.Logging.ILogger<T>` directly. The bridge approach requires no changes to existing code and preserves the admin log viewer, but logs at the call site remain unstructured (plain strings, not key-value pairs). The migration approach gives structured logging everywhere but requires touching every file that uses `ILogger`, and the admin log viewer would need to be updated or replaced. A practical middle ground is to bridge first, then migrate incrementally.

2. **Request correlation.** There are no correlation IDs flowing through the system. Adding a middleware that creates a `System.Diagnostics.Activity` per request requires one new file. Propagating that ID into the event publisher and the logger requires changes to two more files. The scope is small, but the impact is large: without this, you cannot trace a checkout flow across service calls, event handlers, and database operations.

3. **Service locator on critical paths.** The `EngineContext.Current.Resolve<>()` calls in the middleware pipeline and event publisher are invisible to instrumentation tools. To wrap those dependencies with tracing or metrics decorators, they need to be constructor-injected. However, `EngineContext.Current` is used across the codebase, and a full migration would touch dozens of files with high risk of regressions and no immediate functional benefit beyond instrumentability.

Changes 1 and 2 are bounded in scope, backward-compatible, and unlock the fundamentals (structured logs, trace correlation). Change 3 is worth doing incrementally on critical paths but not as a big-bang refactor.