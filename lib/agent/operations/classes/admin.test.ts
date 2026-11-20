import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { ADMIN_CLASSES } from './admin';

describe('classification: admin', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('admin', ADMIN_CLASSES)).toEqual([]);
  });
});
