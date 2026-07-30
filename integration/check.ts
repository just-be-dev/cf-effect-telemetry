/**
 * Runs the integration worker on the real Workers runtime (`wrangler dev`) and
 * asserts that Cloudflare accepted everything the tracer does. Exits non-zero
 * with a report on the first failed expectation.
 */

const freePort = (): number => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

const port = Number(process.env.PORT ?? freePort());
const wrangler = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;

const server = Bun.spawn([wrangler, "dev", "--port", String(port)], {
  cwd: new URL(".", import.meta.url).pathname,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});

const shutdown = () => {
  server.kill();
};
process.on("exit", shutdown);
process.on("SIGINT", () => process.exit(130));

const url = `http://127.0.0.1:${port}/`;
const deadline = Date.now() + 120_000;
let response: Response | undefined;

while (Date.now() < deadline) {
  if (server.exitCode !== null) {
    const output = await new Response(server.stderr).text();
    throw new Error(`wrangler dev exited with ${server.exitCode}:\n${output}`);
  }
  try {
    response = await fetch(url);
    break;
  } catch {
    await Bun.sleep(250);
  }
}

if (response === undefined) throw new Error(`wrangler dev never served ${url}`);

const raw = await response.text();
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  throw new Error(
    `expected JSON from the integration worker, got ${response.status} ${
      response.headers.get("content-type") ?? "?"
    }:\n${raw.slice(0, 2000)}`,
  );
}

const body = parsed as {
  readonly result: string;
  readonly startActiveSpanType: string;
  readonly enterSpanType: string;
  readonly control: { readonly ok: boolean; readonly error?: string };
  readonly spans: Array<{
    readonly name: string;
    readonly attributes: Record<string, string | number | boolean>;
    readonly isTracedOnStart: boolean;
    readonly isTracedAfterEnd: boolean | undefined;
    readonly ends: number;
  }>;
};

const failures: Array<string> = [];
const check = (label: string, condition: boolean) => {
  if (!condition) failures.push(label);
};

const span = (name: string) => body.spans.find((candidate) => candidate.name === name);
const root = span("worker.fetch");
const failing = span("failing");
const cancelled = span("cancelled");

check("worker returned ok", body.result === "ok");
check("tracing.startActiveSpan is a function", body.startActiveSpanType === "function");
check("tracing.enterSpan is a function", body.enterSpanType === "function");
check("one Cloudflare span per sampled Effect span", body.spans.length === 3);
check("unsampled Effect spans open no Cloudflare span", span("unsampled") === undefined);
check("root span recorded", root !== undefined);
check("failing span recorded", failing !== undefined);
check("cancelled span recorded", cancelled !== undefined);
check(
  `runtime accepted every attribute type, end() twice and setAttribute after end${
    body.control.error === undefined ? "" : `: ${body.control.error}`
  }`,
  body.control.ok,
);
check(
  "every span ended exactly once",
  body.spans.every((candidate) => candidate.ends === 1),
);
check(
  "isTraced is false once a span has ended",
  body.spans.every((candidate) => candidate.isTracedAfterEnd === false),
);

// Cloudflare discards attributes when `isTraced` is false, and the tracer skips
// mapping them, so attribute contents can only be asserted where the invocation
// is actually sampled. Local `wrangler dev` never samples.
const sampled = root?.isTracedOnStart === true;

if (sampled) {
  check("string attributes accepted", root?.attributes.text === "value");
  check("numeric attributes accepted", root?.attributes.count === 1);
  check("boolean attributes accepted", root?.attributes.flag === true);
  check("bigint attributes stringified", root?.attributes.big === "7");
  check("unsupported attributes dropped", root?.attributes.dropped === undefined);
  check("late annotations accepted", root?.attributes.route === "/");

  check("failure recorded status", failing?.attributes["otel.status_code"] === "ERROR");
  check("failure recorded type", failing?.attributes["exception.type"] === "IntegrationError");
  check(
    "failure recorded message",
    failing?.attributes["exception.message"] === "expected failure",
  );
  check(
    "stack trace bounded",
    typeof failing?.attributes["exception.stacktrace"] === "string" &&
      (failing.attributes["exception.stacktrace"] as string).length <= 4097,
  );

  check("interruption labelled", cancelled?.attributes["status.interrupted"] === true);
  check("interruption not an error", cancelled?.attributes["otel.status_code"] === undefined);
} else {
  check(
    "unsampled invocations skip attribute mapping entirely",
    body.spans.every((candidate) => Object.keys(candidate.attributes).length === 0),
  );
}

console.log(JSON.stringify(body, null, 2));

// `wrangler dev` keeps the event loop alive, so stop it and exit explicitly.
server.kill();
await server.exited;

if (failures.length > 0) {
  console.error(`\n${failures.length} integration check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  sampled
    ? "\nAll integration checks passed against a sampled invocation."
    : "\nAll integration checks passed. This environment does not sample traces" +
      " (isTraced === false), so attribute contents were not asserted; run against a" +
      " deployed Worker to cover them.",
);
process.exit(0);
