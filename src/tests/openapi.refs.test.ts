import { readFileSync } from 'fs';
import { parse } from 'yaml';

describe('OpenAPI component refs', () => {
  const spec = parse(readFileSync('docs/openapi.yaml', 'utf8')) as any;

  test('components schemas include ErrorEnvelope and PaginationCursor', () => {
    expect(spec.components.schemas).toHaveProperty('ErrorEnvelope');
    expect(spec.components.schemas).toHaveProperty('PaginationCursor');
  });

  test('some path references ErrorEnvelope', () => {
    const paths = spec.paths;
    const refs = [] as string[];
    for (const pathKey of Object.keys(paths)) {
      const methods = paths[pathKey];
      for (const methodKey of Object.keys(methods)) {
        const responses = methods[methodKey].responses || {};
        for (const respKey of Object.keys(responses)) {
          const content = responses[respKey].content;
          if (content) {
            for (const mt of Object.keys(content)) {
              const schema = content[mt].schema;
              if (schema && schema['$ref'] && schema['$ref'].includes('ErrorEnvelope')) {
                refs.push(`${pathKey} ${methodKey} ${respKey}`);
              }
            }
          }
        }
      }
    }
    expect(refs.length).toBeGreaterThan(0);
  });

  test('transactions pagination uses PaginationCursor', () => {
    const txnPath = spec.paths['/api/transactions'];
    expect(txnPath).toBeDefined();
    const getMethod = txnPath.get;
    const schema = getMethod.responses[200].content['application/json'].schema;
    const paginationSchema = schema.properties.pagination;
    expect(paginationSchema['$ref']).toContain('PaginationCursor');
  });
});
