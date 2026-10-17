/**
 * POST /api/custom-fields/values — set custom-field VALUES on an entity row.
 *   Body: { entity: 'customer'|'vendor'|'item'|'invoice', id: uuid,
 *           values: { [definedFieldName]: string } }
 * Values patch-merge onto the row's custom_fields jsonb; an empty string clears
 * a key. Keys must match a defined field name (define via PATCH /api/custom-fields).
 * Returns the stored values map.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  setEntityCustomFields,
  CUSTOM_FIELD_ENTITIES,
  type CustomFieldEntity,
} from '@/lib/services/customFields';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[custom-fields/values]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    if (!CUSTOM_FIELD_ENTITIES.includes(body.entity)) {
      return NextResponse.json(
        { error: `entity must be one of: ${CUSTOM_FIELD_ENTITIES.join(', ')}`, code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (!body.id || typeof body.id !== 'string') {
      return NextResponse.json({ error: 'id is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      return NextResponse.json(
        { error: 'values must be an object of { fieldName: value }', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const values = await setEntityCustomFields(
      ctx,
      body.entity as CustomFieldEntity,
      body.id,
      body.values as Record<string, string>,
    );
    return NextResponse.json({ entity: body.entity, id: body.id, values });
  } catch (err) {
    return errorResponse(err);
  }
}
