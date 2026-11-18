import crypto from 'node:crypto';
import type { SMSProvider, SmsSendRequest, SmsSendResult, SmsWebhookEvent } from './types.ts';

export interface GenericHttpSmsConfig {
  apiUrl: string;
  apiKey: string;
  senderId: string;
  webhookSecret?: string;
  providerLabel?: string;
  timeoutMs?: number;
}

/**
 * Provider-Independent HTTP SMS Gateway Adapter for Production Mode.
 * Compatible with Algerian B2B SMS aggregators & HTTP REST SMS APIs via server-only credentials.
 */
export class GenericHttpSmsAdapter implements SMSProvider {
  readonly providerName: string;
  readonly isSimulated = false;
  private readonly config: GenericHttpSmsConfig;

  constructor(config: GenericHttpSmsConfig) {
    this.config = config;
    this.providerName = config.providerLabel || 'GenericHttpSmsAdapter';
  }

  async sendSms(request: SmsSendRequest): Promise<SmsSendResult> {
    if (!this.config.apiUrl || !this.config.apiKey) {
      return {
        success: false,
        isSimulated: false,
        providerName: this.providerName,
        providerMessageId: null,
        status: 'Failed',
        failureType: 'PERMANENT',
        errorMessage:
          'Configuration SMS_API_URL / SMS_API_KEY manquante pour le mode PRODUCTION.',
        rawResponse: { error: 'MISSING_PRODUCTION_CREDENTIALS' },
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 8000);

    try {
      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          'X-API-Key': this.config.apiKey,
        },
        body: JSON.stringify({
          to: request.toE164,
          from: request.senderId || this.config.senderId,
          message: request.message,
          category: request.category,
          metadata: request.metadata || {},
        }),
        signal: controller.signal,
      });

      const bodyText = await response.text();
      let parsed: Record<string, unknown> = { raw: bodyText };
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // non-json response kept as raw
      }

      if (!response.ok) {
        const isRetryable = response.status >= 500 || response.status === 429 || response.status === 408;
        return {
          success: false,
          isSimulated: false,
          providerName: this.providerName,
          providerMessageId: null,
          status: 'Failed',
          failureType: isRetryable ? 'RETRYABLE_TEMPORARY' : 'PERMANENT',
          isAmbiguous: response.status >= 500,
          errorMessage: `HTTP ${response.status} from SMS gateway`,
          rawResponse: parsed,
        };
      }

      const providerMessageId =
        String(parsed.messageId || parsed.id || parsed.providerMessageId || '') ||
        `HTTP-${Date.now()}`;

      return {
        success: true,
        isSimulated: false,
        providerName: this.providerName,
        providerMessageId,
        status: 'Accepted',
        rawResponse: parsed,
      };
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError';
      return {
        success: false,
        isSimulated: false,
        providerName: this.providerName,
        providerMessageId: null,
        status: 'Failed',
        failureType: 'RETRYABLE_TEMPORARY',
        isAmbiguous: isAbort,
        errorMessage: isAbort ? 'Timeout de la passerelle SMS' : err?.message || 'Erreur réseau passerelle SMS',
        rawResponse: { error: err?.message || 'Network failure', ambiguous: isAbort },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!this.config.webhookSecret) return false;
    if (!signatureHeader) return false;
    const expected = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  parseDeliveryWebhook(payload: Record<string, unknown>): SmsWebhookEvent | null {
    const providerMessageId = String(payload.providerMessageId || payload.messageId || payload.id || '').trim();
    if (!providerMessageId) return null;
    const rawStatus = String(payload.status || 'Unknown');
    const allowed = ['Accepted', 'Sent', 'Delivered', 'Failed', 'Unknown'] as const;
    const status = (allowed.includes(rawStatus as any) ? rawStatus : 'Unknown') as SmsWebhookEvent['status'];
    return {
      providerMessageId,
      status,
      errorDetail: payload.errorDetail ? String(payload.errorDetail) : undefined,
      rawPayload: payload,
    };
  }
}
