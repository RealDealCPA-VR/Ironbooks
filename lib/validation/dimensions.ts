/**
 * Zod schemas for /api/classes and /api/locations — mirror the inline input
 * types of createClass / createLocation (lib/services/dimensions.ts).
 */
import { z } from 'zod';
import { zUuid } from './helpers';

export const createClassSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .trim()
    .min(1, 'Class name is required.')
    .describe('Name of the class, such as "East region".'),
  parentId: zUuid.nullish().describe('Id of an active class (class list) this one is a subclass of; leave out for a top-level class.'),
});
export type CreateClassBody = z.infer<typeof createClassSchema>;

export const createLocationSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .trim()
    .min(1, 'Location name is required.')
    .describe('Name of the location, such as "Downtown store".'),
});
export type CreateLocationBody = z.infer<typeof createLocationSchema>;
