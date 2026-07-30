# @just-be/cf-effect-telemetry

Effect v4 tracer provider for Cloudflare Workers custom spans.

It bridges `Effect.withSpan`, `Effect.useSpan`, `Effect.makeSpanScoped`, `Effect.annotateCurrentSpan`, and other Effect tracing APIs to Cloudflare Workers `tracing.startActiveSpan()`. Every sampled Effect span opens a Cloudflare span when Effect creates it, receives attributes as Effect sets them, and is ended when Effect ends the span, so Cloudflare span timings match Effect span timings.

```ts
import { Effect } from "effect";
import { tracing } from "cloudflare:workers";
import { layer as cloudflareTelemetry } from "@just-be/cf-effect-telemetry";

const program = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan("route", "/users/:id");
  return new Response("ok");
}).pipe(Effect.withSpan("worker.fetch"));

export default {
  fetch() {
    return Effect.runPromise(
      program.pipe(Effect.provide(cloudflareTelemetry({ tracing }))),
    );
  },
};
```

You can pass `ctx.tracing` instead of the imported `tracing` object:

```ts
Effect.provide(program, cloudflareTelemetry({ tracing: ctx.tracing }));
```

Only Cloudflare-supported span attributes are emitted by default: `string`, finite `number`, `boolean`, and `bigint` as a string. Use `attributeMapper` to customize conversion or redaction.

## Failure and interruption

Cloudflare spans have no outcome/status API, so a failing `Exit` is recorded as attributes, using the same conventions as Effect's own OTLP tracer:

| Exit | Attributes |
| --- | --- |
| success | none |
| interrupted | `span.label = "⚠︎ Interrupted"`, `status.interrupted = true` |
| failure or defect | `otel.status_code = "ERROR"`, `otel.status_description`, `exception.type`, `exception.message`, `exception.stacktrace` |

`attributeMapper` sees these like any other attribute, so it can truncate or drop them. `exception.stacktrace` is already capped at 4096 characters, since Cloudflare does not document an attribute size limit.

A mapper that throws never fails the request: the attribute is dropped and the failure is reported with `console.error`.

## Sampling

Unsampled Effect spans (`Effect.withSpan(name, { sampled: false })`, or anything filtered out by `Tracer.MinimumTraceLevel`) never open a Cloudflare span. When Cloudflare itself is not tracing an invocation, `span.isTraced` is `false`, so attributes are not mapped at all — nothing would be recorded anyway. This is why local `wrangler dev` shows spans with no attributes: it does not sample traces, regardless of `head_sampling_rate`.

## Limitations

These follow from Cloudflare's tracing API, not from Effect:

- **Flat span tree.** Cloudflare derives parent/child from the active async context and offers no manual parent wiring, and a `startActiveSpan` span is only the active parent for the duration of its callback. An Effect fiber resumes across many later ticks, so Effect spans land as siblings of the request's root span rather than nested. Effect's own span tree (`parent`, `traceId`, `spanId`) is still intact for other Effect tracers.
- **Platform spans are not nested.** `fetch`, KV, D1, and other auto-instrumented operations attach to the request root span, not to the enclosing Effect span.
- **No span events.** Effect turns `Effect.log` calls into span events and Cloudflare has no event API, so spans from this tracer drop them rather than accumulate them for the lifetime of the span. Log output still reaches Cloudflare through `console`, attributed to the request root span.
- **No links or span kind.** Cloudflare exposes neither, so `Effect.linkSpans` and the span `kind` are not forwarded.

## Verifying against the runtime

```sh
bun run check        # types + unit tests
bun run integration  # runs the tracer on real workerd via `wrangler dev`
```

`integration/` holds a Worker that drives the tracer through success, failure, interruption, and unsampled spans while recording every call forwarded to `tracing`. It asserts what the runtime accepts (attribute value types, idempotent `end()`, `setAttribute` after `end()`, `isTraced` flipping to `false` once a span ends) and typechecks against the declarations `wrangler types` generates, so a breaking change in Cloudflare's API surfaces here rather than in production. Attribute *contents* are only asserted when the invocation is sampled, which local dev never is — run the same check against a deployed Worker to cover that.
