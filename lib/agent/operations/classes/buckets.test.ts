import { describe, expect, it } from 'vitest';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';
import { CLASS_BUCKETS, CLASS_BUCKET_NAMES, bucketOfRoute, routeSegment } from './buckets';

describe('classification buckets', () => {
  it('put every API route in exactly one bucket', () => {
    const seen = new Map<string, string>();
    for (const name of CLASS_BUCKET_NAMES) {
      for (const seg of CLASS_BUCKETS[name]) {
        expect(seen.get(seg), `segment "${seg}" is in two buckets`).toBeUndefined();
        seen.set(seg, name);
      }
    }
    const homeless = Object.keys(API_ROUTE_PERMISSIONS).filter((p) => bucketOfRoute(p) === null);
    expect(homeless).toEqual([]);
    const used = new Set(Object.keys(API_ROUTE_PERMISSIONS).map(routeSegment));
    expect([...seen.keys()].filter((s) => !used.has(s))).toEqual([]);
  });
});
