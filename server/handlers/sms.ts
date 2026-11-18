import {
  smsConfigUpdateSchema,
  smsTemplateSchema,
  smsTestSchema,
  smsWebhookSchema,
} from '../../shared/schemas/index.ts';
import { normalizeAlgerianPhone } from '../../shared/utils/phone.ts';
import { analyzeSMSContent } from '../../shared/utils/smsSegmentation.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  GenericHttpSmsAdapter,
  renderSmsTemplate,
  resolveSmsProvider,
} from '../services/sms/index.ts';
import { getServerEnv } from '../config/env.ts';
import type { ClinicStore } from '../store/index.ts';
import {
  type ApiJsonResponse,
  type HttpRequest,
  jsonError,
  jsonOk,
  parseBody,
} from '../core/http.ts';

export async function handleSmsRoute(
  req: HttpRequest,
  subPath: string,
  store: ClinicStore
): Promise<ApiJsonResponse | null> {
  const cookieHeader = req.headers.cookie as string | undefined;

  if ((subPath === '/sms/reminders' || subPath === '/sms/queue') && req.method === 'GET') {
    const auth = await requireAuth(cookieHeader, store);
    return jsonOk(await store.listSmsReminders(auth.clinicId));
  }

  if ((subPath === '/sms/history' || subPath === '/sms/logs') && req.method === 'GET') {
    const auth = await requireAuth(cookieHeader, store);
    return jsonOk(await store.listSmsLogs(auth.clinicId));
  }

  if (subPath === '/sms/config' && req.method === 'GET') {
    const auth = await requireAuth(cookieHeader, store);
    return jsonOk(await store.getSmsConfig(auth.clinicId));
  }

  if (subPath === '/sms/config' && (req.method === 'PUT' || req.method === 'PATCH')) {
    const auth = await requireAuth(cookieHeader, store, ['super_admin', 'clinic_admin']);
    const updates = parseBody(smsConfigUpdateSchema, req.body);
    if (
      updates.sending_start_hour !== undefined &&
      updates.sending_end_hour !== undefined &&
      updates.sending_end_hour <= updates.sending_start_hour
    ) {
      return jsonError(400, "L'heure de fin d'envoi doit être postérieure à l'heure de début.");
    }
    const updated = await store.updateSmsConfig(auth.clinicId, updates);
    await store.writeAuditLog(auth.clinicId, {
      userId: auth.userId,
      userName: auth.userName,
      action: 'UPDATE_SMS_CONFIG',
      entityType: 'sms_config',
      entityId: auth.clinicId,
      details: updates,
    });
    return jsonOk(updated);
  }

  if (subPath === '/sms/templates' && req.method === 'GET') {
    const auth = await requireAuth(cookieHeader, store);
    return jsonOk(await store.listSmsTemplates(auth.clinicId));
  }

  if (subPath === '/sms/templates' && req.method === 'POST') {
    const auth = await requireAuth(cookieHeader, store, ['super_admin', 'clinic_admin', 'veterinarian']);
    const input = parseBody(smsTemplateSchema, req.body);
    return jsonOk(await store.upsertSmsTemplate(auth.clinicId, input), 201);
  }

  const tplIdMatch = /^\/sms\/templates\/([^/]+)$/.exec(subPath);
  if (tplIdMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    const auth = await requireAuth(cookieHeader, store, ['super_admin', 'clinic_admin', 'veterinarian']);
    const input = parseBody(smsTemplateSchema, { ...req.body, id: decodeURIComponent(tplIdMatch[1]) });
    return jsonOk(await store.upsertSmsTemplate(auth.clinicId, input));
  }

  if (subPath === '/sms/test' && req.method === 'POST') {
    const auth = await requireAuth(cookieHeader, store, [
      'super_admin',
      'clinic_admin',
      'veterinarian',
      'receptionist',
    ]);
    const input = parseBody(smsTestSchema, req.body);
    const phoneInfo = normalizeAlgerianPhone(input.phone);
    if (!phoneInfo.isValid) {
      return jsonError(400, phoneInfo.error || 'Numéro algérien invalide');
    }

    const config = await store.getSmsConfig(auth.clinicId);
    const provider = resolveSmsProvider(config);
    const seg = analyzeSMSContent(input.message);

    const dispatch = await provider.sendSms({
      toE164: phoneInfo.e164,
      senderId: 'MyVet',
      message: input.message,
      recipientName: input.recipientName,
      category: input.category,
    });

    const log = await store.createSmsLog(auth.clinicId, {
      reminder_id: null,
      recipient_name: input.recipientName,
      recipient_phone: phoneInfo.e164,
      animal_name: input.animalName,
      category: input.category,
      message_content: input.message,
      encoding: seg.encoding,
      segment_count: seg.segmentCount,
      status: dispatch.status,
      is_simulated: dispatch.isSimulated,
      provider_name: dispatch.providerName,
      provider_message_id: dispatch.providerMessageId,
      provider_response: JSON.stringify(dispatch.rawResponse),
    });

    return jsonOk({
      success: dispatch.success,
      isSimulated: dispatch.isSimulated,
      status: dispatch.status,
      providerMessageId: dispatch.providerMessageId,
      phone: phoneInfo,
      segmentation: seg,
      log,
    });
  }

  const retryMatch = /^\/sms\/retry\/([^/]+)$/.exec(subPath);
  if (retryMatch && req.method === 'POST') {
    const auth = await requireAuth(cookieHeader, store, ['super_admin', 'clinic_admin', 'veterinarian']);
    const id = decodeURIComponent(retryMatch[1]);
    const rem = await store.getSmsReminderById(auth.clinicId, id);
    if (!rem) return jsonError(404, 'Rappel SMS introuvable');
    if (rem.status !== 'Failed' && rem.status !== 'Scheduled' && rem.status !== 'Unknown') {
      return jsonError(400, `Impossible de relancer un rappel au statut "${rem.status}".`);
    }
    await store.updateReminderDispatchState(id, {
      status: 'Scheduled',
      scheduledAt: new Date().toISOString(),
      lockedAt: null,
      leaseExpiresAt: null,
      workerId: null,
      lastError: null,
    });
    return jsonOk({ retried: true, reminderId: id });
  }

  const sendNowMatch = /^\/sms\/send-now\/([^/]+)$/.exec(subPath);
  if (sendNowMatch && req.method === 'POST') {
    const auth = await requireAuth(cookieHeader, store, ['super_admin', 'clinic_admin', 'veterinarian', 'receptionist']);
    const id = decodeURIComponent(sendNowMatch[1]);
    const rem = await store.getSmsReminderById(auth.clinicId, id);
    if (!rem) return jsonError(404, 'Rappel SMS introuvable');

    const phoneInfo = normalizeAlgerianPhone(rem.owner_phone || rem.phone_normalized || '');
    if (!phoneInfo.isValid) {
      return jsonError(400, phoneInfo.error || 'Numéro algérien invalide pour ce rappel');
    }

    const config = await store.getSmsConfig(auth.clinicId);
    const provider = resolveSmsProvider(config);
    const customMsg = typeof req.body?.message === 'string' && req.body.message.trim().length >= 3
      ? req.body.message.trim()
      : `Cabinet My Vet: Rappel pour ${rem.animal_name || 'votre animal'} (${rem.reminder_type}). Contact: 0797 63 87 04. Ouled Fayet.`;
    const seg = analyzeSMSContent(customMsg);

    const dispatch = await provider.sendSms({
      toE164: phoneInfo.e164,
      senderId: 'MyVet',
      message: customMsg,
      recipientName: rem.owner_name || 'Propriétaire',
      category: rem.reminder_type,
    });

    await store.updateReminderDispatchState(id, {
      status: dispatch.status,
      attempts: (rem.attempts || 0) + 1,
      lockedAt: null,
      leaseExpiresAt: null,
      workerId: null,
      providerId: dispatch.providerName,
      providerMessageId: dispatch.providerMessageId,
      isSimulated: dispatch.isSimulated,
      lastError: dispatch.success ? null : dispatch.errorMessage || 'Échec envoi manuel',
      sentAt: dispatch.success ? new Date().toISOString() : null,
      deliveredAt: dispatch.status === 'Delivered' ? new Date().toISOString() : null,
    });

    const log = await store.createSmsLog(auth.clinicId, {
      reminder_id: id,
      recipient_name: rem.owner_name || 'Propriétaire',
      recipient_phone: phoneInfo.e164,
      animal_name: rem.animal_name || null,
      category: rem.reminder_type,
      message_content: customMsg,
      encoding: seg.encoding,
      segment_count: seg.segmentCount,
      status: dispatch.status,
      is_simulated: dispatch.isSimulated,
      provider_name: dispatch.providerName,
      provider_message_id: dispatch.providerMessageId,
      provider_response: JSON.stringify(dispatch.rawResponse),
    });

    return jsonOk({
      success: dispatch.success,
      isSimulated: dispatch.isSimulated,
      status: dispatch.status,
      log,
    });
  }

  const cancelMatch = /^\/sms\/cancel\/([^/]+)$/.exec(subPath);
  if (cancelMatch && req.method === 'POST') {
    const auth = await requireAuth(cookieHeader, store, ['super_admin', 'clinic_admin', 'veterinarian']);
    const id = decodeURIComponent(cancelMatch[1]);
    const rem = await store.getSmsReminderById(auth.clinicId, id);
    if (!rem) return jsonError(404, 'Rappel SMS introuvable');
    await store.updateReminderDispatchState(id, {
      status: 'Cancelled',
      lockedAt: null,
      leaseExpiresAt: null,
      workerId: null,
    });
    return jsonOk({ cancelled: true, reminderId: id });
  }

  if (subPath === '/sms/webhook' && req.method === 'POST') {
    const env = getServerEnv();
    if (env.smsWebhookSecret) {
      const sig = String(req.headers['x-sms-signature'] || req.headers['x-webhook-signature'] || '');
      const adapter = new GenericHttpSmsAdapter({
        apiUrl: env.smsApiUrl || '',
        apiKey: env.smsApiKey || '',
        senderId: env.smsSenderId,
        webhookSecret: env.smsWebhookSecret,
      });
      const raw = req.rawBody || JSON.stringify(req.body || {});
      if (!adapter.verifyWebhookSignature(raw, sig)) {
        return jsonError(401, 'Signature webhook SMS invalide');
      }
    }

    const evt = parseBody(smsWebhookSchema, req.body);
    const updated = await store.updateSmsStatusByProviderMessageId(
      evt.providerMessageId,
      evt.status,
      evt.errorDetail,
      evt.rawPayload
    );
    return jsonOk({ acknowledged: true, updated });
  }

  if (subPath === '/sms/calculate-segments' && req.method === 'POST') {
    const text = String(req.body?.message || req.body?.text || '');
    return jsonOk(analyzeSMSContent(text));
  }

  if (subPath === '/sms/preview' && req.method === 'POST') {
    const template = String(req.body?.template || '');
    const variables = (req.body?.variables || {}) as Record<string, string>;
    const rendered = renderSmsTemplate(template, variables);
    return jsonOk({
      rendered,
      segmentation: analyzeSMSContent(rendered),
    });
  }

  return null;
}
