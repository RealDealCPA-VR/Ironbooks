/**
 * Zod schema for PUT /api/doc-numbers — the starting number of a document type
 * (lib/services/docNumbers.ts setStartingDocNumber).
 *
 * SERVER ONLY: it imports the document number service for its list of document types.
 */
import { z } from 'zod';
import { DOC_TYPES } from '@/lib/services/docNumbers';

export const docNumberSettingSchema = z.object({
  docType: z.enum(DOC_TYPES).describe('The kind of document whose numbering is set: invoice, estimate, sales_order, sales_receipt, credit_memo or purchase_order.'),
  startingNumber: z
    .string()
    .trim()
    .max(50)
    .nullable()
    .describe('Number the next document of that kind gets, such as "INV-5000", at most 50 characters; null or blank clears the starting number. A number already used is refused.'),
});
