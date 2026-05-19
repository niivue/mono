// Shared HTTP utilities for Express route handlers — pulled out so route
// modules don't each declare their own copy of `HttpError` / `asyncHandler`
// / `parseLevel`. The error handler in `server.ts` reads `err.status`
// duck-typed, so this class doesn't need to be the same identity across
// imports; it is exported as the single source of truth anyway.

import type { NextFunction, Request, RequestHandler, Response } from 'express'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export type AsyncRouteHandler = (req: Request, res: Response) => Promise<void>

export function asyncHandler(fn: AsyncRouteHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next)
}

/**
 * Parse a pyramid-level query/path value. Accepts undefined/empty as 0.
 * Throws HttpError(400) for non-integer or negative inputs.
 */
export function parseLevel(s: unknown): number {
  if (s === undefined || s === null || s === '') return 0
  const n = Number(s)
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, `Invalid level: ${String(s)}`)
  }
  return n
}
