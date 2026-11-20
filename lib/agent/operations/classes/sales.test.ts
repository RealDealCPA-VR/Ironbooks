import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { SALES_CLASSES } from './sales';

describe('classification: sales', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('sales', SALES_CLASSES)).toEqual([]);
  });
});
