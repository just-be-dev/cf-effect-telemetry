import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema, Tracer } from "effect";
import {
  defaultAttributeMapper,
  layer,
  type AttributeMapper,
  type CloudflareRuntimeSpan,
  type CloudflareTracing,
} from "./index.ts";

interface RecordedSpan extends CloudflareRuntimeSpan {
  readonly name: string;
  readonly attributes: Map<string, string | number | boolean>;
  endCount: number;
}

class BoomError extends Schema.TaggedErrorClass<BoomError>()("BoomError", {
  message: Schema.String,
}) {}

// Compile-time guard: the declarations Cloudflare documents for
// `cloudflare:workers` (and `ctx.tracing`) must satisfy `CloudflareTracing`.
declare class WorkersSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value: string | number | boolean | undefined): void;
  end(): void;
}
declare const workersTracing: {
  enterSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: WorkersSpan, ...args: A) => T,
    ...args: A
  ): T;
  startActiveSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: WorkersSpan, ...args: A) => T,
    ...args: A
  ): T;
};
type AssertTrue<T extends true> = T;
type _WorkersTracingIsAccepted = AssertTrue<
  typeof workersTracing extends CloudflareTracing ? true : false
>;

const makeTracing = (
  options: { readonly isTraced?: boolean } = {},
): CloudflareTracing & { readonly spans: Array<RecordedSpan> } => {
  const spans: Array<RecordedSpan> = [];

  return {
    spans,
    startActiveSpan<T, A extends Array<unknown>>(
      name: string,
      callback: (span: CloudflareRuntimeSpan, ...args: A) => T,
      ...args: A
    ): T {
      const span: RecordedSpan = {
        name,
        isTraced: options.isTraced ?? true,
        attributes: new Map(),
        endCount: 0,
        setAttribute(key, value) {
          if (value !== undefined) {
            this.attributes.set(key, value);
          }
        },
        end() {
          this.endCount += 1;
        },
      };
      spans.push(span);
      return callback(span, ...args);
    },
  };
};

