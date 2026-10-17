/**
 * GET   /api/custom-fields — the company's custom-field definitions:
 *       { customer: [{name}], vendor: [{name}], item: [{name}], invoice: [{name}] }
 * PATCH /api/custom-fields — replace definition lists. Entities omitted from the
 *       body keep their current lists; provided entities are replaced wholesale
 *       (pass [] to clear). Admin/owner only. Max 7 fields per entity (QB-like).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  getCustomFieldDefinitions,
  setCustomFieldDefinitions,
  CUSTOM_FIELD_ENTITIES,
  type CustomFieldEntity,
  type CustomFieldDefinition,
} from '@/lib/services/customFields';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[custom-fields/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const defs = await getCustomFieldDefinitions(ctx);
    return NextResponse.json(defs);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    const input: Partial<Record<CustomFieldEntity, CustomFieldDefinition[]>> = {};
    for (const entity of CUSTOM_FIELD_ENTITIES) {
      if (body[entity] !== undefined) {
        if (!Array.isArray(body[entity])) {
          return NextResponse.json(
            { error: `${entity} must be an array of { name } objects`, code: 'VALIDATION' },
            { status: 400 },
          );
        }
        input[entity] = body[entity];
      }
    }

    const defs = await setCustomFieldDefinitions(ctx, input);
    return NextResponse.json(defs);
  } catch (err) {
    return errorResponse(err);
  }
}
