/** Contract-owned schemas are published verbatim for the Python worker and provider boundary. */
export type Schema = {
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
  $schema?: string;
  $id?: string;
  title?: string;
};
export const text = (maxLength = 4000): Schema => ({ type: 'string', maxLength });
export const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values });
export const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Schema => ({
  type: 'integer',
  minimum,
  maximum,
});
export const array = (items: Schema, maxItems = 200, minItems = 0): Schema => ({
  type: 'array',
  items,
  minItems,
  maxItems,
});
export const object = (properties: Record<string, Schema>): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
export const published = (name: string, shape: Schema): Schema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: name,
  ...shape,
});
export function fail(path: string, reason: string): never {
  throw new TypeError(`${path}: ${reason}`);
}
/** Small schema interpreter for the schema vocabulary above; no vendor/framework dependency. */
function validate(schema: Schema, value: unknown, path = '复刻数据'): void {
  if (schema.anyOf || schema.oneOf) {
    let matches = 0;
    for (const branch of (schema.anyOf ?? schema.oneOf)!) {
      try {
        validate(branch, value, path);
        matches++;
      } catch {
        /* Try the next declared branch. */
      }
    }
    if (schema.oneOf ? matches !== 1 : matches === 0) fail(path, '不符合约定结构');
    return;
  }
  if ('const' in schema && value !== schema.const) fail(path, '固定值无效');
  if (schema.enum && !schema.enum.includes(value)) fail(path, '枚举值无效');
  if (schema.type === 'null' && value !== null) fail(path, '必须为空');
  if (schema.type === 'boolean' && typeof value !== 'boolean') fail(path, '必须为布尔值');
  if (schema.type === 'string') {
    if (typeof value !== 'string') fail(path, '必须为文本');
    const length = Array.from(value).length;
    if (
      length < (schema.minLength ?? 0) ||
      length > (schema.maxLength ?? Infinity) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      fail(path, '文本长度或格式无效');
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    )
      fail(path, '数值超出范围');
  }
  if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      fail(path, '数组数量无效');
    value.forEach((item, index) => validate(schema.items!, item, `${path}[${index}]`));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须为对象');
    const record = value as Record<string, unknown>;
    if (
      schema.additionalProperties === false &&
      Object.keys(record).some((key) => !Object.hasOwn(schema.properties!, key))
    )
      fail(path, '包含未定义字段');
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, '缺少字段');
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (key in record) validate(child, record[key], `${path}.${key}`);
  }
}
function normalized(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').trim();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  return value;
}
export function parse<T>(schema: Schema, value: unknown): T {
  validate(schema, value);
  const result = normalized(value);
  validate(schema, result);
  return result as T;
}
