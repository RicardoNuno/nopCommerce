### How are the layers organised and what are the dependency rules between them?

nopCommerce closely follows an [onion architecture](https://docs.nopcommerce.com/en/developer/tutorials/architecture-of-nopCommerce.html), but not strictly. Dependencies only point inward (never outward), however outer layers can reference any inner layer directly, not just the adjacent one.

Additionally, none of the built-in plugins reference another plugin, as observed from the codebase. However, this may not be considered a rule, since the framework supports inter-plugin dependencies through the [`DependsOnSystemNames` field in `plugin.json`](https://docs.nopcommerce.com/en/developer/plugins/plugin.json.html).

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
