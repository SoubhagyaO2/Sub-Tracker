import type { CookieOptions, Response } from 'express';
import type { Config } from '../config.js';

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      const value = part.slice(idx + 1).trim();
      return value.length > 0 && value.length <= 512 ? value : undefined;
    }
  }
  return undefined;
}

function baseCookieOptions(config: Config): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/' };
}

export function setSessionCookie(res: Response, config: Config, token: string, expires: Date): void {
  res.cookie(config.session.cookieName, token, { ...baseCookieOptions(config), expires });
}

export function clearSessionCookie(res: Response, config: Config): void {
  res.clearCookie(config.session.cookieName, baseCookieOptions(config));
}
