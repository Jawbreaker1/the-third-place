export const PUBLIC_JSON_BODY_LIMIT_BYTES = 16 * 1024;
export const ADMIN_JSON_BODY_LIMIT_BYTES = 128 * 1024;

export const isAdminApiPath = (path: string): boolean =>
  path === "/api/admin" || path.startsWith("/api/admin/");

export const jsonBodyLimitBytes = (path: string): number =>
  isAdminApiPath(path) ? ADMIN_JSON_BODY_LIMIT_BYTES : PUBLIC_JSON_BODY_LIMIT_BYTES;
