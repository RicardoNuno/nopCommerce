### How are the layers organised and what are the dependency rules between them?

nopCommerce closely follows an [onion architecture](https://docs.nopcommerce.com/en/developer/tutorials/architecture-of-nopCommerce.html), but not strictly. Dependencies only point inward (never outward), however outer layers can reference any inner layer directly, not just the adjacent one.

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

Before covering events, it helps to understand how nopCommerce wires its dependencies. nopCommerce uses [Inversion of Control (IoC) through dependency injection](https://docs.nopcommerce.com/en/developer/tutorials/inversion-of-control.html) based on ASP.NET Core's built-in DI container. Services are registered in classes implementing the `INopStartup` interface (defined in Nop.Core), using the standard `IServiceCollection`. These implementations exist across the solution (Nop.Data, Nop.Web.Framework, Nop.Web, and plugins) and are discovered automatically at startup.

The event system itself is a lightweight, in-process [observer pattern](https://docs.nopcommerce.com/en/developer/design/entity-events-system.html) built on two interfaces:

- `IEventPublisher` (defined in Nop.Core) has a single method: `PublishAsync<TEvent>(TEvent @event)`. Its implementation lives in Nop.Services.
- `IConsumer<T>` (defined in Nop.Services) has a single method: `HandleEventAsync(T eventMessage)`. Any class implementing this interface will automatically receive events of type `T`.

**How publishing works:**

When `PublishAsync` is called, the `EventPublisher` implementation resolves all registered `IConsumer<TEvent>` from the DI container via `EngineContext.Current.ResolveAll<>()` and calls `HandleEventAsync` on each one sequentially. If a consumer throws an exception, it is caught and logged, and the next consumer still runs. If an event implements `IStopProcessingEvent` and a consumer sets `StopProcessing = true`, the chain halts early.

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