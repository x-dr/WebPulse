export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export function databaseError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(503, 'storage_unavailable');
}
