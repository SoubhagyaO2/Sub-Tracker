import { Router } from 'express';
import { linkPreviewSchema } from '@subcycle/shared';
import type { AppDeps } from '../deps.js';
import { validation } from '../errors.js';
import { linkPreviewLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/session.js';
import { LinkRejected, previewLink, type PreviewDeps } from '../services/linkPreview.js';

/**
 * POST /api/link-preview { url } -> a suggested name / website / (for known services) category and icon.
 * Needs a session, is rate limited per user, never stores or logs the address, and never reports WHY an address was refused
 * (so it cannot be used to probe what is inside the network).
 */
export function linkPreviewRouter(deps: AppDeps & { linkPreview?: PreviewDeps }): Router {
  const router = Router();
  router.use(requireAuth);
  router.post('/', linkPreviewLimiter(deps.config.rateLimit.apiWindowMs, deps.config.rateLimit.linkPreviewMax), async (req, res) => {
    const { url } = linkPreviewSchema.parse(req.body ?? {});
    try {
      res.json({ data: await previewLink(url, deps.linkPreview) });
    } catch (err) {
      if (err instanceof LinkRejected) throw validation([{ path: 'url', message: 'Enter the web address of a public website, such as https://example.com.' }]);
      throw err;
    }
  });
  return router;
}
