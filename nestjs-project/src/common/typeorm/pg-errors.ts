import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

// TypeORM copies the driver error's own properties (code, detail, ...) onto
// the QueryFailedError instance itself — see typeorm's QueryFailedError
// constructor — but doesn't type them, since they're Postgres-specific.
interface PgQueryFailedError extends QueryFailedError {
  code?: string;
  detail?: string;
}

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as PgQueryFailedError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
