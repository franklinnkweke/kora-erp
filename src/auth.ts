import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
import { HttpError } from './http.js';

export type Role = 'admin' | 'sales' | 'warehouse' | 'accounts';
export interface AuthUser { id: number; email: string; name: string; role: Role }

declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function checkPassword(pw: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, got);
}

export function signToken(user: AuthUser, secret: string): string {
  return jwt.sign({ sub: String(user.id), email: user.email, name: user.name, role: user.role }, secret, {
    expiresIn: '12h',
    issuer: 'kora-erp',
  });
}

export const requireAuth =
  (secret: string): RequestHandler =>
  (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return next(new HttpError(401, 'Sign in required'));
    try {
      const p = jwt.verify(token, secret, { issuer: 'kora-erp' }) as jwt.JwtPayload;
      req.user = { id: Number(p.sub), email: p.email, name: p.name, role: p.role };
      next();
    } catch {
      next(new HttpError(401, 'Session expired, please sign in again'));
    }
  };

/** Which roles may do what. Admin can do everything. */
export const can =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    const role = req.user?.role;
    if (role === 'admin' || (role && roles.includes(role))) return next();
    next(new HttpError(403, 'Your role cannot do this'));
  };
