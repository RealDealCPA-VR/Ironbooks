/**
 * Zod schemas for sales reps (POST /api/sales-reps, PATCH /api/sales-reps/:id, POST
 * /api/sales-reps/assign; lib/services/salesReps.ts).
 *
 * These routes read their body by hand, and their own checks answer first with the messages they
 * always gave (a name and an email must be text). The schema is checked after them: it says what
 * each field is, for agents (describe_operation, plan §6.3). The email address and the commission
 * rate are checked by the service with its own words, so the rate is zLenient and the email is
 * only text here: what each route accepts and answers is unchanged.
 *
 * The edit route always hands the service all three fields, so an email left out is cleared, not
 * kept, and a null rate is saved as 0: the texts below say so, because an agent that renames a rep
 * by sending the name alone would otherwise wipe the rep's email. The one body the edit schema
 * refuses that the route let through is a null name, which the service cannot read (it answered
 * 500): now it answers 400 with a message that says to leave the name out.
 */
import { z } from 'zod';
import { zLenient } from './helpers';

const commissionRate = (missing: string) =>
  zLenient(z.union([z.string(), z.number()]).nullable()).describe(
    `Commission as a decimal fraction from 0 to 1, such as "0.05" for 5% (kept to 4 decimals); ${missing}.`,
  );

/** POST /api/sales-reps — add a sales rep. */
export const createSalesRepSchema = z.object({
  name: z.string().describe('Name of the sales rep, such as "Pat Lee".'),
  email: z.string().nullish().describe('Email address of the sales rep; leave out for none.'),
  commissionRate: commissionRate('leave out for 0'),
});

/** PATCH /api/sales-reps/:id — change a sales rep's name, email or commission rate. */
export const updateSalesRepSchema = z.object({
  name: z
    .string({ invalid_type_error: 'must be text; leave the name out to keep it' })
    .optional()
    .describe('New name of the sales rep; leave out to keep the name.'),
  email: z
    .string()
    .nullish()
    .describe(
      'Email address of the sales rep. Send the current email again to keep it: leaving it out, or sending null or empty text, clears it.',
    ),
  commissionRate: commissionRate('leave out to keep the rate; null sets it to 0'),
});

/** POST /api/sales-reps/assign — set or clear the sales rep of a saved invoice. */
export const assignSalesRepSchema = z.object({
  invoiceId: z
    .string({ invalid_type_error: 'must be the id of an invoice' })
    .min(1)
    .describe('Id of the invoice (invoice list) whose sales rep is set.'),
  salesRepId: zLenient(z.string().nullable()).describe(
    'Id of an active sales rep (GET /api/sales-reps lists them) to put on the invoice; send null or leave out to take the rep off.',
  ),
});
