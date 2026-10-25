import type { BillingFrequency, Category, PaymentStatus, StatusAction, SubscriptionStatus, UsageLevel } from '@subcycle/shared';

export const CATEGORY_LABEL: Record<Category, string> = {
  entertainment: 'Entertainment', music: 'Music', video: 'Video', gaming: 'Gaming', productivity: 'Productivity',
  cloud_storage: 'Cloud storage', ai_tools: 'AI tools', news_reading: 'News & reading', fitness_health: 'Fitness & health',
  education: 'Education', shopping: 'Shopping', utilities: 'Utilities', finance: 'Finance', other: 'Other',
};

/** Stable category -> chart colour slot, so colours never reshuffle between renders. */
export const CATEGORY_SLOT: Record<Category, number> = {
  entertainment: 1, music: 2, video: 3, gaming: 4, productivity: 5, cloud_storage: 6, ai_tools: 1,
  news_reading: 2, fitness_health: 3, education: 4, shopping: 5, utilities: 6, finance: 2, other: 7,
};

export const FREQUENCY_LABEL: Record<BillingFrequency, string> = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
export const FREQUENCY_UNIT: Record<BillingFrequency, string> = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  active: 'Active', trial: 'Trial', paused: 'Paused', cancelled: 'Cancelled', archived: 'Archived',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = { paid: 'Paid', failed: 'Failed', refunded: 'Refunded' };
export const USAGE_LABEL: Record<UsageLevel, string> = { often: 'Often', sometimes: 'Sometimes', rarely: 'Rarely' };

export const ACTION_LABEL: Record<StatusAction, string> = {
  pause: 'Pause', resume: 'Resume', convert: 'Convert trial', cancel: 'Record cancellation', archive: 'Archive', restore: 'Restore',
};
