export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type HttpTransport = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (url, request = {}) =>
  fetch(url, {
    ...(request.method ? { method: request.method } : {}),
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.body ? { body: request.body } : {}),
  });

export async function responseJson(response: HttpResponse, operation: string): Promise<unknown> {
  if (response.status < 200 || response.status >= 300) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(
      `${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response.json();
}

export function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${context} response`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${context}`);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