describe("Cloudflare Effect telemetry", () => {
  test("backs Effect spans with manually-ended Cloudflare active spans", async () => {
    const tracing = makeTracing();

    const result = await Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("dynamic", "set-after-start");
      return 42;
    }).pipe(
      Effect.withSpan("worker.request", {
        attributes: {
          route: "/api/users",
          count: 2,
          cached: false,
        },
      }),
      Effect.provide(layer({ tracing })),
      Effect.runPromise,
    );

    expect(result).toBe(42);
    expect(tracing.spans).toHaveLength(1);
    expect(tracing.spans[0]?.name).toBe("worker.request");
    expect(tracing.spans[0]?.attributes).toEqual(new Map<string, string | number | boolean>([
      ["route", "/api/users"],
      ["count", 2],
      ["cached", false],
      ["dynamic", "set-after-start"],
    ]));
    expect(tracing.spans[0]?.endCount).toBe(1);
  });

  test("skips unsupported Cloudflare attribute values by default", async () => {
    const tracing = makeTracing();

    await Effect.succeed("ok").pipe(
      Effect.withSpan("attributes", {
        attributes: {
          bigint: 12n,
          object: { nope: true },
          infinite: Number.POSITIVE_INFINITY,
          missing: undefined,
        },
      }),
      Effect.provide(layer({ tracing })),
      Effect.runPromise,
    );

    expect(tracing.spans[0]?.attributes).toEqual(new Map([["bigint", "12"]]));
  });

  test("does not start Cloudflare spans when Effect sampling disables a span", async () => {
    const tracing = makeTracing();

    await Effect.succeed("ok").pipe(
      Effect.withSpan("unsampled", { sampled: false }),
      Effect.provide(layer({ tracing })),
      Effect.runPromise,
    );

    expect(tracing.spans).toHaveLength(0);
  });

  test("does not create Cloudflare spans for external parent spans", async () => {
    const tracing = makeTracing();
    const foreignParent = Tracer.externalSpan({
      traceId: "external-trace",
      spanId: "external-span",
    });

    const result = await Effect.succeed("ok").pipe(
      Effect.withParentSpan(foreignParent),
      Effect.provide(layer({ tracing })),
      Effect.runPromise,
    );

    expect(result).toBe("ok");
    expect(tracing.spans).toHaveLength(0);
  });

  test("submits spans created outside the fiber's current span chain", async () => {
    const tracing = makeTracing();

    await Effect.scoped(
      Effect.gen(function* () {
        const span = yield* Effect.makeSpanScoped("manual.work");
        span.attribute("manual", true);
      }),
    ).pipe(Effect.provide(layer({ tracing })), Effect.runPromise);

    expect(tracing.spans).toHaveLength(1);
    expect(tracing.spans[0]?.name).toBe("manual.work");
    expect(tracing.spans[0]?.attributes.get("manual")).toBe(true);
    expect(tracing.spans[0]?.endCount).toBe(1);
  });

  test("preserves Effect native span state", async () => {
    const tracing = makeTracing();

    const observed = await Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      if (!(span instanceof Tracer.NativeSpan)) {
        throw new Error("expected Cloudflare telemetry spans to extend Effect NativeSpan");
      }

      span.event("checkpoint", 0n, { ok: true });

      return {
        attributes: span.attributes,
        eventCount: span.events.length,
        spanIdLength: span.spanId.length,
        traceIdLength: span.traceId.length,
      };
    }).pipe(
      Effect.withSpan("native-state", { attributes: { retained: true } }),
      Effect.provide(layer({ tracing })),
      Effect.runPromise,
    );

    expect(observed.attributes.get("retained")).toBe(true);
    // Cloudflare has no event API, so events are dropped instead of piling up.
    expect(observed.eventCount).toBe(0);
    expect(observed.spanIdLength).toBe(16);
    expect(observed.traceIdLength).toBe(32);
    expect(tracing.spans[0]?.endCount).toBe(1);
  });

  test("records failure exits as Cloudflare span attributes", async () => {
    const tracing = makeTracing();

    const exit = await Effect.fail(new BoomError({ message: "boom" })).pipe(
      Effect.withSpan("failing"),
      Effect.provide(layer({ tracing })),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const attributes = tracing.spans[0]?.attributes;
    expect(attributes?.get("otel.status_code")).toBe("ERROR");
    expect(attributes?.get("otel.status_description")).toBe("boom");
    expect(attributes?.get("exception.type")).toBe("BoomError");
    expect(attributes?.get("exception.message")).toBe("boom");
    const stack = attributes?.get("exception.stacktrace");
    expect(typeof stack).toBe("string");
    expect((stack as string).length).toBeLessThanOrEqual(4097);
    expect(tracing.spans[0]?.endCount).toBe(1);
  });

  test("marks interrupted spans as interrupted instead of failed", async () => {
    const tracing = makeTracing();

    await Effect.interrupt.pipe(
      Effect.withSpan("interrupted"),
      Effect.provide(layer({ tracing })),
      Effect.runPromiseExit,
    );

    const attributes = tracing.spans[0]?.attributes;
    expect(attributes?.get("status.interrupted")).toBe(true);
    expect(attributes?.get("span.label")).toBe("⚠︎ Interrupted");
    expect(attributes?.has("otel.status_code")).toBe(false);
    expect(tracing.spans[0]?.endCount).toBe(1);
  });

  test("skips attribute mapping when the Cloudflare span is not traced", async () => {
    const tracing = makeTracing({ isTraced: false });
    let mapperCalls = 0;
    const attributeMapper: AttributeMapper = (key, value) => {
      mapperCalls += 1;
      return defaultAttributeMapper(key, value);
    };

    await Effect.annotateCurrentSpan("dynamic", "ignored").pipe(
      Effect.withSpan("untraced", { attributes: { route: "/api/users" } }),
      Effect.provide(layer({ tracing, attributeMapper })),
      Effect.runPromise,
    );

    expect(mapperCalls).toBe(0);
    expect(tracing.spans[0]?.attributes.size).toBe(0);
    expect(tracing.spans[0]?.endCount).toBe(1);
  });

  test("keeps a throwing attributeMapper from failing the request", async () => {
    const tracing = makeTracing();
    const errors: Array<unknown> = [];
    const consoleError = console.error;
    console.error = (...args: Array<unknown>) => {
      errors.push(args[0]);
    };

    try {
      const result = await Effect.succeed("ok").pipe(
        Effect.withSpan("mapper-throws", { attributes: { bad: 1, good: 2 } }),
        Effect.provide(
          layer({
            tracing,
            attributeMapper: (key, value) => {
              if (key === "bad") throw new Error("mapper exploded");
              return defaultAttributeMapper(key, value);
            },
          }),
        ),
        Effect.runPromise,
      );

      expect(result).toBe("ok");
    } finally {
      console.error = consoleError;
    }

    // The offending attribute is dropped, later ones still land, span still ends.
    expect(tracing.spans[0]?.attributes).toEqual(new Map<string, string | number | boolean>([["good", 2]]));
    expect(tracing.spans[0]?.endCount).toBe(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('attributeMapper threw for "bad"');
  });

  test("truncates oversized stack traces", async () => {
    const tracing = makeTracing();
    const deepStack = `Error: deep\n${"    at frame\n".repeat(2000)}`;

    await Effect.failCause(Cause.die(Object.assign(new Error("deep"), { stack: deepStack }))).pipe(
      Effect.withSpan("deep-stack"),
      Effect.provide(layer({ tracing })),
      Effect.runPromiseExit,
    );

    const stack = tracing.spans[0]?.attributes.get("exception.stacktrace") as string;
    expect(stack.length).toBe(4097);
    expect(stack.endsWith("…")).toBe(true);
    expect(stack.startsWith("Error: deep")).toBe(true);
  });
});
