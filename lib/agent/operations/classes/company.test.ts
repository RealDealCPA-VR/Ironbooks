import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { COMPANY_CLASSES } from './company';

describe('classification: company', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('company', COMPANY_CLASSES)).toEqual([]);
  });
});
