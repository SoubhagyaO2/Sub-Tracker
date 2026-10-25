import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { FakeClock } from '../src/clock.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };
const prod = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com', APP_URL: 'https://app.example.com' };

describe('loadConfig', () => {
  it('defaults: dev cookie name, 14d idle / 30d absolute sessions, email disabled', () => {
    const c = loadConfig(base);
    expect(c.session).toMatchObject({ cookieName: 'sc_sid', idleMs: 14 * 86_400_000, absoluteMs: 30 * 86_400_000 });
    expect(c.smtp).toBeNull();
    expect(c.isProd).toBe(false);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('production requires explicit CORS origins and an https APP_URL', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', APP_URL: 'https://x.example' })).toThrow(/CORS_ORIGINS/);
    expect(() => loadConfig({ ...prod, APP_URL: 'http://app.example.com' })).toThrow(/https/);
    expect(loadConfig(prod).session.cookieName).toBe('__Host-sc_sid');
  });

  it('rejects wildcard and malformed CORS origins', () => {
    expect(() => loadConfig({ ...base, CORS_ORIGINS: '*' })).toThrow(/Invalid CORS origin/);
    expect(() => loadConfig({ ...base, CORS_ORIGINS: 'https://a.example/path' })).toThrow(/Invalid CORS origin/);
    expect(loadConfig({ ...base, CORS_ORIGINS: 'https://a.example, http://localhost:5173' }).corsOrigins).toEqual([
      'https://a.example',
      'http://localhost:5173',
    ]);
  });

  it('enables SMTP only when host, port and from are all set; partial config is an error, not silent', () => {
    expect(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.com' })).toThrow(/partially configured/);
    const c = loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_FROM: 'SubCycle <a@example.com>' });
    expect(c.smtp).toMatchObject({ host: 'smtp.example.com', port: 587, secure: false });
    // Empty strings (common in .env files) count as unset.
    expect(loadConfig({ ...base, SMTP_HOST: '', SMTP_PORT: '', SMTP_FROM: '' }).smtp).toBeNull();
  });

  it('parses TRUST_PROXY', () => {
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });
});

describe('FakeClock', () => {
  it('is fully controlled and returns copies', () => {
    const c = new FakeClock('2030-01-01T00:00:00Z');
    const a = c.now();
    a.setFullYear(1999);
    expect(c.now().toISOString()).toBe('2030-01-01T00:00:00.000Z');
    c.advance(1500);
    expect(c.now().toISOString()).toBe('2030-01-01T00:00:01.500Z');
    c.set('2031-06-01T12:00:00Z');
    expect(c.now().toISOString()).toBe('2031-06-01T12:00:00.000Z');
  });
});
