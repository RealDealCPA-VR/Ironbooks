import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { REPORTS_CLASSES } from './reports';

describe('classification: reports', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('reports', REPORTS_CLASSES)).toEqual([]);
  });
});
