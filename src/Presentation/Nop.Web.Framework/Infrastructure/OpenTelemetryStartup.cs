using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nop.Core.Infrastructure;
using Nop.Core.Infrastructure.Instrumentation;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Nop.Web.Framework.Infrastructure;

/// <summary>
/// Configures OpenTelemetry tracing and metrics for the checkout instrumentation.
/// Subscribes to the ActivitySource and Meter defined in NopInstrumentation (Nop.Core).
/// </summary>
public partial class OpenTelemetryStartup : INopStartup
{
    /// <summary>
    /// Add OpenTelemetry services
    /// </summary>
    /// <param name="services">Collection of service descriptors</param>
    /// <param name="configuration">Configuration of the application</param>
    public virtual void ConfigureServices(IServiceCollection services, IConfiguration configuration)
    {
        services.AddOpenTelemetry()
            .ConfigureResource(resource => resource
                .AddService("NopCommerce"))
            .WithTracing(tracing => tracing
                .AddSource(NopInstrumentation.ActivitySourceName)
                .AddAspNetCoreInstrumentation()
                .AddConsoleExporter())
            .WithMetrics(metrics => metrics
                .AddMeter(NopInstrumentation.MeterName)
                .AddAspNetCoreInstrumentation()
                .AddConsoleExporter());
    }

    /// <summary>
    /// Configure the using of added middleware
    /// </summary>
    /// <param name="application">Builder for configuring an application's request pipeline</param>
    public virtual void Configure(IApplicationBuilder application)
    {
    }

    /// <summary>
    /// Gets order of this startup configuration implementation.
    /// Configured early so tracing captures the full request lifecycle.
    /// </summary>
    public int Order => 5;
}
