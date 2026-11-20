import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { DOCUMENTS_CLASSES } from './documents';

describe('classification: documents', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('documents', DOCUMENTS_CLASSES)).toEqual([]);
  });
});
