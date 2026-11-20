import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { PAYROLL_CLASSES } from './payroll';

describe('classification: payroll', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('payroll', PAYROLL_CLASSES)).toEqual([]);
  });
});
