import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { BANKING_CLASSES } from './banking';

describe('classification: banking', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('banking', BANKING_CLASSES)).toEqual([]);
  });
});
