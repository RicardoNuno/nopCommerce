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
    /// Metric 1: Orders completed (counter).
    /// Incremented when PlaceOrderAsync() finishes, tagged by success/failure and failure reason.
    /// This is the primary on-call signal: "are orders going through?"
    /// </summary>
    public static readonly Counter<long> OrdersCompleted =
        Meter.CreateCounter<long>(
            "nopcommerce.checkout.orders.completed",
            unit: "{order}",
            description: "Orders completed during checkout, tagged by outcome");

    /// <summary>
    /// Metric 2: Orders in flight (up-down counter).
    /// Incremented when PlaceOrderAsync() starts, decremented when it exits.
    /// A rising value under load indicates orders are piling up (saturation).
    /// </summary>
    public static readonly UpDownCounter<long> OrdersInFlight =
        Meter.CreateUpDownCounter<long>(
            "nopcommerce.checkout.orders.in_flight",
            unit: "{order}",
            description: "Orders currently being processed in the checkout pipeline");

    /// <summary>
    /// Metric 3: Payment gateway latency (histogram).
    /// Records the duration of each PaymentService.ProcessPaymentAsync() call in milliseconds.
    /// Tagged by payment method system name.
    /// </summary>
    public static readonly Histogram<double> PaymentGatewayDuration =
        Meter.CreateHistogram<double>(
            "nopcommerce.checkout.payment_gateway.duration",
            unit: "ms",
            description: "Duration of payment gateway calls during checkout");

    /// <summary>
    /// Metric 4: Event dispatch duration (histogram).
    /// Records the duration of publishing OrderPlacedEvent in milliseconds.
    /// </summary>
    public static readonly Histogram<double> EventDispatchDuration =
        Meter.CreateHistogram<double>(
            "nopcommerce.checkout.event_dispatch.duration",
            unit: "ms",
            description: "Duration of OrderPlacedEvent dispatch after successful order placement");
}
