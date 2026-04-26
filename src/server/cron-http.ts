export function createHttpError(
  statusCode: number,
  message: string,
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizeNonEmptyString(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw createHttpError(400, `${field} is required`);
  }
  return normalized;
}
