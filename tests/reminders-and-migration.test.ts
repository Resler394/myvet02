import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { dispatchApiRequest } from '../server/core/router.ts';
import type { HttpRequest } from '../server/core/http.ts';
import { processDueReminders } from '../server/jobs/reminderEngine.ts';
import { MemoryClinicStore } from '../server/store/memoryStore.ts';

function req(method: string, path: string, body?: any, headers: Record<string, string> = {}): HttpRequest {
  return {
    method,
    url: path,
    path,
    query: {},
    headers,
    body: body ?? {},
    ip: '127.0.0.1',
  };
}

describe('SMS Reminder Engine, Queue Controls & Non-Destructive LocalStorage Migration', () => {
  const originalEnv = { ...process.env };
  let store: MemoryClinicStore;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUTO_DEV_LOGIN;
    delete process.env.SMS_WEBHOOK_SECRET;
    store = new MemoryClinicStore();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('schedules J-7/3/1 reminders on vaccination creation and prevents duplicate dispatch on rerun', async () => {
    const vacRes = await dispatchApiRequest(
      req('POST', '/api/vaccinations', {
        animalId: 'rocky',
        vaccineName: 'CHPPi-L',
        administeredDate: '2026-08-01',
        nextDueDate: '2026-08-15',
        veterinarian: 'Dr. Martin',
      }),
      store
    );
    expect(vacRes.status).toBe(201);
    expect(vacRes.body.scheduledReminders).toBe(3);

    const queueRes = await dispatchApiRequest(req('GET', '/api/sms/reminders'), store);
    const rockyReminders = queueRes.body.filter((r: any) => r.vaccination_id === vacRes.body.id);
    expect(rockyReminders.length).toBe(3);

    // Run reminder processor after all 3 dates (within sending window 10:00 Algiers time = 09:00 UTC)
    const daytimeNow = new Date('2026-08-15T10:00:00+01:00');
    const firstRun = await processDueReminders(store, {
      clinicId: 'clinic-myvet-ouled-fayet',
      now: daytimeNow,
    });
    expect(firstRun.sent).toBeGreaterThanOrEqual(3);

    // Second run must NOT resend already sent reminders
    const secondRun = await processDueReminders(store, {
      clinicId: 'clinic-myvet-ouled-fayet',
      now: daytimeNow,
    });
    expect(secondRun.sent).toBe(0);
  });

  it('defers due reminders outside legal sending window (08h-20h Africa/Algiers) unless bypassWindow is set', async () => {
    // Schedule an immediate appointment reminder
    const aptRes = await dispatchApiRequest(
      req('POST', '/api/appointments', {
        patientId: 'felix',
        date: '2026-08-16',
        startTime: '11:00',
        endTime: '11:30',
        type: 'Consultation',
        reason: 'Contrôle',
        veterinarian: 'Dr. Martin',
      }),
      store
    );
    expect(aptRes.status).toBe(201);

    // Process at 02:30 AM Algiers time (outside 08:00-20:00 window)
    const nightTime = new Date('2026-08-15T23:30:00+01:00');
    const deferredRun = await processDueReminders(store, {
      clinicId: 'clinic-myvet-ouled-fayet',
      now: nightTime,
      bypassWindow: false,
    });
    expect(deferredRun.deferred).toBeGreaterThanOrEqual(1);
    expect(deferredRun.sent).toBe(0);
  });

  it('supports manual send-now, cancel, signed/unsigned webhook, and simulated test SMS endpoint', async () => {
    const vacRes = await dispatchApiRequest(
      req('POST', '/api/vaccinations', {
        animalId: 'maya',
        vaccineName: 'Antirabique',
        administeredDate: '2026-08-01',
        nextDueDate: '2026-09-20',
      }),
      store
    );
    expect(vacRes.status).toBe(201);

    const queue = await dispatchApiRequest(req('GET', '/api/sms/reminders'), store);
    const createdRems = queue.body.filter((r: any) => r.vaccination_id === vacRes.body.id);
    expect(createdRems.length).toBe(3);

    // Send first reminder immediately
    const sendNowRes = await dispatchApiRequest(
      req('POST', `/api/sms/send-now/${createdRems[0].id}`),
      store
    );
    expect(sendNowRes.status).toBe(200);
    expect(sendNowRes.body.success).toBe(true);
    expect(sendNowRes.body.isSimulated).toBe(true);
    expect(sendNowRes.body.status).toBe('Sent');

    // Simulate signed delivery webhook callback updating Sent -> Delivered
    process.env.SMS_WEBHOOK_SECRET = 'test-webhook-secret';
    const webhookBody = {
      providerMessageId: sendNowRes.body.log.provider_message_id,
      status: 'Delivered',
    };
    const sig = crypto
      .createHmac('sha256', process.env.SMS_WEBHOOK_SECRET)
      .update(JSON.stringify(webhookBody))
      .digest('hex');

    const unsignedRes = await dispatchApiRequest(
      req('POST', '/api/sms/webhook', webhookBody),
      store
    );
    expect(unsignedRes.status).toBe(401);

    const webhookRes = await dispatchApiRequest(
      req('POST', '/api/sms/webhook', webhookBody, { 'x-sms-signature': sig }),
      store
    );
    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.updated).toBe(true);

    // Cancel second reminder
    const cancelRes = await dispatchApiRequest(
      req('POST', `/api/sms/cancel/${createdRems[1].id}`),
      store
    );
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.cancelled).toBe(true);

    // Verify Test SMS endpoint normalizes Algerian phone and logs simulation
    const testSms = await dispatchApiRequest(
      req('POST', '/api/sms/test', {
        phone: '0555 99 88 77',
        recipientName: 'Client Test',
        message: 'Cabinet My Vet: Test SMS DZD',
      }),
      store
    );
    expect(testSms.status).toBe(200);
    expect(testSms.body.phone.e164).toBe('+213555998877');
    expect(testSms.body.isSimulated).toBe(true);
  });

  it('previews localStorage migration with dryRun and stays idempotent on repeated real imports', async () => {
    const legacyPayload = {
      dryRun: true,
      clients: [
        { id: 'leg-c1', name: 'Nabil Bencherif', phone: '0550 77 66 55', email: 'nabil@dz.com', address: 'Alger' },
      ],
      patients: [
        { id: 'leg-p1', name: 'Rex', species: 'Chien', breed: 'Malinois', gender: 'Mâle', ownerId: 'leg-c1' },
      ],
      invoices: [
        { id: 'leg-i1', number: 'FAC-LEG-01', clientName: 'Nabil Bencherif', patientName: 'Rex', date: '2026-08-01', amount: 4000, status: 'Payée', paymentMethod: 'Espèces' },
      ],
    };

    const dryRunRes = await dispatchApiRequest(req('POST', '/api/system/migrate', legacyPayload), store);
    expect(dryRunRes.status).toBe(200);
    expect(dryRunRes.body.dryRun).toBe(true);
    expect(dryRunRes.body.summary.importedOwners).toBe(1);
    expect(dryRunRes.body.summary.importedInvoices).toBe(1);

    // Dry run must NOT have written the client
    const ownersBefore = await dispatchApiRequest(req('GET', '/api/owners'), store);
    expect(ownersBefore.body.some((o: any) => o.name === 'Nabil Bencherif')).toBe(false);

    // Real import
    const importRes = await dispatchApiRequest(
      req('POST', '/api/system/migrate', { ...legacyPayload, dryRun: false }),
      store
    );
    expect(importRes.status).toBe(200);
    expect(importRes.body.alreadyImported).toBe(false);
    expect(importRes.body.summary.importedOwners).toBe(1);
    expect(importRes.body.summary.importedAnimals).toBe(1);
    expect(importRes.body.summary.importedInvoices).toBe(1);

    const ownersAfter = await dispatchApiRequest(req('GET', '/api/owners'), store);
    expect(ownersAfter.body.some((o: any) => o.name === 'Nabil Bencherif')).toBe(true);

    // Second identical import is safely deduplicated
    const replayRes = await dispatchApiRequest(
      req('POST', '/api/system/migrate', { ...legacyPayload, dryRun: false }),
      store
    );
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.alreadyImported).toBe(true);
  });
});
