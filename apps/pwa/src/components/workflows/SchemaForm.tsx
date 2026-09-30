'use client';

// 플러그인 노드의 `inputs` 폼 — kind 가 싣고 온 JSON Schema 부분집합을 칸으로 그린다(0.2.5 K3 · 🅕 P-F4).
// 푸는 일·검증은 순수 모듈 `schema-form.ts`(#21824)가 한다. 이 파일은 그리기와 값 경로 쓰기만.
// ⛔ effect 안에서 부모 값을 다시 바꾸지 않는다 — 값은 입력 이벤트에서만 onChange 로 올라간다(반복 렌더 금지).

import { useMemo } from 'react';
import { flattenSchema, validateSchemaValue, type SchemaField } from './schema-form';

export type SchemaValue = Record<string, unknown>;

/** `a.b` 경로의 값. 배열 경로(`[]`)는 폼이 다루지 않는다. */
export function getPath(value: SchemaValue, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** `a.b` 경로에 값을 쓴 «새» 객체 — 원본은 바꾸지 않고, 경로 밖 키는 그대로 둔다. `undefined` 면 그 키를 뺀다. */
export function setPath(value: SchemaValue, path: string, next: unknown): SchemaValue {
  const [head, ...rest] = path.split('.');
  const out: SchemaValue = { ...value };
  if (rest.length === 0) {
    if (next === undefined) delete out[head];
    else out[head] = next;
    return out;
  }
  const child = out[head];
  const base = child !== null && typeof child === 'object' && !Array.isArray(child) ? (child as SchemaValue) : {};
  out[head] = setPath(base, rest.join('.'), next);
  return out;
}

/** 폼에 칸으로 그릴 수 있는 필드(스칼라 · 배열 밖). 객체는 칸이 아니라 묶음이다. */
export function formFields(fields: readonly SchemaField[]): { leaves: SchemaField[]; arrays: SchemaField[] } {
  const leaves: SchemaField[] = [];
  const arrays: SchemaField[] = [];
  for (const f of fields) {
    if (f.path.includes('[]')) continue;
    if (f.type === 'array') arrays.push(f);
    else if (f.type !== 'object') leaves.push(f);
  }
  return { leaves, arrays };
}

function parseInput(field: SchemaField, raw: string): unknown {
  if (raw === '') return undefined;
  if (field.type === 'number' || field.type === 'integer') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

export function SchemaForm({ schema, value, onChange }: { schema: unknown; value: SchemaValue; onChange: (next: SchemaValue) => void }) {
  const flat = useMemo(() => flattenSchema(schema), [schema]);
  const { leaves, arrays } = useMemo(() => formFields(flat.fields), [flat]);
  const errors = useMemo(() => validateSchemaValue(schema, value), [schema, value]);
  const errorFor = (path: string) => errors.find((e) => e.path === path)?.message;

  return (
    <div className="col-span-full flex flex-col gap-2" data-schema-form>
      {flat.unsupported.length > 0 && (
        <p className="text-[11px] text-warning" data-schema-unsupported>
          이 노드의 설정 일부는 폼이 다루지 않습니다({flat.unsupported.slice(0, 3).join(', ')}{flat.unsupported.length > 3 ? ` 외 ${flat.unsupported.length - 3}` : ''}) — YAML 에서 고치세요.
        </p>
      )}
      {arrays.length > 0 && (
        <p className="text-[11px] text-text-tertiary">목록 칸({arrays.map((a) => a.label).join(', ')})은 YAML 에서 고치세요.</p>
      )}
      {leaves.map((f) => {
        const current = getPath(value, f.path);
        const id = `schema-${f.path}`;
        const err = errorFor(f.path);
        const label = `${f.label}${f.required ? ' *' : ''}`;
        const common = 'w-full rounded-md border border-border bg-surface px-2 py-1 text-xs';
        let input: React.ReactNode;
        if (f.type === 'boolean') {
          input = <input id={id} type="checkbox" checked={current === true} onChange={(e) => onChange(setPath(value, f.path, e.target.checked))} />;
        } else if (f.enum && f.enum.length > 0) {
          input = (
            <select id={id} className={common} value={current === undefined ? '' : String(current)} onChange={(e) => {
              const picked = f.enum!.find((opt) => String(opt) === e.target.value);
              onChange(setPath(value, f.path, e.target.value === '' ? undefined : picked));
            }}>
              <option value="">(비움)</option>
              {f.enum.map((opt) => <option key={String(opt)} value={String(opt)}>{String(opt)}</option>)}
            </select>
          );
        } else if (f.multiline) {
          input = <textarea id={id} rows={4} className={`${common} font-mono`} value={typeof current === 'string' ? current : current === undefined ? '' : String(current)} onChange={(e) => onChange(setPath(value, f.path, parseInput(f, e.target.value)))} />;
        } else {
          input = (
            <input
              id={id}
              type={f.secret ? 'password' : f.type === 'number' || f.type === 'integer' ? 'number' : 'text'}
              autoComplete={f.secret ? 'off' : undefined}
              className={common}
              placeholder={f.default !== undefined ? String(f.default) : undefined}
              value={current === undefined ? '' : String(current)}
              onChange={(e) => onChange(setPath(value, f.path, parseInput(f, e.target.value)))}
            />
          );
        }
        return (
          <div key={f.path} className="flex flex-col gap-0.5" data-schema-field={f.path}>
            <label htmlFor={id} className="text-[11px] text-text-secondary">{label}</label>
            {input}
            {f.description && <span className="text-[10px] text-text-tertiary">{f.description}</span>}
            {err && <span className="text-[11px] text-error" role="alert" data-schema-error={f.path}>{err}</span>}
          </div>
        );
      })}
    </div>
  );
}
