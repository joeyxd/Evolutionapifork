import { WAMonitoringService } from '@api/services/monitor.service';
import { eventEmitter } from '@config/event.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import { isArray } from 'class-validator';
import { Response } from 'express';

type BridgeSnapshotOptions = {
  take?: number;
  skip?: number;
};

type BridgeConversationOptions = {
  remoteJid: string;
  take?: number;
  page?: number;
};

type BridgeStreamOptions = {
  events?: string;
};

type AnyRecord = Record<string, any>;

export class BridgeService {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  private getInstance(instanceName: string): any {
    const instance = this.waMonitor?.waInstances?.[instanceName];
    if (!instance) {
      throw new NotFoundException(`Instance "${instanceName}" not found or not loaded`);
    }
    return instance;
  }

  private clamp(value: any, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  private isIgnoredJid(jid?: string): boolean {
    if (!jid) return true;
    const lower = jid.toLowerCase();
    return lower === 'status@broadcast' || lower.endsWith('@broadcast') || lower.endsWith('@newsletter');
  }

  private toNumericIdentity(jid?: string): string | null {
    if (!jid) return null;
    const base = jid.split('@')[0] || '';
    const cleaned = base.replace(/\D/g, '');
    return cleaned || null;
  }

  private canonicalRemoteJid(remoteJid?: string, messageKey?: AnyRecord): string {
    if (!remoteJid) return '';
    const remoteJidAlt = messageKey?.remoteJidAlt;

    if (remoteJid.endsWith('@lid') && typeof remoteJidAlt === 'string' && remoteJidAlt.includes('@')) {
      return remoteJidAlt;
    }
    return remoteJid;
  }

  private scoreChatRecord(chat: AnyRecord): number {
    let score = 0;
    const jid: string = chat?.remoteJid || '';
    const pushName: string = chat?.pushName || '';
    const hasHumanName = !!pushName && !pushName.includes('@') && !/^\d+$/.test(pushName);

    if (jid.endsWith('@g.us')) score += 30;
    if (!jid.endsWith('@lid')) score += 15;
    if (hasHumanName) score += 20;
    if (chat?.profilePicUrl) score += 5;
    if (chat?.lastMessage) score += 5;

    return score;
  }

  private extractMessageText(message: AnyRecord): string | null {
    if (!message) return null;
    const body = message.message || {};
    if (typeof body?.conversation === 'string') return body.conversation;
    if (typeof body?.extendedTextMessage?.text === 'string') return body.extendedTextMessage.text;
    if (typeof body?.imageMessage?.caption === 'string') return body.imageMessage.caption;
    if (typeof body?.videoMessage?.caption === 'string') return body.videoMessage.caption;
    if (typeof body?.documentMessage?.caption === 'string') return body.documentMessage.caption;
    if (typeof body?.documentWithCaptionMessage?.message?.documentMessage?.caption === 'string') {
      return body.documentWithCaptionMessage.message.documentMessage.caption;
    }
    if (typeof body?.buttonsResponseMessage?.selectedDisplayText === 'string') {
      return body.buttonsResponseMessage.selectedDisplayText;
    }
    if (typeof body?.listResponseMessage?.title === 'string') return body.listResponseMessage.title;
    if (typeof body?.reactionMessage?.text === 'string') return body.reactionMessage.text;
    return null;
  }

  private messageDirection(message: AnyRecord): 'inbound' | 'outbound' {
    const fromMe = message?.key?.fromMe === true;
    return fromMe ? 'outbound' : 'inbound';
  }

  private mapMessage(message: AnyRecord) {
    const key = message?.key || {};
    return {
      id: message?.id || null,
      providerMessageId: key?.id || null,
      remoteJid: key?.remoteJid || null,
      remoteJidAlt: key?.remoteJidAlt || null,
      participant: message?.participant || key?.participant || key?.participantAlt || null,
      pushName: message?.pushName || null,
      messageType: message?.messageType || null,
      direction: this.messageDirection(message),
      messageTimestamp: message?.messageTimestamp || null,
      status: message?.status || null,
      text: this.extractMessageText(message),
      raw: message,
    };
  }

  private parseJsonArray(value: any): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.filter((v) => typeof v === 'string');
    }
    return [];
  }

  private inferConversationIds(event: string, data: any): string[] {
    const eventData = Array.isArray(data) ? data : [data];
    const ids = new Set<string>();

    for (const item of eventData) {
      if (!item) continue;
      const key = item?.key || {};
      const candidateIds = [
        item?.remoteJid,
        item?.chatId,
        item?.id,
        key?.remoteJid,
        key?.remoteJidAlt,
      ];
      for (const candidate of candidateIds) {
        if (typeof candidate !== 'string') continue;
        if (candidate.includes('@') && !this.isIgnoredJid(candidate)) {
          ids.add(this.canonicalRemoteJid(candidate, key));
        }
      }
    }

    // Some events carry flat payloads
    if (ids.size === 0 && typeof data === 'object' && data) {
      const id = data?.id;
      if (typeof id === 'string' && id.includes('@') && !this.isIgnoredJid(id)) {
        ids.add(this.canonicalRemoteJid(id));
      }
    }

    // Never let non-chat system streams pollute downstream consumers
    if (event === 'presence.update') {
      return Array.from(ids).filter((jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@lid'));
    }

    return Array.from(ids);
  }

  private mapRealtimeEvent(payload: AnyRecord) {
    const event = payload?.event || null;
    const data = payload?.data;
    const conversationIds = this.inferConversationIds(event, data);
    return {
      instanceName: payload?.instanceName || null,
      event,
      eventAt: payload?.dateTime || new Date().toISOString(),
      sender: payload?.sender || null,
      conversationIds,
      data,
    };
  }

  private mergeChats(chats: AnyRecord[]) {
    const merged = new Map<
      string,
      {
        canonicalId: string;
        aliases: Set<string>;
        best: AnyRecord;
        unreadCount: number;
      }
    >();

    for (const chat of chats) {
      const remoteJid = chat?.remoteJid;
      if (this.isIgnoredJid(remoteJid)) continue;

      const canonicalId = this.canonicalRemoteJid(remoteJid, chat?.lastMessage?.key || {});
      if (!canonicalId || this.isIgnoredJid(canonicalId)) continue;

      if (!merged.has(canonicalId)) {
        merged.set(canonicalId, {
          canonicalId,
          aliases: new Set([remoteJid, canonicalId].filter(Boolean)),
          best: chat,
          unreadCount: Number(chat?.unreadCount || 0),
        });
        continue;
      }

      const current = merged.get(canonicalId);
      current.aliases.add(remoteJid);
      current.aliases.add(canonicalId);
      current.unreadCount = Math.max(current.unreadCount, Number(chat?.unreadCount || 0));

      const currentScore = this.scoreChatRecord(current.best);
      const candidateScore = this.scoreChatRecord(chat);
      const currentUpdated = new Date(current.best?.updatedAt || 0).getTime();
      const candidateUpdated = new Date(chat?.updatedAt || 0).getTime();

      if (candidateScore > currentScore || (candidateScore === currentScore && candidateUpdated > currentUpdated)) {
        current.best = chat;
      }
    }

    return Array.from(merged.values()).map((entry) => {
      const best = entry.best || {};
      const lastMessage = best?.lastMessage ? this.mapMessage(best.lastMessage) : null;
      const numericIdentity = this.toNumericIdentity(entry.canonicalId);
      const displayName = best?.pushName || numericIdentity || entry.canonicalId;
      const isGroup = entry.canonicalId.endsWith('@g.us');

      return {
        conversationId: entry.canonicalId,
        aliases: Array.from(entry.aliases).filter(Boolean),
        isGroup,
        displayName,
        numericIdentity,
        profilePicUrl: best?.profilePicUrl || null,
        updatedAt: best?.updatedAt || null,
        unreadCount: entry.unreadCount,
        lastMessage,
        raw: best,
      };
    });
  }

  public async getSnapshot(instanceName: string, options: BridgeSnapshotOptions = {}) {
    const instance = this.getInstance(instanceName);
    const take = this.clamp(options.take, 1, 2000, 500);
    const skip = this.clamp(options.skip, 0, 100000, 0);

    const chats = await instance.fetchChats({ take, skip });
    const rows = isArray(chats) ? chats : [];
    const mergedChats = this.mergeChats(rows);
    const labels = (await instance.fetchLabels?.()) || [];

    const chatRows = await instance.prismaRepository.chat.findMany({
      where: { instanceId: instance.instanceId },
      select: {
        remoteJid: true,
        labels: true,
        name: true,
      },
    });

    const labelMap = new Map<string, { id: string; name: string; color: string }>();
    for (const label of labels) {
      if (!label?.id) continue;
      labelMap.set(label.id, {
        id: label.id,
        name: label.name || label.id,
        color: label.color || null,
      });
    }

    const canonicalMeta = new Map<string, { labelIds: Set<string>; groupSubject: string | null }>();
    for (const row of chatRows) {
      const canonicalId = this.canonicalRemoteJid(row.remoteJid);
      if (!canonicalId || this.isIgnoredJid(canonicalId)) continue;
      if (!canonicalMeta.has(canonicalId)) {
        canonicalMeta.set(canonicalId, { labelIds: new Set<string>(), groupSubject: null });
      }
      const meta = canonicalMeta.get(canonicalId);
      if (row?.name && canonicalId.endsWith('@g.us')) {
        meta.groupSubject = row.name;
      }
      const ids = this.parseJsonArray(row?.labels);
      for (const id of ids) meta.labelIds.add(id);
    }

    const hydratedChats = mergedChats.map((chat) => {
      const meta = canonicalMeta.get(chat.conversationId);
      const labelIds = meta ? Array.from(meta.labelIds) : [];
      const tags = labelIds.map((id) => labelMap.get(id)).filter(Boolean);
      return {
        ...chat,
        groupSubject: meta?.groupSubject || null,
        labelIds,
        tags,
      };
    });

    return {
      instanceName,
      generatedAt: new Date().toISOString(),
      take,
      skip,
      totalRawChats: rows.length,
      totalCanonicalChats: mergedChats.length,
      labels,
      chats: hydratedChats,
    };
  }

  public async getConversation(instanceName: string, options: BridgeConversationOptions) {
    const instance = this.getInstance(instanceName);
    const remoteJid = options?.remoteJid;
    if (!remoteJid) {
      throw new BadRequestException('remoteJid is required');
    }
    if (this.isIgnoredJid(remoteJid)) {
      throw new BadRequestException('remoteJid is not allowed');
    }

    const take = this.clamp(options.take, 1, 500, 80);
    const page = this.clamp(options.page, 1, 2000, 1);

    const messagesResponse = await instance.fetchMessages({
      page,
      offset: take,
      where: {
        key: {
          remoteJid,
        },
      },
    });

    const records = messagesResponse?.messages?.records || [];
    const mapped = isArray(records) ? records.map((record) => this.mapMessage(record)) : [];
    const orderedAsc = mapped.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

    return {
      instanceName,
      conversationId: remoteJid,
      page,
      take,
      total: messagesResponse?.messages?.total || 0,
      pages: messagesResponse?.messages?.pages || 0,
      messages: orderedAsc,
    };
  }

  public async getLabels(instanceName: string) {
    const instance = this.getInstance(instanceName);
    const labels = (await instance.fetchLabels?.()) || [];
    return {
      instanceName,
      generatedAt: new Date().toISOString(),
      total: Array.isArray(labels) ? labels.length : 0,
      labels: Array.isArray(labels) ? labels : [],
    };
  }

  public async stream(instanceName: string, res: Response, options: BridgeStreamOptions = {}) {
    this.getInstance(instanceName);
    const eventsFilter = (options?.events || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const eventSet = new Set(eventsFilter);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (eventName: string, payload: unknown) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send('ready', {
      instanceName,
      connectedAt: new Date().toISOString(),
      eventsFilter: Array.from(eventSet),
    });

    const listener = (payload: AnyRecord) => {
      if (!payload || payload.instanceName !== instanceName) return;
      if (eventSet.size > 0 && !eventSet.has(payload.event)) return;

      const mapped = this.mapRealtimeEvent(payload);
      send(mapped.event || 'event', mapped);
    };

    eventEmitter.on('bridge.stream', listener);
    const heartbeat = setInterval(() => {
      send('heartbeat', { ts: new Date().toISOString() });
    }, 20000);

    res.on('close', () => {
      clearInterval(heartbeat);
      eventEmitter.off('bridge.stream', listener);
      res.end();
    });
  }
}
