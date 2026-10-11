/**
 * Request schema for POST /api/qb-import/gl (QuickBooks General Ledger migration).
 * Mirrors GlImportInput in lib/services/qbGlImport.ts.
 */
import { z } from 'zod';
import { QB_ACCOUNT_TYPES } from '@/lib/services/qbGlParse';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const zUpload = z.object({
  name: z.string().max(255),
  /** base64 file bytes */
  data: z.string().min(1, 'file is empty'),
});

export const qbGlImportSchema = z.object({
  action: z.enum(['preview', 'dry-run', 'import']),
  file: zUpload,
  references: z.array(zUpload).max(4).optional(),
  periodStart: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD').nullable().optional(),
  periodEnd: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD').nullable().optional(),
  accounts: z
    .record(
      z.object({
        qbType: z.enum(QB_ACCOUNT_TYPES).optional(),
        mapTo: z.string().max(64).optional(),
      }),
    )
    .optional(),
  acceptVariance: z.boolean().optional(),
});

export type QbGlImportRequest = z.infer<typeof qbGlImportSchema>;
