/**
 * Round-5 review regression (lib/db/pgErrors.ts): text longer than a varchar(n) column holds
 * (SQLSTATE 22001, e.g. a 150-character Entry No.) is a VALIDATION error naming the limit, not a
 * raw Postgres error that every route answered with 500.
 */
import { describe, it, expect } from 'vitest';
import { translatePgError } from './pgErrors';

describe('translatePgError: value too long (review round 5)', () => {
  it('maps 22001 to VALIDATION with the column limit', () => {
    expect(translatePgError({ code: '22001', message: 'value too long for type character varying(100)' })).toMatchObject({
      code: 'VALIDATION',
      message: 'That text is too long: at most 100 characters fit in that field.',
    });
    expect(translatePgError({ code: '22001', message: 'value too long for type character(3)' })).toMatchObject({
      code: 'VALIDATION',
      message: 'That text is too long: at most 3 characters fit in that field.',
    });
    expect(translatePgError({ code: '22001', message: 'value too long' })).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/too long/),
    });
  });
});

describe('translatePgError: a NUL character in text (integration sweep)', () => {
  it('maps 22021 to VALIDATION, so a search for a NUL character is a 400, not a 500', () => {
    expect(translatePgError({ code: '22021', message: 'invalid byte sequence for encoding "UTF8": 0x00' })).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/NUL character/),
    });
  });
});
