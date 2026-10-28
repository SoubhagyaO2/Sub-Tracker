/**
 * What may be logged about an error, and nothing else.
 *
 * Raw error text is untrustworthy: a PostgreSQL error's `message`, `detail`, `where` and `hint` routinely quote row values
 * ("Key (email)=(jane@example.com) already exists"), SMTP errors quote recipients and provider replies, and JSON parse
 * errors quote the request body. So the log gets only fixed, non-data fields:
 *   - the error class name,
 *   - a machine code (PostgreSQL SQLSTATE, Node `ECONN...` code, SMTP numeric response code),
 *   - PostgreSQL identifier names (schema / table / column / constraint), which are part of the schema, never of the data,
 *   - the first stack frames (file and function names only; the first stack line holds the message, so it is dropped).
 */
export interface SafeError {
  errorName: string;
  errorCode?: string | number;
  constraint?: string;
  table?: string;
  column?: string;
  frames?: string[];
}

const IDENT = /^[A-Za-z0-9_$.]{1,128}$/;
const pick = (v: unknown): string | undefined => (typeof v === 'string' && IDENT.test(v) ? v : undefined);

export function describeError(err: unknown): SafeError {
  if (typeof err !== 'object' || err === null) return { errorName: typeof err };
  const e = err as Record<string, unknown>;
  const out: SafeError = { errorName: typeof e.name === 'string' && IDENT.test(e.name) ? e.name : 'Error' };
  const code = pick(e.code);
  if (code) out.errorCode = code;
  else if (typeof e.responseCode === 'number') out.errorCode = e.responseCode;
  for (const k of ['constraint', 'table', 'column'] as const) {
    const v = pick(e[k]);
    if (v) out[k] = v;
  }
  if (typeof e.stack === 'string') {
    const frames = e.stack
      .split('\n')
      .filter((l) => /^\s+at /.test(l)) // drops the message lines
      .slice(0, 6)
      .map((l) => l.trim().replace(/\(?[A-Za-z]:.*?(apps|packages|node_modules)/, '($1').slice(0, 160));
    if (frames.length) out.frames = frames;
  }
  return out;
}
