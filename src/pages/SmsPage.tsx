import React, { useState, useEffect, useCallback } from 'react';
import {
  MessageSquare,
  Clock,
  History,
  FileText,
  Settings,
  Send,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Plus,
  ShieldCheck,
  Smartphone,
  Calendar,
  X,
  Sparkles,
  Info,
  CheckCheck,
  XCircle,
  RotateCcw,
} from 'lucide-react';
import { calculateClientSmsSegments } from '../utils/smsCalc';
import { formatAlgerianPhone } from '../utils/phoneUtils';
import { Modal } from '../components/common/Modal';
import { api, ApiError } from '../services/apiClient';
import { useClinicData } from '../context/DataContext';
import { useLanguage } from '../context/LanguageContext';
import { formatLocalizedDate } from '../i18n';
import type { SmsConfig, SmsLog, SmsReminder, SmsTemplate } from '../types';

type TabType = 'overview' | 'scheduled' | 'history' | 'templates' | 'settings';

function safeParseJson(raw?: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export const SmsPage: React.FC = () => {
  const { clients } = useClinicData();
  const { language, locale, t } = useLanguage();
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Configuration
  const [config, setConfig] = useState<SmsConfig>({
    id: 'default',
    provider_mode: 'TEST',
    active_provider: 'Ooredoo_Business_Algeria',
    api_key_configured: false,
    enable_vaccination_reminders: true,
    vaccination_intervals: '7,3,1',
    enable_appointment_reminders: true,
    appointment_interval_hours: 24,
    sending_start_hour: 8,
    sending_end_hour: 20,
    timezone: 'Africa/Algiers',
  });

  // Scheduled Queue
  const [reminders, setReminders] = useState<SmsReminder[]>([]);
  const [reminderFilter, setReminderFilter] = useState<'ALL' | 'Scheduled' | 'Sent' | 'Failed'>('ALL');

  // Real Logs from Backend
  const [logs, setLogs] = useState<SmsLog[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [logStatusFilter, setLogStatusFilter] = useState<'ALL' | 'Delivered' | 'Sent' | 'Failed'>('ALL');
  const [selectedLogPayload, setSelectedLogPayload] = useState<SmsLog | null>(null);

  // Templates
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<SmsTemplate | null>(null);
  const [templateContent, setTemplateContent] = useState('');
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateCategory, setTemplateCategory] = useState<'VACCINATION' | 'APPOINTMENT' | 'POST_OP' | 'URGENCE'>('VACCINATION');

  // Manual Compose Modal
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualRecipient, setManualRecipient] = useState('0555555555');
  const [manualName, setManualName] = useState('Fatima Fatima');
  const [manualAnimal, setManualAnimal] = useState('Nina');
  const [manualMessage, setManualMessage] = useState(
    "Cabinet My Vet: Rappel pour la visite de Nina au cabinet d'Ouled Fayet. Tel: 0797 63 87 04."
  );
  const [isSendingManual, setIsSendingManual] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const [cfgData, queueData, logsData, tplData] = await Promise.all([
        api.get<SmsConfig>('/api/sms/config'),
        api.get<SmsReminder[]>('/api/sms/reminders'),
        api.get<SmsLog[]>('/api/sms/history'),
        api.get<SmsTemplate[]>('/api/sms/templates'),
      ]);

      if (cfgData && cfgData.active_provider) {
        setConfig(cfgData);
      }
      if (Array.isArray(queueData)) {
        setReminders(queueData);
      }
      if (Array.isArray(logsData)) {
        setLogs(logsData);
      }
      if (Array.isArray(tplData) && tplData.length > 0) {
        setTemplates(tplData);
        setSelectedTemplate((prev) => {
          if (prev) {
            const match = tplData.find((t) => t.id === prev.id);
            if (match) return match;
          }
          setTemplateTitle(tplData[0].title);
          setTemplateContent(tplData[0].content);
          setTemplateCategory(tplData[0].category);
          return tplData[0];
        });
      }
    } catch (err: any) {
      setErrorMessage(err instanceof ApiError ? err.message : t.sms.loadError);
    } finally {
      setLoading(false);
    }
  }, [t.sms.loadError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Trigger Cron reminder processor
  const handleTriggerScheduler = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await api.post<{ results?: { sent?: number; claimed?: number; deferred?: number; failed?: number } }>(
        '/api/cron/process-reminders',
        { bypassWindow: true }
      );
      setStatusMessage(
        `${t.sms.schedulerResultPrefix} ${data.results?.sent || 0} ${t.sms.schedulerSentWord}, ${data.results?.deferred || 0} ${t.sms.schedulerDeferredWord}, ${data.results?.failed || 0} ${t.sms.schedulerFailedWord}.`
      );
      await fetchData();
      setTimeout(() => setStatusMessage(null), 5000);
    } catch (err: any) {
      setErrorMessage(err instanceof ApiError ? err.message : t.sms.schedulerError);
    } finally {
      setLoading(false);
    }
  };

  // Real instant dispatch of a scheduled reminder
  const handleSendReminderNow = async (reminder: SmsReminder) => {
    setErrorMessage(null);
    try {
      const res = await api.post<{ isSimulated?: boolean }>(`/api/sms/send-now/${encodeURIComponent(reminder.id)}`);
      setStatusMessage(
        res.isSimulated
          ? `${t.sms.reminderSentSimPrefix} ${reminder.owner_name} ${t.sms.reminderSentSimSuffix}`
          : `${t.sms.reminderSentProdPrefix} ${reminder.owner_name}.`
      );
      await fetchData();
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: any) {
      setErrorMessage(err instanceof ApiError ? err.message : t.sms.reminderSendError);
    }
  };

  // Real cancellation of a scheduled reminder
  const handleCancelReminder = async (id: string) => {
    setErrorMessage(null);
    try {
      await api.post(`/api/sms/cancel/${encodeURIComponent(id)}`);
      setStatusMessage(t.sms.reminderCancelledNotice);
      await fetchData();
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: any) {
      setErrorMessage(err instanceof ApiError ? err.message : t.sms.reminderCancelError);
    }
  };

  // Retry failed reminder
  const handleRetryReminder = async (id: string) => {
    setErrorMessage(null);
    try {
      await api.post(`/api/sms/retry/${encodeURIComponent(id)}`);
      setStatusMessage(t.sms.reminderRetriedNotice);
      await fetchData();
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: any) {
      setErrorMessage(err instanceof ApiError ? err.message : t.sms.reminderRetryError);
    }
  };

  // Manual SMS send via real POST /api/sms/test
  const handleSendManualSms = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSendingManual(true);
    setErrorMessage(null);
    try {
      const res = await api.post<{ phone?: { e164?: string }; isSimulated?: boolean }>('/api/sms/test', {
        phone: manualRecipient,
        recipientName: manualName,
        animalName: manualAnimal,
        category: 'MANUAL',
        message: manualMessage,
      });
      setIsManualModalOpen(false);
      setStatusMessage(
        `${t.sms.manualSentPrefix} ${manualName} (${res.phone?.e164 || manualRecipient})${
          res.isSimulated ? ` ${t.sms.manualSentSimSuffix}` : ''
        }`
      );
      await fetchData();
      setTimeout(() => setStatusMessage(null), 4500);
    } catch (err: any) {
      setErrorMessage(err instanceof ApiError ? err.message : t.sms.manualSendError);
    } finally {
      setIsSendingManual(false);
    }
  };

  // Save template
  const handleSaveTemplate = async () => {
    if (!templateTitle.trim() || !templateContent.trim()) return;
    setErrorMessage(null);
    try {
      await api.post('/api/sms/templates', {
        id: selectedTemplate?.id,
        category: templateCategory,
        title: templateTitle.trim(),
        content: templateContent.trim(),
        language: language === 'ar' ? 'ar' : 'fr',
      });
      setStatusMessage(t.sms.templateSavedNotice);
      await fetchData();
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: any) {
      setErrorMessage(err instanceof ApiError ? err.message : t.sms.templateSaveError);
    }
  };

  // Save config
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    try {
      const updated = await api.put<SmsConfig>('/api/sms/config', {
        provider_mode: config.provider_mode,
        active_provider: config.active_provider,
        enable_vaccination_reminders: config.enable_vaccination_reminders,
        vaccination_intervals: config.vaccination_intervals,
        enable_appointment_reminders: config.enable_appointment_reminders,
        appointment_interval_hours: config.appointment_interval_hours,
        sending_start_hour: config.sending_start_hour,
        sending_end_hour: config.sending_end_hour,
        timezone: config.timezone,
      });
      setConfig(updated);
      setStatusMessage(t.sms.configSavedNotice);
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: any) {
      setErrorMessage(err instanceof ApiError ? err.message : t.sms.configSaveError);
    }
  };

  const handleInsertTag = (tag: string) => {
    setTemplateContent((prev) => prev + ` ${tag}`);
  };

  const templateCalc = calculateClientSmsSegments(templateContent);
  const manualCalc = calculateClientSmsSegments(manualMessage);

  const filteredReminders = reminders.filter((r) => {
    if (reminderFilter === 'Scheduled') return r.status === 'Scheduled';
    if (reminderFilter === 'Sent') return r.status === 'Sent' || r.status === 'Delivered';
    if (reminderFilter === 'Failed') return r.status === 'Failed';
    return true;
  });

  const getLogStatusCategory = (status: string): 'Delivered' | 'Sent' | 'Failed' => {
    const s = (status || '').toLowerCase();
    if (s.includes('fail') || s.includes('echec') || s.includes('échec') || s.includes('err') || s.includes('cancel')) {
      return 'Failed';
    }
    if (s.includes('deliver') || s.includes('livr') || s.includes('délivr')) {
      return 'Delivered';
    }
    return 'Sent';
  };

  const countDelivered = logs.filter((l) => getLogStatusCategory(l.status) === 'Delivered').length;
  const countSent = logs.filter((l) => getLogStatusCategory(l.status) === 'Sent').length;
  const countFailed = logs.filter((l) => getLogStatusCategory(l.status) === 'Failed').length;

  const deliverabilityRate =
    logs.length === 0 ? null : Math.round(((countDelivered + countSent) / logs.length) * 100);

  // Real Algerian mobile carrier distribution from registered clinic clients
  const carrierCounts = { Ooredoo: 0, Mobilis: 0, Djezzy: 0 };
  for (const c of clients) {
    const { carrier } = formatAlgerianPhone(c.phone);
    if (carrier === 'Ooredoo') carrierCounts.Ooredoo += 1;
    else if (carrier === 'Mobilis') carrierCounts.Mobilis += 1;
    else if (carrier === 'Djezzy') carrierCounts.Djezzy += 1;
  }
  const carrierTotal = carrierCounts.Ooredoo + carrierCounts.Mobilis + carrierCounts.Djezzy;
  const carrierPct = {
    Ooredoo: carrierTotal ? Math.round((carrierCounts.Ooredoo / carrierTotal) * 100) : 0,
    Mobilis: carrierTotal ? Math.round((carrierCounts.Mobilis / carrierTotal) * 100) : 0,
    Djezzy: carrierTotal ? Math.round((carrierCounts.Djezzy / carrierTotal) * 100) : 0,
  };

  const filteredLogs = logs.filter((l) => {
    const matchesSearch =
      l.recipient_name.toLowerCase().includes(logSearch.toLowerCase()) ||
      l.recipient_phone.includes(logSearch) ||
      l.message_content.toLowerCase().includes(logSearch.toLowerCase());
    if (!matchesSearch) return false;
    if (logStatusFilter === 'ALL') return true;
    return getLogStatusCategory(l.status) === logStatusFilter;
  });

  const translateReminderStatus = (status: string) => {
    if (status === 'Scheduled') return t.sms.reminderStatusScheduled;
    if (status === 'Sent') return t.sms.reminderStatusSent;
    if (status === 'Delivered') return t.sms.reminderStatusDelivered;
    if (status === 'Failed') return t.sms.reminderStatusFailed;
    if (status === 'Cancelled') return t.sms.reminderStatusCancelled;
    return status;
  };

  const renderLogStatusBadge = (status: string, compact = false) => {
    const category = getLogStatusCategory(status);

    if (category === 'Delivered') {
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full font-bold transition-all shadow-2xs ${
            compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
          } bg-[#CAE4C5] text-[#254222] border border-[#99CC66]/60`}
          title={t.sms.badgeDeliveredTitle}
        >
          <CheckCheck className="w-3.5 h-3.5 text-[#254222] shrink-0" />
          <span>{t.sms.badgeDelivered}</span>
          <span className="w-1.5 h-1.5 rounded-full bg-[#254222] shrink-0" />
        </span>
      );
    }

    if (category === 'Failed') {
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full font-bold transition-all shadow-2xs ${
            compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
          } bg-[#FDF2F0] text-[#7A1E1F] border border-[#E8B4B8]`}
          title={t.sms.badgeFailedTitle}
        >
          <XCircle className="w-3.5 h-3.5 text-[#9E2A2B] shrink-0" />
          <span>{t.sms.badgeFailed}</span>
          <span className="w-1.5 h-1.5 rounded-full bg-[#9E2A2B] shrink-0" />
        </span>
      );
    }

    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full font-bold transition-all shadow-2xs ${
          compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
        } bg-[#F7FAF4] text-[#254222] border border-[#CAE4C5]`}
        title={t.sms.badgeSentTitle}
      >
        <Send className="w-3.5 h-3.5 text-[#5E7F52] shrink-0" />
        <span>{t.sms.badgeSent}</span>
        <span className="w-1.5 h-1.5 rounded-full bg-[#99CC66] shrink-0" />
      </span>
    );
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-[1580px] w-full mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <MessageSquare className="w-7 h-7 text-[#254222]" />
            <h1 className="text-[24px] sm:text-[26px] font-bold text-[#254222] tracking-tight">
              {t.sms.title}
            </h1>
          </div>
          <p className="text-[14px] text-[#4A6644] mt-0.5">
            {t.sms.subtitle}
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap">
          <button
            onClick={handleTriggerScheduler}
            disabled={loading}
            className="px-4 py-2.5 rounded-xl border border-[#CAE4C5] bg-white hover:bg-[#F7FAF4] text-[#254222] font-semibold text-[13px] transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer disabled:opacity-50"
            title={t.sms.runSchedulerTitle}
          >
            <RefreshCw className={`w-4 h-4 text-[#254222] ${loading ? 'animate-spin' : ''}`} />
            <span>{t.sms.runSchedulerBtn}</span>
          </button>

          <button
            onClick={() => setIsManualModalOpen(true)}
            className="bg-[#254222] hover:bg-[#1B3219] text-white px-4 py-2.5 rounded-xl font-semibold text-[13px] transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
          >
            <Send className="w-4 h-4" />
            <span>{t.sms.composeSmsBtn}</span>
          </button>
        </div>
      </div>

      {/* Global Alerts */}
      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-[#FDF2F0] border border-[#E8B4B8] text-[#7A1E1F] text-[13.5px] font-medium flex items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {statusMessage && (
        <div className="p-3.5 rounded-xl bg-[#CAE4C5]/60 border border-[#99CC66] text-[#254222] text-[13.5px] font-medium flex items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-[#254222] shrink-0" />
            <span>{statusMessage}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="text-[#4A6644] hover:text-[#254222] cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Mode Badge Banner */}
      <div className="p-4 rounded-2xl bg-white border border-[#CAE4C5] shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-start sm:items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[#CAE4C5] text-[#254222] shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-[14px] text-[#254222]">{t.sms.gatewayModeLabel}</span>
              {config.provider_mode === 'PRODUCTION' ? (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#254222] text-white">
                  {t.sms.badgeProductionActive}
                </span>
              ) : (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#ECE2B1] text-[#254222] border border-[#99CC66]/50">
                  {t.sms.badgeTestSimulated}
                </span>
              )}
              <span className="text-xs text-[#4A6644]">
                {t.sms.targetOperatorPrefix} <strong className="text-[#254222]">{config.active_provider.replace(/_/g, ' ')}</strong>
              </span>
            </div>
            <p className="text-xs text-[#4A6644] mt-0.5">
              {config.provider_mode === 'PRODUCTION'
                ? config.api_key_configured
                  ? t.sms.productionReadyDesc
                  : t.sms.productionMissingKeysDesc
                : t.sms.testModeDesc}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-[#4A6644] shrink-0 bg-[#F7FAF4] px-3 py-2 rounded-xl border border-[#CAE4C5]">
          <Clock className="w-4 h-4 text-[#5E7F52]" />
          <span>
            {t.sms.allowedHoursPrefix}{' '}
            <strong className="text-[#254222]" dir="ltr">
              {config.sending_start_hour}h00 – {config.sending_end_hour}h00
            </strong>{' '}
            {t.sms.algiersTimezoneSuffix}
          </span>
        </div>
      </div>

      {/* Navigation Tabs Bar */}
      <div className="flex items-center gap-2 border-b border-[#CAE4C5] overflow-x-auto pb-1 scrollbar-none">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-[13.5px] transition-all whitespace-nowrap cursor-pointer ${
            activeTab === 'overview'
              ? 'bg-[#254222] text-white shadow-xs'
              : 'text-[#4A6644] hover:bg-[#CAE4C5]/60 hover:text-[#254222]'
          }`}
        >
          <Sparkles className="w-4 h-4" />
          <span>{t.sms.tabOverview}</span>
        </button>

        <button
          onClick={() => setActiveTab('scheduled')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-[13.5px] transition-all whitespace-nowrap cursor-pointer ${
            activeTab === 'scheduled'
              ? 'bg-[#254222] text-white shadow-xs'
              : 'text-[#4A6644] hover:bg-[#CAE4C5]/60 hover:text-[#254222]'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>{t.sms.tabScheduled}</span>
          <span className={`px-2 py-0.5 rounded-full text-xs ${activeTab === 'scheduled' ? 'bg-white/20 text-white' : 'bg-[#CAE4C5] text-[#254222]'}`}>
            {reminders.filter((r) => r.status === 'Scheduled').length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-[13.5px] transition-all whitespace-nowrap cursor-pointer ${
            activeTab === 'history'
              ? 'bg-[#254222] text-white shadow-xs'
              : 'text-[#4A6644] hover:bg-[#CAE4C5]/60 hover:text-[#254222]'
          }`}
        >
          <History className="w-4 h-4" />
          <span>{t.sms.tabHistory}</span>
          <span className={`px-2 py-0.5 rounded-full text-xs ${activeTab === 'history' ? 'bg-white/20 text-white' : 'bg-[#CAE4C5] text-[#254222]'}`}>
            {logs.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('templates')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-[13.5px] transition-all whitespace-nowrap cursor-pointer ${
            activeTab === 'templates'
              ? 'bg-[#254222] text-white shadow-xs'
              : 'text-[#4A6644] hover:bg-[#CAE4C5]/60 hover:text-[#254222]'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>{t.sms.tabTemplates}</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-[13.5px] transition-all whitespace-nowrap cursor-pointer ${
            activeTab === 'settings'
              ? 'bg-[#254222] text-white shadow-xs'
              : 'text-[#4A6644] hover:bg-[#CAE4C5]/60 hover:text-[#254222]'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>{t.sms.tabSettings}</span>
        </button>
      </div>

      {/* 1. VUE D'ENSEMBLE */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-5 rounded-2xl border border-[#CAE4C5] shadow-2xs">
              <span className="text-[13px] font-medium text-[#4A6644]">{t.sms.kpiProcessedSms}</span>
              <div className="flex items-baseline justify-between mt-2">
                <span className="text-3xl font-extrabold text-[#254222]">{logs.length}</span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[#CAE4C5] text-[#254222]">
                  {t.sms.kpiTotalToDate}
                </span>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-[#CAE4C5] shadow-2xs">
              <span className="text-[13px] font-medium text-[#4A6644]">{t.sms.kpiPendingReminders}</span>
              <div className="flex items-baseline justify-between mt-2">
                <span className="text-3xl font-extrabold text-[#254222]">
                  {reminders.filter((r) => r.status === 'Scheduled').length}
                </span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[#ECE2B1] text-[#254222] border border-[#99CC66]/40">
                  {t.sms.kpiIdempotentQueue}
                </span>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-[#CAE4C5] shadow-2xs">
              <span className="text-[13px] font-medium text-[#4A6644]">{t.sms.kpiSuccessRate}</span>
              <div className="flex items-baseline justify-between mt-2">
                <span className="text-3xl font-extrabold text-[#254222]">
                  {deliverabilityRate === null ? '—' : `${deliverabilityRate}%`}
                </span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[#CAE4C5] text-[#254222]">
                  {countFailed} {countFailed > 1 ? t.sms.kpiFailurePlural : t.sms.kpiFailureSingular}
                </span>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-[#CAE4C5] shadow-2xs">
              <span className="text-[13px] font-medium text-[#4A6644]">{t.sms.kpiActiveGateway}</span>
              <div className="flex items-baseline justify-between mt-2">
                <span className="text-xl font-bold text-[#254222] truncate">
                  {config.provider_mode === 'PRODUCTION' ? t.sms.realApiWord : t.sms.simulatorWord}
                </span>
                <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-[#CAE4C5] text-[#254222]">
                  {config.provider_mode === 'PRODUCTION' ? t.sms.productionWord : t.sms.testModeWord}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-2xl border border-[#CAE4C5] shadow-2xs space-y-4">
              <h2 className="font-bold text-[16px] text-[#254222] flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-[#254222]" />
                <span>{t.sms.carriersTitle}</span>
              </h2>
              <p className="text-xs text-[#4A6644]">
                {t.sms.carriersSubtitle}
              </p>

              <div className="space-y-3 pt-1">
                <div>
                  <div className="flex justify-between text-xs font-semibold text-[#254222] mb-1">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#ED1C24]" />
                      Ooredoo (05xx) — {carrierCounts.Ooredoo}
                    </span>
                    <span>{carrierPct.Ooredoo}%</span>
                  </div>
                  <div className="w-full h-2 bg-[#F7FAF4] rounded-full overflow-hidden border border-[#CAE4C5]">
                    <div className="h-full bg-[#ED1C24] rounded-full" style={{ width: `${carrierPct.Ooredoo}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold text-[#254222] mb-1">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#008A3B]" />
                      Mobilis (06xx) — {carrierCounts.Mobilis}
                    </span>
                    <span>{carrierPct.Mobilis}%</span>
                  </div>
                  <div className="w-full h-2 bg-[#F7FAF4] rounded-full overflow-hidden border border-[#CAE4C5]">
                    <div className="h-full bg-[#008A3B] rounded-full" style={{ width: `${carrierPct.Mobilis}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold text-[#254222] mb-1">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#F58220]" />
                      Djezzy (07xx) — {carrierCounts.Djezzy}
                    </span>
                    <span>{carrierPct.Djezzy}%</span>
                  </div>
                  <div className="w-full h-2 bg-[#F7FAF4] rounded-full overflow-hidden border border-[#CAE4C5]">
                    <div className="h-full bg-[#F58220] rounded-full" style={{ width: `${carrierPct.Djezzy}%` }} />
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-[#CAE4C5] text-[11px] text-[#4A6644] flex items-center gap-1.5">
                <Info className="w-4 h-4 text-[#5E7F52] shrink-0" />
                <span>{t.sms.e164Note}</span>
              </div>
            </div>

            <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-[#CAE4C5] shadow-2xs space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-[16px] text-[#254222] flex items-center gap-2">
                  <Clock className="w-5 h-5 text-[#254222]" />
                  <span>{t.sms.upcomingRemindersTitle}</span>
                </h2>
                <button
                  onClick={() => setActiveTab('scheduled')}
                  className="text-xs font-bold text-[#5E7F52] hover:underline cursor-pointer"
                >
                  {t.sms.viewAllQueueLink} &rarr;
                </button>
              </div>

              <div className="divide-y divide-[#CAE4C5]">
                {reminders.slice(0, 4).map((rem) => (
                  <div key={rem.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-[#254222]">{rem.owner_name}</span>
                        <span className="text-xs text-[#4A6644]">({rem.animal_name})</span>
                        <span className="text-xs px-2 py-0.5 rounded-md bg-[#CAE4C5] text-[#254222] font-medium">
                          {rem.reminder_type}
                        </span>
                      </div>
                      <p className="text-xs text-[#4A6644]">
                        {t.sms.numberPrefix}{' '}
                        <strong className="text-[#254222]" dir="ltr">
                          {rem.owner_phone}
                        </strong>{' '}
                        &bull; {t.sms.scheduledPrefix} {formatLocalizedDate(rem.scheduled_at, language)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-auto">
                      <span
                        className={`text-xs px-2.5 py-1 rounded-full font-bold ${
                          rem.status === 'Sent' || rem.status === 'Delivered'
                            ? 'bg-[#CAE4C5] text-[#254222]'
                            : rem.status === 'Failed'
                            ? 'bg-[#FDF2F0] text-[#9E2A2B]'
                            : 'bg-[#ECE2B1] text-[#254222] border border-[#99CC66]/40'
                        }`}
                      >
                        {translateReminderStatus(rem.status)}
                      </span>
                      {rem.status === 'Scheduled' && (
                        <button
                          onClick={() => handleSendReminderNow(rem)}
                          className="px-3 py-1 bg-[#254222] hover:bg-[#1B3219] text-white rounded-lg text-xs font-semibold cursor-pointer shadow-2xs"
                        >
                          {t.sms.sendShortBtn}
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                {reminders.length === 0 && (
                  <p className="py-6 text-center text-xs text-[#4A6644]">
                    {t.sms.emptyQueue}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. RAPPELS PLANIFIÉS */}
      {activeTab === 'scheduled' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-2xl border border-[#CAE4C5] shadow-2xs flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-[#4A6644]">{t.sms.filterByStatusLabel}</span>
              {(['ALL', 'Scheduled', 'Sent', 'Failed'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setReminderFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                    reminderFilter === f
                      ? 'bg-[#254222] text-white'
                      : 'bg-[#F7FAF4] text-[#4A6644] hover:bg-[#CAE4C5]/60'
                  }`}
                >
                  {f === 'ALL'
                    ? `${t.sms.filterAllCount} (${reminders.length})`
                    : f === 'Scheduled'
                    ? `${t.sms.filterPendingCount} (${reminders.filter((r) => r.status === 'Scheduled').length})`
                    : f === 'Sent'
                    ? `${t.sms.filterSentCount} (${reminders.filter((r) => r.status === 'Sent' || r.status === 'Delivered').length})`
                    : `${t.sms.filterFailedCount} (${reminders.filter((r) => r.status === 'Failed').length})`}
                </button>
              ))}
            </div>

            <button
              onClick={() => setIsManualModalOpen(true)}
              className="bg-[#254222] hover:bg-[#1B3219] text-white px-3.5 py-1.5 rounded-xl font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t.sms.sendManualSmsBtn}</span>
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-[#CAE4C5] shadow-2xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="bg-[#F7FAF4] border-b border-[#CAE4C5] text-[12px] font-bold text-[#4A6644] uppercase tracking-wider">
                    <th className="py-3 px-4 text-start">{t.sms.colRecipient}</th>
                    <th className="py-3 px-4 text-start">{t.sms.colAnimal}</th>
                    <th className="py-3 px-4 text-start">{t.sms.colReminderType}</th>
                    <th className="py-3 px-4 text-start">{t.sms.colScheduledDate}</th>
                    <th className="py-3 px-4 text-start">{t.sms.colStatus}</th>
                    <th className="py-3 px-4 text-end">{t.sms.colActions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#CAE4C5] text-[13px]">
                  {filteredReminders.map((r) => {
                    const phoneData = formatAlgerianPhone(r.owner_phone || r.phone_normalized || '');
                    return (
                      <tr key={r.id} className="hover:bg-[#F7FAF4]/60 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-bold text-[#254222]">{r.owner_name}</div>
                          <div className="text-xs text-[#4A6644] flex items-center gap-1.5 mt-0.5">
                            <span dir="ltr">{r.owner_phone}</span>
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-[#CAE4C5] text-[#254222]">
                              {phoneData.carrier}
                            </span>
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <div className="font-semibold text-[#254222] flex items-center gap-1.5">
                            <span>{r.species === 'Chien' ? '🐶' : '🐱'}</span>
                            <span>{r.animal_name}</span>
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded-md font-semibold text-xs bg-[#CAE4C5] text-[#254222] border border-[#99CC66]/40">
                            {r.reminder_type}
                          </span>
                        </td>

                        <td className="py-3 px-4 text-[#4A6644]">
                          {new Date(r.scheduled_at).toLocaleString(locale, {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>

                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold ${
                              r.status === 'Sent' || r.status === 'Delivered'
                                ? 'bg-[#CAE4C5] text-[#254222]'
                                : r.status === 'Scheduled'
                                ? 'bg-[#ECE2B1] text-[#254222]'
                                : 'bg-red-50 text-red-600'
                            }`}
                          >
                            {(r.status === 'Sent' || r.status === 'Delivered') && <CheckCircle2 className="w-3.5 h-3.5" />}
                            {r.status === 'Scheduled' && <Clock className="w-3.5 h-3.5" />}
                            {translateReminderStatus(r.status)}
                          </span>
                          {r.last_error && <div className="text-[11px] text-red-600 mt-0.5">{r.last_error}</div>}
                        </td>

                        <td className="py-3 px-4 text-end">
                          <div className="flex items-center justify-end gap-2">
                            {r.status === 'Scheduled' && (
                              <>
                                <button
                                  onClick={() => handleSendReminderNow(r)}
                                  className="px-2.5 py-1 bg-[#254222] hover:bg-[#1B3219] text-white rounded-lg text-xs font-semibold cursor-pointer shadow-2xs"
                                >
                                  {t.sms.sendNowBtn}
                                </button>
                                <button
                                  onClick={() => handleCancelReminder(r.id)}
                                  className="px-2 py-1 bg-[#F7FAF4] hover:bg-red-50 text-red-600 border border-[#CAE4C5] rounded-lg text-xs font-medium cursor-pointer"
                                >
                                  {t.sms.cancelBtn}
                                </button>
                              </>
                            )}
                            {r.status === 'Failed' && (
                              <button
                                onClick={() => handleRetryReminder(r.id)}
                                className="px-2.5 py-1 bg-[#CAE4C5] hover:bg-[#99CC66] text-[#254222] rounded-lg text-xs font-semibold flex items-center gap-1 cursor-pointer"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>{t.sms.retryBtn}</span>
                              </button>
                            )}
                            {(r.status === 'Sent' || r.status === 'Delivered') && (
                              <span className="text-xs text-[#5E7F52] italic">
                                {r.is_simulated ? t.sms.deliveredSimulated : t.sms.transmittedWord}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {filteredReminders.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-[#4A6644] text-xs">
                        {t.sms.noFilteredReminders}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 3. HISTORIQUE SMS */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <button
              type="button"
              onClick={() => setLogStatusFilter('ALL')}
              className={`p-3.5 rounded-2xl border text-start transition-all cursor-pointer ${
                logStatusFilter === 'ALL'
                  ? 'bg-white border-[#254222] shadow-xs ring-2 ring-[#254222]/20'
                  : 'bg-white/80 border-[#CAE4C5] hover:bg-white'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#4A6644]">{t.sms.histAllArchived}</span>
                <History className="w-4 h-4 text-[#5E7F52]" />
              </div>
              <div className="mt-1 text-2xl font-bold text-[#254222]">{logs.length}</div>
              <div className="text-[11px] text-[#4A6644] mt-0.5">{t.sms.histAllStreams}</div>
            </button>

            <button
              type="button"
              onClick={() => setLogStatusFilter('Delivered')}
              className={`p-3.5 rounded-2xl border text-start transition-all cursor-pointer ${
                logStatusFilter === 'Delivered'
                  ? 'bg-[#CAE4C5]/55 border-[#254222] shadow-xs ring-2 ring-[#254222]/20'
                  : 'bg-white/80 border-[#CAE4C5] hover:bg-[#CAE4C5]/35'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#254222]">{t.sms.histDelivered}</span>
                <CheckCheck className="w-4 h-4 text-[#254222]" />
              </div>
              <div className="mt-1 text-2xl font-bold text-[#254222]">{countDelivered}</div>
              <div className="text-[11px] text-[#4A6644] font-medium mt-0.5">{t.sms.histReceiptsConfirmed}</div>
            </button>

            <button
              type="button"
              onClick={() => setLogStatusFilter('Sent')}
              className={`p-3.5 rounded-2xl border text-start transition-all cursor-pointer ${
                logStatusFilter === 'Sent'
                  ? 'bg-[#F7FAF4] border-[#254222] shadow-xs ring-2 ring-[#254222]/20'
                  : 'bg-white/80 border-[#CAE4C5] hover:bg-[#F7FAF4]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#254222]">{t.sms.histSent}</span>
                <Send className="w-4 h-4 text-[#5E7F52]" />
              </div>
              <div className="mt-1 text-2xl font-bold text-[#254222]">{countSent}</div>
              <div className="text-[11px] text-[#4A6644] mt-0.5">{t.sms.histInTransit}</div>
            </button>

            <button
              type="button"
              onClick={() => setLogStatusFilter('Failed')}
              className={`p-3.5 rounded-2xl border text-start transition-all cursor-pointer ${
                logStatusFilter === 'Failed'
                  ? 'bg-[#FDF2F0] border-[#9E2A2B] shadow-xs ring-2 ring-[#9E2A2B]/20'
                  : 'bg-white/80 border-[#CAE4C5] hover:bg-[#FDF2F0]/60'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#7A1E1F]">{t.sms.histFailed}</span>
                <XCircle className="w-4 h-4 text-[#9E2A2B]" />
              </div>
              <div className="mt-1 text-2xl font-bold text-[#9E2A2B]">{countFailed}</div>
              <div className="text-[11px] text-[#7A1E1F] mt-0.5">{t.sms.histUndelivered}</div>
            </button>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-[#CAE4C5] shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="relative flex-1">
              <input
                type="text"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder={t.sms.histSearchPlaceholder}
                className="w-full px-4 py-2 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-sm focus:outline-none focus:border-[#254222] focus:bg-white text-[#254222]"
              />
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setLogStatusFilter('ALL')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  logStatusFilter === 'ALL'
                    ? 'bg-[#254222] text-white shadow-2xs'
                    : 'bg-[#F7FAF4] text-[#4A6644] hover:bg-[#CAE4C5]/60 border border-[#CAE4C5]'
                }`}
              >
                {t.sms.histAllFilter} ({logs.length})
              </button>
              <button
                type="button"
                onClick={() => setLogStatusFilter('Delivered')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  logStatusFilter === 'Delivered'
                    ? 'bg-[#CAE4C5] text-[#254222] border border-[#254222] ring-2 ring-[#254222]/20 shadow-2xs'
                    : 'bg-[#F7FAF4] text-[#254222] hover:bg-[#CAE4C5]/60 border border-[#CAE4C5]'
                }`}
              >
                <CheckCheck className="w-3.5 h-3.5 text-[#254222]" />
                <span>{t.sms.histDeliveredFilter} ({countDelivered})</span>
              </button>
              <button
                type="button"
                onClick={() => setLogStatusFilter('Sent')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  logStatusFilter === 'Sent'
                    ? 'bg-[#F7FAF4] text-[#254222] border border-[#254222] ring-2 ring-[#254222]/20 shadow-2xs'
                    : 'bg-[#F7FAF4] text-[#4A6644] hover:bg-[#CAE4C5]/60 border border-[#CAE4C5]'
                }`}
              >
                <Send className="w-3.5 h-3.5 text-[#5E7F52]" />
                <span>{t.sms.histSentFilter} ({countSent})</span>
              </button>
              <button
                type="button"
                onClick={() => setLogStatusFilter('Failed')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  logStatusFilter === 'Failed'
                    ? 'bg-[#FDF2F0] text-[#7A1E1F] border border-[#9E2A2B] ring-2 ring-[#9E2A2B]/20 shadow-2xs'
                    : 'bg-[#F7FAF4] text-[#4A6644] hover:bg-[#FDF2F0] border border-[#CAE4C5]'
                }`}
              >
                <XCircle className="w-3.5 h-3.5 text-[#9E2A2B]" />
                <span>{t.sms.histFailedFilter} ({countFailed})</span>
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-[#CAE4C5] shadow-2xs overflow-hidden divide-y divide-[#CAE4C5]">
            {filteredLogs.map((log) => (
              <div
                key={log.id}
                className="p-4 hover:bg-[#F7FAF4]/50 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div className="space-y-1.5 flex-1 min-w-0 pe-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-[14px] text-[#254222]">{log.recipient_name}</span>
                    <span dir="ltr" className="text-xs font-mono text-[#4A6644] bg-[#F7FAF4] px-2 py-0.5 rounded border border-[#CAE4C5]">
                      {log.recipient_phone}
                    </span>
                    {log.animal_name && (
                      <span className="text-xs px-2 py-0.5 rounded bg-[#CAE4C5] text-[#254222] font-medium">
                        {t.sms.patientPrefix} {log.animal_name}
                      </span>
                    )}
                    <span className="text-[11px] text-[#5E7F52]">
                      {new Date(log.created_at).toLocaleString(locale)}
                    </span>
                  </div>

                  <p className="text-[13px] text-[#254222] bg-[#F7FAF4] p-2.5 rounded-xl border border-[#CAE4C5] font-mono leading-relaxed">
                    {log.message_content}
                  </p>

                  <div className="flex items-center gap-3 text-xs text-[#4A6644] flex-wrap">
                    <span>{t.sms.formatPrefix} <strong className="text-[#254222]">{log.encoding}</strong></span>
                    <span>&bull;</span>
                    <span>{t.sms.segmentsPrefix} <strong className="text-[#5E7F52]">{log.segment_count} SMS</strong></span>
                    {log.category && (
                      <>
                        <span>&bull;</span>
                        <span className="text-[11px] px-2 py-0.2 rounded bg-[#CAE4C5] text-[#254222] font-medium">
                          {log.category}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex md:flex-col items-center md:items-end justify-between gap-2.5 shrink-0">
                  {renderLogStatusBadge(log.status)}
                  {log.provider_response && (
                    <button
                      onClick={() => setSelectedLogPayload(log)}
                      className="text-xs text-[#5E7F52] hover:underline cursor-pointer font-medium"
                    >
                      {t.sms.payloadDetailsBtn} &rarr;
                    </button>
                  )}
                </div>
              </div>
            ))}

            {filteredLogs.length === 0 && (
              <div className="p-8 text-center text-[#4A6644] text-xs">
                {t.sms.noFilteredLogs}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. MODÈLES DE MESSAGES */}
      {activeTab === 'templates' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-white p-5 rounded-2xl border border-[#CAE4C5] shadow-2xs space-y-4">
            <h2 className="font-bold text-[16px] text-[#254222] flex items-center gap-2">
              <FileText className="w-5 h-5 text-[#254222]" />
              <span>{t.sms.savedTemplatesTitle}</span>
            </h2>

            <div className="space-y-2">
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  onClick={() => {
                    setSelectedTemplate(tpl);
                    setTemplateTitle(tpl.title);
                    setTemplateContent(tpl.content);
                    setTemplateCategory(tpl.category);
                  }}
                  className={`p-3 rounded-xl border text-start cursor-pointer transition-all ${
                    selectedTemplate?.id === tpl.id
                      ? 'bg-[#CAE4C5]/60 border-[#254222] shadow-2xs'
                      : 'border-[#CAE4C5] hover:bg-[#F7FAF4]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-xs text-[#254222] truncate">{tpl.title}</span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-white text-[#254222] border border-[#CAE4C5] shrink-0">
                      {tpl.category}
                    </span>
                  </div>
                  <p className="text-xs text-[#4A6644] line-clamp-2 mt-1">{tpl.content}</p>
                </div>
              ))}
            </div>

            <button
              onClick={() => {
                setSelectedTemplate(null);
                setTemplateTitle(t.sms.newTemplateDefaultTitle);
                setTemplateContent(t.sms.newTemplateDefaultContent);
                setTemplateCategory('VACCINATION');
              }}
              className="w-full py-2 border border-dashed border-[#99CC66] hover:bg-[#F7FAF4] text-[#254222] rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>{t.sms.createTemplateBtn}</span>
            </button>
          </div>

          <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-[#CAE4C5] shadow-2xs space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <h2 className="font-bold text-[16px] text-[#254222] flex items-center gap-2">
                <FileText className="w-5 h-5 text-[#254222]" />
                <span>{t.sms.templateEditorTitle}</span>
              </h2>

              <div className="flex items-center gap-2">
                <span className="text-xs text-[#4A6644]">{t.sms.categoryLabel}</span>
                <select
                  value={templateCategory}
                  onChange={(e) => setTemplateCategory(e.target.value as any)}
                  className="px-3 py-1.5 bg-[#F7FAF4] border border-[#CAE4C5] rounded-lg text-xs font-bold text-[#254222]"
                >
                  <option value="VACCINATION">{t.sms.catVaccination}</option>
                  <option value="APPOINTMENT">{t.sms.catAppointment}</option>
                  <option value="POST_OP">{t.sms.catPostOp}</option>
                  <option value="URGENCE">{t.sms.catUrgence}</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#4A6644] mb-1">{t.sms.templateTitleLabel}</label>
              <input
                type="text"
                value={templateTitle}
                onChange={(e) => setTemplateTitle(e.target.value)}
                className="w-full px-3 py-2 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-sm font-semibold text-[#254222]"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-[#4A6644] mb-1.5">
                {t.sms.dynamicTagsLabel}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {['{proprietaire}', '{animal}', '{date}', '{heure}', '{vaccin}', '{cabinet}', '{telephone_cabinet}'].map(
                  (tag) => (
                    <button
                      key={tag}
                      type="button"
                      dir="ltr"
                      onClick={() => handleInsertTag(tag)}
                      className="px-2.5 py-1 rounded-lg bg-[#CAE4C5] hover:bg-[#99CC66] text-[#254222] text-xs font-mono font-semibold transition-colors cursor-pointer border border-[#CAE4C5]"
                    >
                      + {tag}
                    </button>
                  )
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-[#4A6644]">{t.sms.smsTextLabel}</label>
                <div className="flex items-center gap-2 text-xs">
                  <span className={`font-bold ${templateCalc.containsUnicode ? 'text-amber-600' : 'text-[#5E7F52]'}`}>
                    {templateCalc.encoding}
                  </span>
                  <span>&bull;</span>
                  <span>{templateCalc.characterCount} {t.sms.charsWord}</span>
                  <span>&bull;</span>
                  <span className="font-bold text-[#254222]">{templateCalc.segmentCount} SMS</span>
                </div>
              </div>

              <textarea
                value={templateContent}
                onChange={(e) => setTemplateContent(e.target.value)}
                rows={4}
                className="w-full p-3 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-sm font-mono focus:outline-none focus:border-[#254222] focus:bg-white text-[#254222]"
              />

              <div className="flex items-center justify-between mt-1 text-xs text-[#4A6644] gap-2 flex-wrap">
                <span>
                  {t.sms.remainingInSegmentPrefix} <strong>{templateCalc.remainingInCurrentSegment}</strong>
                </span>
                {templateCalc.containsUnicode && (
                  <span className="text-amber-600 font-semibold flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {t.sms.nonGsmWarning}
                  </span>
                )}
              </div>
            </div>

            <div className="bg-[#F7FAF4] p-4 rounded-xl border border-[#CAE4C5] space-y-2">
              <span className="text-xs font-bold text-[#4A6644] uppercase tracking-wider">
                {t.sms.previewLabel}
              </span>
              <p className="text-xs text-[#254222] font-mono leading-relaxed bg-white p-3 rounded-lg border border-[#CAE4C5]">
                {templateContent
                  .replace(/{proprietaire}/gi, 'Fatima Fatima')
                  .replace(/{animal}/gi, 'Nina')
                  .replace(/{date}/gi, '14/08/2026')
                  .replace(/{heure}/gi, '09:00')
                  .replace(/{vaccin}/gi, 'Vaccination annuelle')
                  .replace(/{cabinet}/gi, 'Cabinet My Vet')
                  .replace(/{telephone_cabinet}/gi, '0797 63 87 04')}
              </p>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleSaveTemplate}
                className="bg-[#254222] hover:bg-[#1B3219] text-white px-5 py-2.5 rounded-xl font-semibold text-xs transition-colors cursor-pointer shadow-xs"
              >
                {t.sms.saveTemplateBtn}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. PARAMÈTRES & ABONNEMENT */}
      {activeTab === 'settings' && (
        <form onSubmit={handleSaveConfig} className="space-y-6 max-w-4xl">
          <div className="bg-white p-6 rounded-2xl border border-[#CAE4C5] shadow-2xs space-y-4">
            <h2 className="font-bold text-[16px] text-[#254222] flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-[#254222]" />
              <span>{t.sms.telecomGatewayTitle}</span>
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                {
                  id: 'Ooredoo_Business_Algeria',
                  name: t.sms.provOoredooName,
                  tag: t.sms.provOoredooTag,
                  desc: t.sms.provOoredooDesc,
                },
                {
                  id: 'Mobilis_Entreprise',
                  name: t.sms.provMobilisName,
                  tag: t.sms.provMobilisTag,
                  desc: t.sms.provMobilisDesc,
                },
                {
                  id: 'Djezzy_Enterprise',
                  name: t.sms.provDjezzyName,
                  tag: t.sms.provDjezzyTag,
                  desc: t.sms.provDjezzyDesc,
                },
                {
                  id: 'Simulateur_MyVet',
                  name: t.sms.provSimName,
                  tag: t.sms.provSimTag,
                  desc: t.sms.provSimDesc,
                },
              ].map((prov) => (
                <label
                  key={prov.id}
                  className={`p-4 rounded-xl border flex flex-col justify-between cursor-pointer transition-all ${
                    config.active_provider === prov.id
                      ? 'bg-[#CAE4C5]/60 border-[#254222] shadow-2xs'
                      : 'border-[#CAE4C5] hover:bg-[#F7FAF4]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-[#254222]">{prov.name}</span>
                    <input
                      type="radio"
                      name="active_provider"
                      checked={config.active_provider === prov.id}
                      onChange={() => setConfig({ ...config, active_provider: prov.id })}
                      className="accent-[#254222]"
                    />
                  </div>
                  <span className="text-[10px] font-bold text-[#5E7F52] mt-1">{prov.tag}</span>
                  <p className="text-xs text-[#4A6644] mt-2">{prov.desc}</p>
                </label>
              ))}
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-[#CAE4C5] shadow-2xs space-y-4">
            <h2 className="font-bold text-[16px] text-[#254222] flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#254222]" />
              <span>{t.sms.execModeTitle}</span>
            </h2>

            <div className="flex flex-col sm:flex-row gap-4">
              <label className="flex items-center gap-2 text-sm font-semibold text-[#254222] cursor-pointer">
                <input
                  type="radio"
                  name="provider_mode"
                  value="TEST"
                  checked={config.provider_mode === 'TEST'}
                  onChange={() => setConfig({ ...config, provider_mode: 'TEST' })}
                  className="accent-[#254222]"
                />
                <span>{t.sms.execModeTestLabel}</span>
              </label>

              <label className="flex items-center gap-2 text-sm font-semibold text-[#4A6644] cursor-pointer">
                <input
                  type="radio"
                  name="provider_mode"
                  value="PRODUCTION"
                  checked={config.provider_mode === 'PRODUCTION'}
                  onChange={() => setConfig({ ...config, provider_mode: 'PRODUCTION' })}
                  className="accent-[#254222]"
                />
                <span>{t.sms.execModeProdLabel}</span>
              </label>
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-[#CAE4C5] shadow-2xs space-y-4">
            <h2 className="font-bold text-[16px] text-[#254222] flex items-center gap-2">
              <Clock className="w-5 h-5 text-[#254222]" />
              <span>{t.sms.allowedWindowTitle}</span>
            </h2>
            <p className="text-xs text-[#4A6644]">
              {t.sms.allowedWindowDesc}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-[#4A6644] mb-1">{t.sms.startHourLabel}</label>
                <input
                  type="number"
                  dir="ltr"
                  min={6}
                  max={12}
                  value={config.sending_start_hour}
                  onChange={(e) => setConfig({ ...config, sending_start_hour: parseInt(e.target.value, 10) || 8 })}
                  className="w-full px-3 py-2 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-sm font-bold text-[#254222]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#4A6644] mb-1">{t.sms.endHourLabel}</label>
                <input
                  type="number"
                  dir="ltr"
                  min={18}
                  max={23}
                  value={config.sending_end_hour}
                  onChange={(e) => setConfig({ ...config, sending_end_hour: parseInt(e.target.value, 10) || 20 })}
                  className="w-full px-3 py-2 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-sm font-bold text-[#254222]"
                />
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-[#CAE4C5] shadow-2xs space-y-4">
            <h2 className="font-bold text-[16px] text-[#254222] flex items-center gap-2">
              <Calendar className="w-5 h-5 text-[#254222]" />
              <span>{t.sms.autoRulesTitle}</span>
            </h2>

            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.enable_vaccination_reminders}
                  onChange={(e) => setConfig({ ...config, enable_vaccination_reminders: e.target.checked })}
                  className="w-4 h-4 accent-[#254222] rounded"
                />
                <span className="text-sm font-semibold text-[#254222]">
                  {t.sms.ruleVaccinesPrefix} ({config.vaccination_intervals || '7,3,1'} {t.sms.ruleVaccinesSuffix})
                </span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.enable_appointment_reminders}
                  onChange={(e) => setConfig({ ...config, enable_appointment_reminders: e.target.checked })}
                  className="w-4 h-4 accent-[#254222] rounded"
                />
                <span className="text-sm font-semibold text-[#254222]">
                  {t.sms.ruleAptsPrefix} {config.appointment_interval_hours || 24} {t.sms.ruleAptsSuffix}
                </span>
              </label>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              className="bg-[#254222] hover:bg-[#1B3219] text-white px-6 py-2.5 rounded-xl font-bold text-sm transition-colors cursor-pointer shadow-xs"
            >
              {t.sms.saveSettingsBtn}
            </button>
          </div>
        </form>
      )}

      {/* Manual Compose Modal */}
      <Modal
        isOpen={isManualModalOpen}
        onClose={() => setIsManualModalOpen(false)}
        title={t.sms.manualModalTitle}
      >
        <form onSubmit={handleSendManualSms} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#4A6644] mb-1">{t.sms.manualOwnerNameLabel}</label>
              <input
                type="text"
                required
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                className="w-full px-3 py-2 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-xs font-semibold text-[#254222]"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-[#4A6644] mb-1">
                {t.sms.manualPhoneLabel}
              </label>
              <input
                type="text"
                dir="ltr"
                required
                value={manualRecipient}
                onChange={(e) => setManualRecipient(e.target.value)}
                className="w-full px-3 py-2 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-xs font-semibold text-[#254222] font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-[#4A6644] mb-1">{t.sms.manualAnimalLabel}</label>
            <input
              type="text"
              value={manualAnimal}
              onChange={(e) => setManualAnimal(e.target.value)}
              className="w-full px-3 py-2 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-xs font-semibold text-[#254222]"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-[#4A6644]">{t.sms.manualMsgLabel}</label>
              <span className="text-xs font-semibold text-[#5E7F52]">
                {manualCalc.encoding} &bull; {manualCalc.characterCount} ({manualCalc.segmentCount} SMS)
              </span>
            </div>
            <textarea
              required
              rows={4}
              value={manualMessage}
              onChange={(e) => setManualMessage(e.target.value)}
              className="w-full p-3 bg-[#F7FAF4] border border-[#CAE4C5] rounded-xl text-xs font-mono text-[#254222]"
            />
          </div>

          <div className="p-3 bg-[#ECE2B1]/60 border border-[#99CC66]/40 rounded-xl text-xs text-[#254222] flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#254222] shrink-0" />
            <span>
              {config.provider_mode === 'PRODUCTION'
                ? t.sms.manualModeProdInfo
                : t.sms.manualModeTestInfo}
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsManualModalOpen(false)}
              className="px-4 py-2 border border-[#CAE4C5] rounded-xl text-xs font-semibold text-[#4A6644] hover:bg-[#F7FAF4] cursor-pointer"
            >
              {t.common.cancel}
            </button>
            <button
              type="submit"
              disabled={isSendingManual}
              className="px-5 py-2 bg-[#254222] hover:bg-[#1B3219] text-white rounded-xl text-xs font-bold cursor-pointer disabled:opacity-50"
            >
              {isSendingManual ? t.sms.sendingMsgBtn : t.sms.sendMsgBtn}
            </button>
          </div>
        </form>
      </Modal>

      {/* Payload Inspection Modal */}
      <Modal
        isOpen={!!selectedLogPayload}
        onClose={() => setSelectedLogPayload(null)}
        title={t.sms.payloadModalTitle}
      >
        {selectedLogPayload && (
          <div className="space-y-3 text-xs">
            <div className="p-3 bg-[#F7FAF4] rounded-xl border border-[#CAE4C5] space-y-2">
              <div className="flex items-center justify-between pb-2 border-b border-[#CAE4C5]/70">
                <span className="font-bold text-[#4A6644]">{t.sms.payloadRoutingStatus}</span>
                {renderLogStatusBadge(selectedLogPayload.status)}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1">
                <div>
                  <strong className="text-[#4A6644]">{t.sms.payloadRecordId}</strong>{' '}
                  <span dir="ltr" className="font-mono text-[#254222]">{selectedLogPayload.id}</span>
                </div>
                <div>
                  <strong className="text-[#4A6644]">{t.sms.payloadSentAt}</strong>{' '}
                  <span className="text-[#254222]">{new Date(selectedLogPayload.created_at).toLocaleString(locale)}</span>
                </div>
              </div>
              <div>
                <strong className="text-[#4A6644]">{t.sms.payloadRecipient}</strong>{' '}
                <span className="text-[#254222]">{selectedLogPayload.recipient_name}</span> (
                <span dir="ltr" className="font-mono text-[#254222]">{selectedLogPayload.recipient_phone}</span>)
              </div>
              <div>
                <strong className="text-[#4A6644]">{t.sms.payloadEncodingVolume}</strong>{' '}
                <span className="text-[#254222]">
                  {selectedLogPayload.encoding} &bull; {selectedLogPayload.segment_count} SMS
                </span>
              </div>
            </div>

            <div>
              <span className="font-bold text-[#4A6644] block mb-1">{t.sms.payloadRawResponse}</span>
              <pre dir="ltr" className="p-3 bg-[#162914] text-[#CAE4C5] rounded-xl overflow-x-auto text-[11px] font-mono text-left">
                {JSON.stringify(safeParseJson(selectedLogPayload.provider_response), null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
