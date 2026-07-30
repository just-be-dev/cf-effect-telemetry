import { describe, expect, test } from "bun:test";
import { Effect, Tracer } from "effect";
import { layer, type CloudflareRuntimeSpan, type CloudflareTracing } from "./index.ts";

interface RecordedSpan extends CloudflareRuntimeSpan {
  readonly name: string;
  readonly attributes: Map<string, string | number | boolean>;
  endCount: number;
}

const makeTracing = (): CloudflareTracing & { readonly spans: Array<RecordedSpan> } => {
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
        isTraced: true,
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

  test("leaves foreign current spans to Effect evaluation", async () => {
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
});
