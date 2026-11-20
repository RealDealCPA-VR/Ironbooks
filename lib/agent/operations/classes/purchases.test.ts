import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { PURCHASES_CLASSES } from './purchases';

describe('classification: purchases', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('purchases', PURCHASES_CLASSES)).toEqual([]);
  });
});
