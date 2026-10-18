export type DatabaseError = { code: string; message: string };

const VISIT_ERROR_STATUS = new Map<string, number>([
  ["42501", 403],
  ["PT409", 409],
  ["22023", 400],
  ["22P02", 400],
  ["22007", 400],
  ["22008", 400],
  ["23502", 400],
  ["23503", 400],
  ["23514", 400],
]);

export function visitErrorResponse(error: DatabaseError): Response {
  const status = VISIT_ERROR_STATUS.get(error.code);
  if (status === undefined) throw error;
  return Response.json({ error: error.message }, { status });
}
