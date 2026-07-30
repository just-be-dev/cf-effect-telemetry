import { Cause, Exit, Layer, Tracer } from "effect";

/** Attribute value types accepted by Cloudflare's `span.setAttribute`. */
export type CloudflareSpanAttributeValue = string | number | boolean | undefined;

/** The `Span` handed to a `tracing.startActiveSpan` callback. */
export interface CloudflareRuntimeSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value: CloudflareSpanAttributeValue): void;
  end(): void;
}

/**
 * The subset of Cloudflare's `tracing` API this tracer needs, satisfied by both
 * `import { tracing } from "cloudflare:workers"` and `ctx.tracing`.
 */
export interface CloudflareTracing {
  startActiveSpan<T, A extends Array<unknown>>(
    name: string,
    callback: (span: CloudflareRuntimeSpan, ...args: A) => T,
    ...args: A
  ): T;
}

/**
 * Converts an Effect span attribute into a Cloudflare attribute value, or
 * `undefined` to omit it. Called on every attribute of every sampled span, so
 * keep it cheap. A mapper that throws never fails the request: the attribute is
 * dropped and the failure is reported with `console.error`.
 */
export type AttributeMapper = (
  key: string,
  value: unknown,
) => CloudflareSpanAttributeValue;

/** Options for {@link make} and {@link layer}. */
export interface Options {
  readonly tracing: CloudflareTracing;
  readonly attributeMapper?: AttributeMapper | undefined;
}

/**
 * Maps Effect span attributes onto the value types Cloudflare accepts, dropping
 * everything else. `bigint` is rendered as a string; unsupported values are
 * omitted rather than stringified.
 */
export const defaultAttributeMapper: AttributeMapper = (_key, value) => {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "bigint":
      return value.toString();
    default:
      return undefined;
  }
};

/** Creates a `Tracer` backed by Cloudflare Workers custom spans. */
export const make = (options: Options): Tracer.Tracer => {
  const attributeMapper = options.attributeMapper ?? defaultAttributeMapper;

  return Tracer.make({
    span: (spanOptions) =>
      new CloudflareSpan({
        ...spanOptions,
        tracing: options.tracing,
        attributeMapper,
      }),
  });
};

/** Provides {@link make} as the `Tracer` for the wrapped Effect. */
export const layer = (options: Options): Layer.Layer<never> =>
  Layer.succeed(Tracer.Tracer, make(options));

type NativeSpanOptions = ConstructorParameters<typeof Tracer.NativeSpan>[0];

interface CloudflareSpanOptions extends NativeSpanOptions {
  readonly tracing: CloudflareTracing;
  readonly attributeMapper: AttributeMapper;
}

class CloudflareSpan extends Tracer.NativeSpan {
  private readonly runtimeSpan: CloudflareRuntimeSpan | undefined;

  constructor(private readonly options: CloudflareSpanOptions) {
    super(options);
    // `startActiveSpan` is the only Cloudflare entry point that hands back a
    // span outliving its callback; the callback body is intentionally empty
    // because Cloudflare only keeps the span active for its duration, which is
    // useless to a fiber that resumes across many later ticks.
    this.runtimeSpan = options.sampled
      ? options.tracing.startActiveSpan(options.name, (span) => span)
      : undefined;
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") return;
    this.recordExit(exit);
    super.end(endTime, exit);
    this.runtimeSpan?.end();
  }

  override attribute(key: string, value: unknown): void {
    super.attribute(key, value);
    const span = this.runtimeSpan;
    // `isTraced` is false for unsampled invocations and after the Cloudflare
    // span ended, both cases where the attribute is discarded anyway, so skip
    // the mapper instead of paying for it.
    if (span === undefined || !span.isTraced) return;
    let mapped: CloudflareSpanAttributeValue;
    try {
      mapped = this.options.attributeMapper(key, value);
    } catch (error) {
      // Telemetry must not take the request down with it.
      console.error(`cf-effect-telemetry: attributeMapper threw for "${key}"`, error);
      return;
    }
    if (mapped !== undefined) {
      span.setAttribute(key, mapped);
    }
  }

  /**
   * Effect records log messages as span events and Cloudflare has no event API,
   * so keeping them would grow unboundedly for long-lived spans (Durable
   * Objects, streamed responses) with nothing ever reading them.
   */
  override event(): void {}

  /**
   * Cloudflare spans have no outcome/status API, so the `Exit` is recorded as
   * attributes, mirroring the conventions of Effect's own OTLP tracer.
   */
  private recordExit(exit: Exit.Exit<unknown, unknown>): void {
    if (Exit.isSuccess(exit)) return;
    const cause = exit.cause;

    if (Cause.hasInterruptsOnly(cause)) {
      this.attribute("span.label", "⚠︎ Interrupted");
      this.attribute("status.interrupted", true);
      return;
    }

    this.attribute("otel.status_code", "ERROR");
    const error = Cause.prettyErrors(cause)[0];
    if (error === undefined) return;
    this.attribute("otel.status_description", error.message);
    this.attribute("exception.type", error.name);
    this.attribute("exception.message", error.message);
    this.attribute("exception.stacktrace", truncate(error.stack ?? Cause.pretty(cause)));
  }
}

/**
 * Cloudflare does not document an attribute size cap, so keep stack traces well
 * clear of the limits tracing backends typically impose. `attributeMapper` can
 * trim or drop them further.
 */
const stackTraceLimit = 4096;

const truncate = (stack: string): string =>
  stack.length > stackTraceLimit ? `${stack.slice(0, stackTraceLimit)}…` : stack;
