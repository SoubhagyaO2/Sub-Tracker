import { Router } from 'express';
import {
  createPaymentSchema,
  createSubscriptionSchema,
  listPaymentsQuerySchema,
  listPriceHistoryQuerySchema,
  listSubscriptionsQuerySchema,
  upcomingQuerySchema,
  statusActionSchema,
  updateSubscriptionSchema,
  DEFAULT_PAGE_SIZE,
  type CurrencyCode,
} from '@subcycle/shared';
import { loadPreferences } from '../auth/dto.js';
import type { AppDeps } from '../deps.js';
import { requireAuth } from '../middleware/session.js';
import { createPayment, deletePayment, listPayments, listPriceHistory } from '../services/payments.js';
import { getUpcoming } from '../services/recurrence.js';
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  transitionSubscription,
  updateSubscription,
} from '../services/subscriptions.js';
import { todayInZone } from '../today.js';

/**
 * All routes require a session. The owner is ALWAYS req.auth.userId (from the session cookie);
 * no request field can name a user, and every service call is scoped by it.
 */
export function subscriptionsRouter(deps: AppDeps): Router {
  const { pool, clock } = deps;
  const router = Router();
  router.use(requireAuth);

  async function context(userId: string) {
    const prefs = await loadPreferences(pool, userId);
    return { today: todayInZone(clock, prefs.timezone), defaultCurrency: prefs.currency as CurrencyCode };
  }

  router.get('/', async (req, res) => {
    const query = listSubscriptionsQuerySchema.parse(req.query);
    const { today } = await context(req.auth!.userId);
    const result = await listSubscriptions(pool, req.auth!.userId, query, today);
    res.json({ data: result.items, meta: { page: result.page, pageSize: result.pageSize, total: result.total } });
  });

  router.post('/', async (req, res) => {
    const input = createSubscriptionSchema.parse(req.body ?? {});
    const created = await createSubscription(pool, req.auth!.userId, input, await context(req.auth!.userId));
    res.status(201).json({ data: created });
  });

  router.get('/:id', async (req, res) => {
    const { today } = await context(req.auth!.userId);
    res.json({ data: await getSubscription(pool, req.auth!.userId, req.params.id, today) });
  });

  router.patch('/:id', async (req, res) => {
    const patch = updateSubscriptionSchema.parse(req.body ?? {});
    const updated = await updateSubscription(pool, req.auth!.userId, req.params.id, patch, await context(req.auth!.userId));
    res.json({ data: updated });
  });

  router.post('/:id/status', async (req, res) => {
    const input = statusActionSchema.parse(req.body ?? {});
    const { today } = await context(req.auth!.userId);
    res.json({ data: await transitionSubscription(pool, req.auth!.userId, req.params.id, input, today) });
  });

  // ───────────── payments (user-entered records) ─────────────

  router.get('/:id/payments', async (req, res) => {
    const q = listPaymentsQuerySchema.parse(req.query);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? DEFAULT_PAGE_SIZE;
    const { items, total } = await listPayments(pool, req.auth!.userId, req.params.id, { page, pageSize });
    res.json({ data: items, meta: { page, pageSize, total } });
  });

  router.post('/:id/payments', async (req, res) => {
    const input = createPaymentSchema.parse(req.body ?? {});
    const { today } = await context(req.auth!.userId);
    res.status(201).json({ data: await createPayment(pool, req.auth!.userId, req.params.id, input, today) });
  });

  router.delete('/:id/payments/:paymentId', async (req, res) => {
    await deletePayment(pool, req.auth!.userId, req.params.id, req.params.paymentId);
    res.status(204).end();
  });

  // ───────────── price history, projections ─────────────

  router.get('/:id/price-history', async (req, res) => {
    const q = listPriceHistoryQuerySchema.parse(req.query);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? DEFAULT_PAGE_SIZE;
    const { items, total } = await listPriceHistory(pool, req.auth!.userId, req.params.id, { page, pageSize });
    res.json({ data: items, meta: { page, pageSize, total } });
  });

  /** Read-only projection of upcoming billing dates at the current price. Writes nothing. */
  router.get('/:id/upcoming', async (req, res) => {
    const q = upcomingQuerySchema.parse(req.query);
    const { today } = await context(req.auth!.userId);
    const data = await getUpcoming(pool, req.auth!.userId, req.params.id, q.count ?? 6, today);
    res.json({ data, meta: { kind: 'projection', note: 'Projected from the current price and schedule. Not a record of charges.' } });
  });

  router.delete('/:id', async (req, res) => {
    await deleteSubscription(pool, req.auth!.userId, req.params.id);
    res.status(204).end();
  });

  return router;
}
