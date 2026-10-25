import { compareDates, type DateOnly } from './dates.js';

export const STATUSES = ['active', 'trial', 'paused', 'cancelled', 'archived'] as const;
export type SubscriptionStatus = (typeof STATUSES)[number];

/** Statuses a subscription can be created in. Everything else is reached through a transition. */
export const CREATABLE_STATUSES = ['active', 'trial'] as const;

export const STATUS_ACTIONS = ['pause', 'resume', 'convert', 'cancel', 'archive', 'restore'] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];

/**
 * Allowed source statuses per action. "cancel" and "cancelled" mean the USER RECORDED a cancellation
 * they completed at the provider; SubCycle never acts on, or infers anything about, the external service.
 */
export const ACTION_FROM: Record<StatusAction, readonly SubscriptionStatus[]> = {
  pause: ['active'],
  resume: ['paused'],
  convert: ['trial'],
  cancel: ['active', 'trial', 'paused'],
  archive: ['active', 'trial', 'paused', 'cancelled'],
  restore: ['cancelled', 'archived'],
};

export const allowedActions = (status: SubscriptionStatus): StatusAction[] =>
  STATUS_ACTIONS.filter((a) => ACTION_FROM[a].includes(status));

export interface TransitionCurrent {
  status: SubscriptionStatus;
  statusBeforeArchive: Exclude<SubscriptionStatus, 'archived'> | null;
  anchorDate: DateOnly;
  nextBillingDate: DateOnly;
  startDate: DateOnly;
  cancelledOn: DateOnly | null;
}

export interface TransitionInput {
  action: StatusAction;
  nextBillingDate?: DateOnly;
  cancelledOn?: DateOnly;
}

export type TransitionResult = Pick<
  TransitionCurrent,
  'status' | 'statusBeforeArchive' | 'anchorDate' | 'nextBillingDate' | 'cancelledOn'
>;

export class TransitionError extends Error {
  constructor(
    public readonly kind: 'invalid_transition' | 'validation',
    message: string,
    public readonly path?: string,
  ) {
    super(message);
  }
}

const invalid = (m: string, path: string) => new TransitionError('validation', m, path);

/**
 * Computes the result of a status action. Pure: the caller supplies "today" (in the user's time zone).
 * Supplying nextBillingDate declares a new billing schedule, so it also becomes the new anchor date.
 */
export function applyTransition(cur: TransitionCurrent, input: TransitionInput, today: DateOnly): TransitionResult {
  const { action } = input;
  if (!ACTION_FROM[action].includes(cur.status)) {
    throw new TransitionError(
      'invalid_transition',
      `A ${cur.status} subscription can't be ${pastParticiple(action)}. ` +
        (allowedActions(cur.status).length
          ? `Allowed actions: ${allowedActions(cur.status).join(', ')}.`
          : 'No actions are available.'),
    );
  }

  if (input.cancelledOn !== undefined && action !== 'cancel') {
    throw invalid('cancelledOn only applies when recording a cancellation.', 'cancelledOn');
  }
  const nextAllowed = action === 'resume' || action === 'convert' || action === 'restore';
  if (input.nextBillingDate !== undefined && !nextAllowed) {
    throw invalid('nextBillingDate does not apply to this action.', 'nextBillingDate');
  }

  const keep = {
    anchorDate: cur.anchorDate,
    nextBillingDate: cur.nextBillingDate,
    cancelledOn: cur.cancelledOn,
    statusBeforeArchive: null as TransitionResult['statusBeforeArchive'],
  };

  /** Next billing date for a subscription that is about to (re)start billing. */
  const resolveNext = (required: boolean): Pick<TransitionResult, 'anchorDate' | 'nextBillingDate'> => {
    const provided = input.nextBillingDate;
    if (provided !== undefined) {
      if (compareDates(provided, today) < 0) throw invalid('Next billing date can’t be in the past.', 'nextBillingDate');
      if (compareDates(provided, cur.startDate) < 0) {
        throw invalid('Next billing date can’t be before the start date.', 'nextBillingDate');
      }
      return { anchorDate: provided, nextBillingDate: provided };
    }
    if (required) throw invalid('Provide the next billing date to restart this subscription.', 'nextBillingDate');
    if (compareDates(cur.nextBillingDate, today) < 0) {
      throw invalid('The stored billing date has passed. Provide the next billing date.', 'nextBillingDate');
    }
    return { anchorDate: cur.anchorDate, nextBillingDate: cur.nextBillingDate };
  };

  switch (action) {
    case 'pause':
      return { ...keep, status: 'paused' };

    case 'resume':
      return { ...keep, status: 'active', ...resolveNext(false) };

    case 'convert':
      return { ...keep, status: 'active', ...resolveNext(false) };

    case 'cancel': {
      const on = input.cancelledOn ?? today;
      if (compareDates(on, today) > 0) {
        throw invalid('Record the cancellation after you’ve completed it. The date can’t be in the future.', 'cancelledOn');
      }
      if (compareDates(on, cur.startDate) < 0) {
        throw invalid('Cancellation date can’t be before the start date.', 'cancelledOn');
      }
      return { ...keep, status: 'cancelled', cancelledOn: on };
    }

    case 'archive':
      return { ...keep, status: 'archived', statusBeforeArchive: cur.status as TransitionResult['statusBeforeArchive'] };

    case 'restore': {
      if (cur.status === 'cancelled') {
        // Re-subscribing: the user must confirm the new billing date.
        return { ...keep, status: 'active', cancelledOn: null, ...resolveNext(true) };
      }
      const target = cur.statusBeforeArchive;
      if (!target) throw new TransitionError('invalid_transition', 'This archived subscription has no status to restore.');
      if (target === 'cancelled' || target === 'paused') {
        if (input.nextBillingDate !== undefined) {
          throw invalid(`A restored ${target} subscription doesn’t take a new billing date.`, 'nextBillingDate');
        }
        return { ...keep, status: target };
      }
      return { ...keep, status: target, ...resolveNext(false) };
    }
  }
}

function pastParticiple(action: StatusAction): string {
  return { pause: 'paused', resume: 'resumed', convert: 'converted', cancel: 'cancelled', archive: 'archived', restore: 'restored' }[action];
}
