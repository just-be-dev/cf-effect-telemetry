# @just-be/cf-effect-telemetry

Effect v4 tracer provider for Cloudflare Workers custom spans.

It bridges `Effect.withSpan`, `Effect.useSpan`, `Effect.annotateCurrentSpan`, and other Effect tracing APIs to Cloudflare Workers `tracing.startActiveSpan()`. The Cloudflare span is started when the Effect span first becomes the active fiber span, and it is ended manually when Effect closes the span.

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
