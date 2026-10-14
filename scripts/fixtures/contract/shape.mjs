// A small shape checker for the contract tests: the response must carry
// every key the schema names, each of the named type. Extra keys pass (an
// addition does not break a client); a renamed, removed or retyped key fails.
//
// A schema is one of:
//   'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'any'
//   'date'     a local calendar date, YYYY-MM-DD
//   'sqltime'  SQLite's datetime('now'), YYYY-MM-DD HH:MM:SS (UTC)
//   'isotime'  an ISO 8601 instant in UTC, ending in Z
//   'json'     a string holding JSON
//   unions with '|' ('string|null'); a trailing '?' makes an object key optional
//   [elem]     an array whose every element matches elem ([] for any array)
//   { key: schema }  an object with at least those keys
//   optional(schema) for an optional key with a non-string schema
//   oneOf(a, b, ...) any of several schemas
import assert from 'node:assert/strict';

const OPTIONAL = Symbol('optional');
const ONE_OF = Symbol('oneOf');
export const optional = schema => ({ [OPTIONAL]: schema });
export const oneOf = (...schemas) => ({ [ONE_OF]: schemas });

const isPlainObject = v => v != null && typeof v === 'object' && !Array.isArray(v);
const CHECKS = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  integer: v => Number.isInteger(v),
  boolean: v => typeof v === 'boolean',
  null: v => v === null,
  array: v => Array.isArray(v),
  object: isPlainObject,
  any: () => true,
  date: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  sqltime: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v),
  isotime: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v),
  json: v => { if (typeof v !== 'string') return false; try { JSON.parse(v); return true; } catch { return false; } },
};

function problems(value, schema, path) {
  if (typeof schema === 'string') {
    const types = schema.replace(/\?$/, '').split('|');
    for (const t of types) if (!CHECKS[t]) throw new Error(`unknown type "${t}" in schema at ${path}`);
    return types.some(t => CHECKS[t](value)) ? [] : [`${path}: expected ${types.join('|')}, got ${JSON.stringify(value)?.slice(0, 80)}`];
  }
  if (schema && schema[ONE_OF]) {
    const all = schema[ONE_OF].map(s => problems(value, s, path));
    return all.some(p => p.length === 0) ? [] : [`${path}: matches none of ${schema[ONE_OF].length} shapes (${all.map(p => p[0]).join(' / ')})`];
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return [`${path}: expected an array, got ${JSON.stringify(value)?.slice(0, 80)}`];
    if (!schema.length) return [];
    return value.flatMap((v, i) => problems(v, schema[0], `${path}[${i}]`));
  }
  if (isPlainObject(schema)) {
    if (!isPlainObject(value)) return [`${path}: expected an object, got ${JSON.stringify(value)?.slice(0, 80)}`];
    const out = [];
    for (const [key, sub] of Object.entries(schema)) {
      const isOptional = (typeof sub === 'string' && sub.endsWith('?')) || (sub && sub[OPTIONAL] !== undefined);
      const inner = sub && sub[OPTIONAL] !== undefined ? sub[OPTIONAL] : sub;
      if (!(key in value) || value[key] === undefined) {
        if (!isOptional) out.push(`${path}.${key}: missing`);
        continue;
      }
      out.push(...problems(value[key], inner, `${path}.${key}`));
    }
    return out;
  }
  throw new Error(`bad schema at ${path}`);
}

/** Throws (an AssertionError listing every mismatch) unless value matches schema. */
export function assertShape(value, schema, label = '$') {
  const found = problems(value, schema, label);
  assert.ok(found.length === 0, `shape mismatch:\n  ${found.join('\n  ')}`);
}

/** The mismatches, for tests of the checker itself. */
export const shapeProblems = (value, schema) => problems(value, schema, '$');
