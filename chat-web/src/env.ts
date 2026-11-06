// The page talks to one origin. In development Vite proxies /v1 to the local
// ds4-server, so nothing is configured and the origin stays empty; a build that
// lives somewhere else points at the server with VITE_API_BASE.

export function apiOrigin(): string {
  const values: Record<string, string | undefined> = import.meta.env;
  const configured = values['VITE_API_BASE']?.trim().replace(/\/+$/, '');
  return configured ?? '';
}
