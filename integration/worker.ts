import { tracing } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { layer, type CloudflareRuntimeSpan, type CloudflareTracing } from "../index.ts";

/**
 * Exercises the tracer against the real Workers runtime. Every call the tracer
 * makes is forwarded to `tracing` and recorded, so the response is evidence that
 * workerd accepted the exact shapes this package relies on.
 */

class IntegrationError extends Schema.TaggedErrorClass<IntegrationError>()("IntegrationError", {
  message: Schema.String,
}) {}

interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, string | number | boolean>;
  readonly isTracedOnStart: boolean;
  isTracedAfterEnd: boolean | undefined;
  ends: number;
}

const recordingTracing = (): {
  readonly tracing: CloudflareTracing;
  readonly spans: Array<RecordedSpan>;
} => {
  const spans: Array<RecordedSpan> = [];

  return {
    spans,
    tracing: {
      startActiveSpan<T, A extends Array<unknown>>(
        name: string,
        callback: (span: CloudflareRuntimeSpan, ...args: A) => T,
        ...args: A
      ): T {
        return tracing.startActiveSpan(
          name,
          (span, ...rest: A) => {
            const record: RecordedSpan = {
              name,
              attributes: {},
              isTracedOnStart: span.isTraced,
              isTracedAfterEnd: undefined,
              ends: 0,
            };
            spans.push(record);

            const recorded: CloudflareRuntimeSpan = {
              get isTraced() {
                return span.isTraced;
              },
              setAttribute(key, value) {
                span.setAttribute(key, value);
                if (value !== undefined) {
                  record.attributes[key] = value;
                }
              },
              end() {
                span.end();
                record.ends += 1;
                record.isTracedAfterEnd = span.isTraced;
              },
            };

            return callback(recorded, ...rest);
          },
          ...args,
        );
      },
    },
  };
};

const program = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan("route", "/");
  yield* Effect.sleep("5 millis");
  yield* Effect.log("log inside a span becomes a dropped span event");

  yield* Effect.fail(new IntegrationError({ message: "expected failure" })).pipe(
    Effect.withSpan("failing"),
    Effect.ignore,
  );
  yield* Effect.never.pipe(Effect.withSpan("cancelled"), Effect.timeout("10 millis"), Effect.ignore);
  yield* Effect.void.pipe(Effect.withSpan("unsampled", { sampled: false }));

  return "ok";
}).pipe(
  Effect.withSpan("worker.fetch", {
    kind: "server",
    attributes: { text: "value", count: 1, flag: true, big: 7n, dropped: { nope: true } },
  }),
);

/**
 * Exercises the runtime behaviours the tracer depends on directly, so they are
 * verified even in environments that do not sample traces (`isTraced === false`
 * makes Cloudflare ignore attributes, and local `wrangler dev` never samples).
 */
const controlProbe = (): { readonly ok: boolean; readonly error?: string } => {
  try {
    tracing.startActiveSpan("control", (span) => {
      span.setAttribute("string", "value");
      span.setAttribute("number", 1);
      span.setAttribute("boolean", true);
      span.setAttribute("undefined", undefined);
      span.end();
      // Documented as ignored rather than fatal.
      span.setAttribute("after-end", "ignored");
      span.end();
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

export default {
  async fetch(): Promise<Response> {
    const recording = recordingTracing();
    const result = await Effect.runPromise(program.pipe(Effect.provide(layer(recording))));

    return Response.json({
      result,
      startActiveSpanType: typeof tracing.startActiveSpan,
      enterSpanType: typeof tracing.enterSpan,
      control: controlProbe(),
      spans: recording.spans,
    });
  },
};
