/**
 * Agent full access: the zod schema of an operation's body and query, and their JSON Schema for
 * describe_operation (plan §6.3).
 * STUB: the signatures are fixed; the bodies are still to be written.
 */
import type { ZodTypeAny } from 'zod';
import type { Operation } from './types';

/** The zod schema the route parses its body with, or null when it takes none or parses by hand. */
export async function loadBodySchema(_operation: Operation): Promise<ZodTypeAny | null> {
  throw new Error('loadBodySchema is not built yet.');
}

/** JSON Schema (draft 2020-12) of the body and of the query; null where there is none. */
export async function describeSchemas(_operation: Operation): Promise<{ body: unknown; query: unknown }> {
  throw new Error('describeSchemas is not built yet.');
}
