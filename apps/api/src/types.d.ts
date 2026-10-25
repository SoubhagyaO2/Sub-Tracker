import type { AuthContext } from './auth/sessions.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}
