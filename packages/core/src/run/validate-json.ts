/**
 * A small JSON Schema checker for workflow outputs: `type`, `properties`, `required`,
 * `items`, `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `minItems`. Enough for a
 * `start_workflow(output_schema)` contract; anything else in the schema is ignored.
 */
export type JsonSchema = Record<string, unknown>;

/** What a value is, the way a person names it (an integer is a number). */
const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

const matchesType = (v: unknown, t: string): boolean => {
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  return typeOf(v) === t;
};

/** The problems, as `path: message` lines; empty when the value matches. */
export function validateJson(value: unknown, schema: JsonSchema, path = ''): string[] {
  const at = (p: string) => (path ? `${path}${p}` : p.replace(/^\./, ''));
  const out: string[] = [];
  const types =
    schema.type === undefined
      ? []
      : Array.isArray(schema.type)
        ? (schema.type as string[])
        : [String(schema.type)];
  const label = (msg: string) => (path ? `${at('')}: ${msg}` : msg);
  if (types.length && !types.some((t) => matchesType(value, t)))
    return [label(`expected ${types.join(' or ')}, got ${typeOf(value)}`)];
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
  )
    out.push(label(`must be one of ${(schema.enum as unknown[]).map(String).join(', ')}`));
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      out.push(label(`shorter than ${schema.minLength}`));
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      out.push(label(`longer than ${schema.maxLength}`));
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      out.push(label(`below ${schema.minimum}`));
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      out.push(label(`above ${schema.maximum}`));
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      out.push(label(`fewer than ${schema.minItems} items`));
    if (schema.items && typeof schema.items === 'object')
      for (const [i, item] of value.entries())
        out.push(...validateJson(item, schema.items as JsonSchema, `${path}[${i}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!(key in obj)) out.push(`${path ? `${path}.` : ''}${key}: required`);
    for (const [key, sub] of Object.entries(props))
      if (key in obj) out.push(...validateJson(obj[key], sub, path ? `${path}.${key}` : key));
  }
  return out.map((l) => l.replace(/^\./, ''));
}
