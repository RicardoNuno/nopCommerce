# Instrumenting the Order Placement Flow

## Chosen Flow

**Customer places an order** (Basket, Order, Payment, Inventory).

This flow was chosen because it is the most operationally critical path in the application. A degradation in product search is frustrating; a degradation in checkout loses revenue and can leave orders in inconsistent states (payment taken but order not confirmed). It also touches the most layers and external dependencies, making it the richest flow to instrument.

## Flow Overview

When a customer confirms an order, the request enters through `CheckoutController.ConfirmOrder()` and is orchestrated by `OrderProcessingService.PlaceOrderAsync()`. The chain is as follows:

```
CheckoutController.ConfirmOrder()                    [Nop.Web]
  └─ OrderProcessingService.PlaceOrderAsync()         [Nop.Services]
       ├─ PreparePlaceOrderDetailsAsync()
       │    ├─ Validate customer, cart, addresses
       │    └─ PrepareAndValidateTotalsAsync()
       │         ├─ OrderTotalCalculationService       [Nop.Services]
       │         │    └─ DiscountService.ValidateDiscountAsync()
       │         ├─ TaxService.GetTaxTotalAsync()
       │         └─ GiftCardService / RewardPointService
       ├─ PaymentService.ProcessPaymentAsync()         [Nop.Services]
       │    └─ Payment plugin (external gateway)       [Plugins]
       ├─ SaveOrderDetailsAsync()                      [Nop.Services → Nop.Data]
       ├─ MoveShoppingCartItemsToOrderItemsAsync()
       │    └─ ProductService.AdjustInventoryAsync()   [Nop.Services]
       ├─ SaveDiscountUsageHistoryAsync()
       └─ Publish OrderPlacedEvent                     [Nop.Core events]
```

Each step in this chain represents a potential point of failure or degradation that is currently invisible to operators.

## Distributed Tracing Plan

nopCommerce has no existing tracing infrastructure (no `System.Diagnostics.Activity` or `ActivitySource` usage anywhere in the codebase, as documented in `ARCHITECTURE.md`). The plan is to add spans at the following points, creating a parent-child hierarchy that traces the full checkout:

| Span | Location | What it captures |
|------|----------|-----------------|
| `checkout.confirm` | `CheckoutController.ConfirmOrder()` | Business-level span for checkout (child of the auto-generated ASP.NET Core HTTP span) |
| `order.place` | `OrderProcessingService.PlaceOrderAsync()` | The orchestration of the full order pipeline |
| `order.validate_totals` | `PrepareAndValidateTotalsAsync()` | Discount validation, tax calculation, totals |
| `payment.process` | `GetProcessPaymentResultAsync()` | Payment gateway call (the main external dependency) |
| `order.save` | `SaveOrderDetailsAsync()` | Database write for the order record |
| `inventory.adjust` | `MoveShoppingCartItemsToOrderItemsAsync()` | Stock reduction per order item |

Each span will carry:
- The order ID (once available) as a tag for correlation
- The payment method system name (on the payment span) so operators can filter by gateway
- Success/failure status and error messages (sanitized, see Sensitive Data below)

**Implementation approach:**

1. **OpenTelemetry SDK setup.** The OpenTelemetry SDK must be configured before any spans or metrics can be collected. An `INopStartup` implementation (`OpenTelemetryStartup` in Nop.Web.Framework) registers the SDK with the DI container, subscribing to our custom `ActivitySource` and `Meter`. It also adds ASP.NET Core auto-instrumentation for HTTP request spans. The console exporter is used for development; in production this would be replaced with an OTLP exporter targeting Jaeger, Zipkin, or a similar backend. This startup runs at `Order => 5`, early enough to capture the full request lifecycle.

2. **Instrumentation definitions.** A static class `NopInstrumentation` in Nop.Core defines the shared `ActivitySource` and `Meter` with all metric instruments. Placed in Nop.Core so that all outer layers can reference it without adding new dependencies (consistent with the onion architecture principle described in `ARCHITECTURE.md`).

3. **Span creation.** Key methods are wrapped with `NopInstrumentation.ActivitySource.StartActivity()`. Since all services are resolved through DI, `Activity.Current` propagates automatically through the async call chain without manual context passing.

## Metrics

### How the metrics were chosen

The metrics are structured in two tiers. The first tier (metrics 1–2) answers the on-call engineer's immediate questions: *"are orders going through?"* and *"is the system saturating?"* These are the signals you alert on. The second tier (metrics 3–4) diagnoses specific subsystems once the top-level signals indicate a problem.

The order flow was walked through stage by stage, asking at each point: "what can go wrong here, and what would an operator need to know before users start complaining?" Four gaps stood out, each addressed by a specific metric below:

1. No business-level signal for order success or failure (Metric 1)
2. No way to distinguish queuing from slow dependencies under load (Metric 2)
3. No visibility into payment gateway response times (Metric 3)
4. No visibility into sequential event dispatch blocking the checkout response (Metric 4)

### Implemented Metrics

**Metric 1: Orders completed (counter)**

- **What:** A counter incremented when `PlaceOrderAsync()` finishes, tagged by `status` (success/failure).
- **Why:** This is the primary on-call signal. An operator's first question during an incident is "are orders going through?", and today there is no way to answer that without querying the database. HTTP-level error rates miss business failures (payment declined, validation failed, insufficient stock) because these return HTTP 200 with an error in the response body. This counter captures every outcome at the business level. Under load, a rising `status=failure` rate with a specific `failure_reason` gives the operator immediate triage direction. A dropping `status=success` rate is the clearest possible signal that checkout is broken.
- **Implementation:** At the end of `PlaceOrderAsync()`, after both the locked and unlocked paths converge, increment the counter with `status=success` or `status=failure`. The specific failure reason is available in the trace span and application logs for drill-down. This runs inside a `try/finally` block that also decrements the in-flight gauge (Metric 2), ensuring both metrics are recorded even if an unexpected exception propagates.

