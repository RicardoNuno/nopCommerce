using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Nop.Core.Infrastructure.Instrumentation;

/// <summary>
/// Provides shared ActivitySource and Meter for nopCommerce instrumentation.
/// Defined in Nop.Core so that all outer layers can reference it without adding new dependencies.
/// </summary>
public static class NopInstrumentation
{
    public const string ActivitySourceName = "NopCommerce.Checkout";
    public const string MeterName = "NopCommerce.Checkout";

    public static readonly ActivitySource ActivitySource = new(ActivitySourceName);
    public static readonly Meter Meter = new(MeterName);

    /// <summary>
    /// Metric 1: Payment gateway latency (histogram).
    /// Records the duration of each PaymentService.ProcessPaymentAsync() call in milliseconds.
    /// Tagged by payment method system name.
    /// </summary>
    public static readonly Histogram<double> PaymentGatewayDuration =
        Meter.CreateHistogram<double>(
            "nopcommerce.checkout.payment_gateway.duration",
            unit: "ms",
            description: "Duration of payment gateway calls during checkout");

    /// <summary>
    /// Metric 2: Inventory adjustment failure rate per product (counter).
    /// Incremented when ProductService.AdjustInventoryAsync() fails during order item processing.
    /// Tagged by product ID.
    /// </summary>
    public static readonly Counter<long> InventoryAdjustmentFailures =
        Meter.CreateCounter<long>(
            "nopcommerce.checkout.inventory_adjustment.failures",
            unit: "{failure}",
            description: "Number of inventory adjustment failures during checkout, per product");

    /// <summary>
    /// Metric 3: Event dispatch duration (histogram).
    /// Records the duration of publishing OrderPlacedEvent in milliseconds.
    /// </summary>
    public static readonly Histogram<double> EventDispatchDuration =
        Meter.CreateHistogram<double>(
            "nopcommerce.checkout.event_dispatch.duration",
            unit: "ms",
            description: "Duration of OrderPlacedEvent dispatch after successful order placement");
}
