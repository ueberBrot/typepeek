import type { Tracer } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import type { createHarnessArtifacts } from "./artifacts.ts";

export const createHarnessTraces = (
  artifacts: ReturnType<typeof createHarnessArtifacts>
) => {
  const exporter = new InMemorySpanExporter();

  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });

  const tracer: Tracer = provider.getTracer("typepeek/sandbox-harness");

  return {
    close: async () => {
      try {
        await provider.forceFlush();

        for (const span of exporter.getFinishedSpans()) {
          artifacts.record("traces.jsonl", {
            attributes: span.attributes,
            context: span.spanContext(),
            duration: span.duration,
            events: span.events,
            links: span.links,
            name: span.name,
            parent: span.parentSpanContext,
            startTime: span.startTime,
            status: span.status,
          });
        }
      } finally {
        await provider.shutdown();
      }
    },
    tracer,
  };
};
