import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { LISTS_CLASSES } from './lists';

describe('classification: lists', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('lists', LISTS_CLASSES)).toEqual([]);
  });
});
