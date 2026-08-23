/** Minimal structural types for Vercel Node functions — avoids a dependency
 *  on @vercel/node just for signatures the runtime already enforces. */
export interface DemoRequest {
  method?: string
  url?: string
  body?: unknown
}

export interface DemoResponse {
  status(code: number): DemoResponse
  json(body: unknown): void
  setHeader(name: string, value: unknown): void
  end(body?: unknown): void
}
