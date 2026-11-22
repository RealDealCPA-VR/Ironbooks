/**
 * Zod schemas for the bill of materials of an assembly item and its pending builds (PUT / PATCH
 * /api/assemblies, POST /api/assemblies/pending; lib/services/assemblies.ts setBom and
 * createPendingBuild).
 *
 * These routes read their body by hand, and their own checks answer first with the messages they
 * always gave. The schema is checked after them: it says what each field is, for agents
 * (describe_operation, plan §6.3), and refuses only a value the service could not use anyway (an
 * id or a date that is not text). The components list and the memo are left to the service, which
 * checks them with its own words ("Component 2: choose the component item."), so they are
 * zLenient and what each route accepts and answers is unchanged.
 */
import { z } from 'zod';
import { zLenient } from './helpers';

const assemblyItemId = z
  .string({ invalid_type_error: 'must be the id of an assembly item' })
  .min(1)
  .describe('Id of the assembly item (item list, type assembly).');

/** PUT /api/assemblies (PATCH is the same) — replace the whole bill of materials of an assembly. */
export const setBomSchema = z.object({
  assemblyItemId,
  components: zLenient(
    z
      .array(
        z.object({
          componentItemId: z
            .string()
            .min(1)
            .describe('Id of the component item (item list); not the assembly itself, and each component at most once.'),
          quantity: z
            .union([z.string(), z.number()])
            .describe('How many of the component one assembly uses, as decimal text above zero such as "2" or "0.5" (kept to 4 decimals).'),
        }),
      )
      .nullable(),
  ).describe(
    'Every component of the assembly, replacing the saved list; send an empty list (or leave out) to clear it. Builds already made are not changed.',
  ),
});

/** POST /api/assemblies/pending — queue a build to finish later (QB Pending Builds). */
export const createPendingBuildSchema = z.object({
  assemblyItemId: assemblyItemId.describe('Id of the assembly item to build (item list, type assembly); it needs a bill of materials.'),
  quantity: z
    .union([z.string(), z.number()], { invalid_type_error: 'must be a number' })
    .describe('How many assemblies to build, as decimal text above zero such as "5". Nothing is built or posted until the build is finalized.'),
  date: z
    .string({ invalid_type_error: 'must be a date (YYYY-MM-DD)' })
    .min(1)
    .describe('Date of the pending build, YYYY-MM-DD.'),
  memo: zLenient(z.string().nullable()).describe('Note saved with the pending build; leave out for none.'),
});
