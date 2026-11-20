import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { PLANNING_CLASSES } from './planning';

describe('classification: planning', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('planning', PLANNING_CLASSES)).toEqual([]);
  });
});
