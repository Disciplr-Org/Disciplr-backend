import {
  initTracing,
  getTracer,
  isTracingEnabled,
  flushTracing,
  shutdownTracing,
  parseTraceparent,
  serializeTraceparent,
  generateTraceId,
  generateSpanId,
  InMemoryExporter,
  _setTracerForTesting,
  _resetTracingForTesting,
} from './tracing';

describe('tracing', () => {
  beforeEach(() => {
    _resetTracingForTesting();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    _resetTracingForTesting();
  });

  describe('trace context', () => {
    it('generates valid trace IDs', () => {
      const traceId = generateTraceId();
      expect(traceId).toHaveLength(32);
      expect(/^[0-9a-f]{32}$/.test(traceId)).toBe(true);
    });

    it('generates valid span IDs', () => {
      const spanId = generateSpanId();
      expect(spanId).toHaveLength(16);
      expect(/^[0-9a-f]{16}$/.test(spanId)).toBe(true);
    });

    it('parses and serializes W3C traceparent', () => {
      const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const parsed = parseTraceparent(header);
      expect(parsed).toEqual({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: '01',
      });

      const serialized = serializeTraceparent(parsed!);
      expect(serialized).toBe(header);
    });

    it('returns null for invalid traceparent', () => {
      expect(parseTraceparent('invalid')).toBeNull();
      expect(parseTraceparent('00-short-id-01')).toBeNull();
    });
  });

  describe('tracer and spans', () => {
    it('uses NoopTracer when disabled', () => {
      initTracing(); // No endpoint set
      expect(isTracingEnabled()).toBe(false);
      const span = getTracer().startSpan('test');
      expect(span.traceId).toBe('');
    });

    it('creates active spans when enabled', async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
      initTracing({ samplingRate: 1 });
      expect(isTracingEnabled()).toBe(true);

      const tracer = getTracer();
      // Inject InMemoryExporter to verify spans
      const exporter = new InMemoryExporter();
      // Using an internal trick for testing since we don't expose exporter injection directly,
      // but we can test `withSpan` and manual span endings.
      
      const span = tracer.startSpan('test-span', null, { custom: 'value' });
      expect(span.traceId).toHaveLength(32);
      expect(span.spanId).toHaveLength(16);
      expect(span.name).toBe('test-span');
      
      span.addEvent('test-event');
      span.end();
      
      await shutdownTracing();
    });

    it('handles withSpan correctly', async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
      initTracing({ samplingRate: 1 });
      
      const tracer = getTracer();
      const result = await tracer.withSpan('test-async', async (span) => {
        expect(span.name).toBe('test-async');
        return 'success';
      });
      expect(result).toBe('success');
      
      expect(() => {
        tracer.withSpan('test-sync-error', (span) => {
          throw new Error('fail');
        });
      }).toThrow('fail');
      
      await shutdownTracing();
    });
  });
  
  describe('InMemoryExporter', () => {
    it('stores spans', () => {
      const exporter = new InMemoryExporter();
      exporter.export([{ name: 'test' } as any]);
      expect(exporter.spans.length).toBe(1);
      exporter.reset();
      expect(exporter.spans.length).toBe(0);
    });
  });
});
