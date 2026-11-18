import { getServerEnv } from '../../config/env.ts';
import type { SmsConfig } from '../../../shared/types/domain.ts';
import type { SMSProvider } from './types.ts';
import { TestSMSProvider } from './TestSMSProvider.ts';
import { GenericHttpSmsAdapter } from './GenericHttpSmsAdapter.ts';

export * from './types.ts';
export { TestSMSProvider } from './TestSMSProvider.ts';
export { GenericHttpSmsAdapter } from './GenericHttpSmsAdapter.ts';

export function resolveSmsProvider(config?: Partial<SmsConfig> | null): SMSProvider {
  const env = getServerEnv();
  const mode = config?.provider_mode || env.smsProviderMode;

  if (mode === 'PRODUCTION') {
    if (!env.smsApiUrl || !env.smsApiKey) {
      return new GenericHttpSmsAdapter({
        apiUrl: '',
        apiKey: '',
        senderId: env.smsSenderId,
        webhookSecret: env.smsWebhookSecret,
        providerLabel: config?.active_provider || 'ProductionGatewayUnconfigured',
      });
    }
    return new GenericHttpSmsAdapter({
      apiUrl: env.smsApiUrl,
      apiKey: env.smsApiKey,
      senderId: env.smsSenderId,
      webhookSecret: env.smsWebhookSecret,
      providerLabel: config?.active_provider || 'GenericHttpSmsAdapter',
    });
  }

  return new TestSMSProvider();
}

export function renderSmsTemplate(
  templateContent: string,
  variables: Record<string, string | number | undefined>
): string {
  return templateContent.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = variables[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

/**
 * Returns local hour (0..23) and YYYY-MM-DD in the given IANA timezone (default Africa/Algiers).
 */
export function getLocalTimeParts(date: Date, timeZone = 'Africa/Algiers'): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dateStr: string;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'), 10);
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  return { year, month, day, hour, minute, dateStr };
}

export function isWithinSendingWindow(
  date: Date,
  startHour = 8,
  endHour = 20,
  timeZone = 'Africa/Algiers'
): boolean {
  const { hour } = getLocalTimeParts(date, timeZone);
  return hour >= startHour && hour < endHour;
}

/**
 * Adjusts a candidate timestamp so it falls within [startHour, endHour) in Africa/Algiers.
 * Because Algeria (Africa/Algiers) is permanently UTC+1 (no DST), we compute exact UTC shifts safely.
 */
export function clampToSendingWindow(
  candidate: Date,
  startHour = 8,
  endHour = 20,
  timeZone = 'Africa/Algiers'
): Date {
  const local = getLocalTimeParts(candidate, timeZone);
  if (local.hour >= startHour && local.hour < endHour) {
    return candidate;
  }

  const shifted = new Date(candidate.getTime());
  if (local.hour < startHour) {
    // Move forward to startHour:00 today
    const deltaHours = startHour - local.hour;
    shifted.setTime(shifted.getTime() + deltaHours * 3600_000 - local.minute * 60_000);
    return shifted;
  }

  // local.hour >= endHour -> move to startHour:00 tomorrow
  const hoursUntilMidnight = 24 - local.hour;
  shifted.setTime(shifted.getTime() + (hoursUntilMidnight + startHour) * 3600_000 - local.minute * 60_000);
  return shifted;
}