**Metric 2: Orders in flight (up-down counter)**

- **What:** An `UpDownCounter` that increments when `PlaceOrderAsync()` starts and decrements when it exits (success or failure).
- **Why:** This is the saturation signal. Under load, if this value climbs without coming back down, orders are piling up, meaning the system is accepting work faster than it can complete it. This distinguishes two very different failure modes that look identical from latency alone: "latency is high because the payment gateway is slow" (in-flight count stays low, each order just takes longer) versus "latency is high because we're saturating a shared resource like the database connection pool" (in-flight count climbs, orders are queuing). These require different operator responses: wait out the gateway versus scale up or shed load.
- **Implementation:** Increment at the top of `PlaceOrderAsync()` immediately after the tracing activity starts. Decrement in the `finally` block that wraps both the locked and unlocked execution paths, guaranteeing the counter is decremented even on exceptions. No tags are needed; the aggregate value is the signal.

**Metric 3: Payment gateway latency (histogram)**

- **What:** A histogram recording the duration of the payment gateway call inside `GetProcessPaymentResultAsync()`, tagged by payment method name.
- **Why:** As documented in `ARCHITECTURE.md`, each plugin manages its own HTTP clients with no shared observability contract, meaning plugin external calls do not surface in logs or metrics by default. The payment gateway is the most critical of these calls (present in every order that requires payment), so this metric targets it specifically for the highest-risk external dependency in the checkout flow. Unlike internal service calls (which degrade predictably under load), gateway latency can spike independently due to issues on the provider's side. A histogram lets an operator see the p50, p95, and p99 response times. If the p95 starts climbing, the operator can investigate or switch to a fallback gateway before checkout starts timing out for users.
- **Implementation:** In `GetProcessPaymentResultAsync()`, start a `Stopwatch` after the payment plugin is loaded and validated, then record the elapsed time to a `Histogram<double>` instrument after the actual gateway call completes. This captures both regular and recurring payment paths in one place, and measures only the gateway call itself, not the plugin resolution overhead. Tagged with the payment method system name.

**Metric 4: Event dispatch duration (histogram)**

- **What:** A histogram recording the duration of `_eventPublisher.PublishAsync(new OrderPlacedEvent(order))` after a successful order placement.
- **Why:** As documented in `ARCHITECTURE.md`, event dispatch in nopCommerce is sequential: consumers are awaited one after another. Every consumer of `OrderPlacedEvent` must complete before the response is returned to the customer. If a consumer is slow (e.g., calling an external API, performing heavy processing, or triggering a chain of further events), checkout latency increases with no visible cause. This metric surfaces that hidden cost. An operator seeing the p95 climb knows a consumer is degrading the checkout experience, even though `PlaceOrderAsync()` itself succeeded without errors.
- **Implementation:** Wrap the `PublishAsync` call in `PlaceOrderAsync()` with a `Stopwatch` and record the elapsed time to a `Histogram<double>` instrument.

### Additional Metrics (Suggested, Not Implemented)

These metrics would further strengthen observability of the order flow but were not implemented to keep the scope focused:

- **Notifications queued per recipient type (counter):** Tracks email notifications queued after order placement, tagged by recipient type. If orders are completing (Metric 1) but this counter stops incrementing, notifications are silently failing (e.g., a disabled message template or email service outage).

- **Discount validation failure rate per code (counter):** A burst of failures on a single discount code suggests brute-forcing. A burst of successes suggests a leaked code spreading virally. Either case requires immediate operator action (disable the code, investigate the source). This would be placed in `DiscountService.ValidateDiscountAsync()`.

- **Order placement rate per product category (counter):** An abnormal spike in orders for a single category could indicate a pricing error, bot purchasing, or a viral event about to exhaust inventory. This is a broader signal than individual product monitoring.

- **Checkout-to-confirmation duration (histogram):** Measures the total wall-clock time of `PlaceOrderAsync()`, capturing the aggregate effect of all internal stages. Useful as a high-level health signal, but less actionable than the per-stage payment latency histogram since it does not pinpoint which stage is slow.

## Sensitive Data Exclusion

Traces and metrics must not contain personally identifiable information (PII) or payment details. The following rules apply:

**Included in spans/metrics (safe):**
- Order ID, product ID, category ID (internal identifiers)
- Order completion status and failure reason category (e.g., payment error, validation error, not the full error message, which may contain user data)
- Payment method system name (e.g., `Payments.PayPalCommerce`, not account details)
- Discount code name in truncated or hashed form (operators need to identify which code is being abused, but full codes are secrets that grant financial value and should not be exposed in tracing backends)
- Quantities, totals as aggregated numbers
- Exception type names (e.g., `NopException`, `TimeoutException`), but not the full message, which may contain user data

**Excluded from spans/metrics (PII/sensitive):**
- Customer email, name, phone, IP address
- Billing and shipping addresses
- Credit card numbers, CVV, expiry dates (even partially masked)
- `ProcessPaymentRequest` fields containing card data
- Shopping cart contents that could reveal personal purchasing patterns tied to a customer

**How this is enforced:** Span tags are set explicitly with allowed fields only. No method is instrumented by serializing entire request/response objects into span attributes. The payment span records the method name and duration, not the `ProcessPaymentRequest` payload. The error tag captures the exception type name only, not the message or stack trace (which could contain user data or parameter values). Discount codes are hashed or truncated before being attached as span tags.
