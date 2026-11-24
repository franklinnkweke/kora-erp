import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);

/** Wraps a handler so thrown errors (sync or async) reach the error middleware. */
export const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out instanceof Promise) out.catch(next);
    } catch (e) {
      next(e);
    }
  };

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

export function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
  return id;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/.test(msg)) return res.status(409).json({ error: 'That record already exists' });
  if (/FOREIGN KEY constraint failed/.test(msg)) return res.status(409).json({ error: 'Linked record is missing or still in use' });
  if (err instanceof SyntaxError && 'body' in (err as object)) return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
}
