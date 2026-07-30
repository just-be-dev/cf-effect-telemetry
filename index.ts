import { Layer, Option, Tracer } from "effect";
import type { Context } from "effect/Context";
import type { Exit } from "effect/Exit";

const evaluateSymbol = "~effect/Effect/evaluate" as const;

export type CloudflareSpanAttributeValue = string | number | boolean | undefined;

export interface CloudflareRuntimeSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value: CloudflareSpanAttributeValue): void;
  end(): void;
}

export interface CloudflareTracing {
  startActiveSpan<T, A extends Array<unknown>>(
    name: string,
    callback: (span: CloudflareRuntimeSpan, ...args: A) => T,
    ...args: A
  ): T;
}

export type AttributeMapper = (
  key: string,
  value: unknown,
) => CloudflareSpanAttributeValue;

export interface Options {
  readonly tracing: CloudflareTracing;
  readonly attributeMapper?: AttributeMapper | undefined;
}

export const defaultAttributeMapper: AttributeMapper = (_key, value) => {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "bigint":
      return value.toString();
    case "undefined":
      return undefined;
    default:
      return undefined;
  }
};

export const make = (options: Options): Tracer.Tracer => {
  const attributeMapper = options.attributeMapper ?? defaultAttributeMapper;

  return Tracer.make({
    span(spanOptions) {
      return new CloudflareEffectSpan({
        ...spanOptions,
        tracing: options.tracing,
        attributeMapper,
      });
    },
    context(primitive, fiber) {
      const span = fiber.currentSpan;
      if (span instanceof CloudflareEffectSpan) {
        return span.runInContext(() => primitive[evaluateSymbol](fiber));
      }
      return primitive[evaluateSymbol](fiber);
    },
  });
};

export const layer = (options: Options): Layer.Layer<never> =>
  Layer.succeed(Tracer.Tracer, make(options));

interface CloudflareEffectSpanOptions {
  readonly name: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Context<never>;
  readonly links: Array<Tracer.SpanLink>;
  readonly startTime: bigint;
  readonly kind: Tracer.SpanKind;
  readonly sampled: boolean;
  readonly tracing: CloudflareTracing;
  readonly attributeMapper: AttributeMapper;
}

class CloudflareEffectSpan implements Tracer.Span {
  readonly _tag = "Span" as const;
  readonly spanId = randomHexString(16);
  readonly traceId: string;
  readonly attributes = new Map<string, unknown>();
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly name: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Context<never>;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;

  private runtimeSpan: CloudflareRuntimeSpan | undefined;

  constructor(private readonly options: CloudflareEffectSpanOptions) {
    this.name = options.name;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = options.links;
    this.sampled = options.sampled;
    this.kind = options.kind;
    this.traceId = Option.getOrUndefined(options.parent)?.traceId ?? randomHexString(32);
    this.status = {
      _tag: "Started",
      startTime: options.startTime,
    };
  }

  runInContext<X>(evaluate: () => X): X {
    if (this.runtimeSpan !== undefined || this.status._tag === "Ended" || !this.sampled) {
      return evaluate();
    }

    return this.options.tracing.startActiveSpan(this.name, (span) => {
      this.runtimeSpan = span;
      this.flushAttributes(span);
      const result = evaluate();
      if (this.status._tag === "Ended") {
        span.end();
      }
      return result;
    });
  }

  end(endTime: bigint, exit: Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") return;
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit,
    };
    this.runtimeSpan?.end();
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
    if (this.runtimeSpan !== undefined) {
      setCloudflareAttribute(this.runtimeSpan, this.options.attributeMapper, key, value);
    }
  }

  event(_name: string, _startTime: bigint, _attributes?: Record<string, unknown>): void {
    // Cloudflare custom spans do not expose span events yet.
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
  }

  private flushAttributes(span: CloudflareRuntimeSpan): void {
    for (const [key, value] of this.attributes) {
      setCloudflareAttribute(span, this.options.attributeMapper, key, value);
    }
  }
}

const setCloudflareAttribute = (
  span: CloudflareRuntimeSpan,
  attributeMapper: AttributeMapper,
  key: string,
  value: unknown,
): void => {
  const mapped = attributeMapper(key, value);
  if (mapped !== undefined) {
    span.setAttribute(key, mapped);
  }
};

const randomHexString = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += (bytes[i]! & 0x0f).toString(16);
  }
  return result;
};
