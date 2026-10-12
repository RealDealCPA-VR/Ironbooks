/**
 * Pull a JSON value out of a model reply. Models wrap JSON in ```json fences, prepend
 * "Here is the JSON:" or trail commentary; we take the first balanced {...} / [...] block.
 */
export function extractJson(text: string): unknown {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new Error('Empty reply.');
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          return JSON.parse(trimmed.slice(start, i + 1));
        }
      }
    }
  }
  throw new Error('Reply did not contain valid JSON.');
}
