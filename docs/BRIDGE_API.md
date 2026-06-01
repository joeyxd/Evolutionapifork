# Bridge API (Mathisix Fork)

This fork adds canonical read endpoints to provide UI-ready payloads for external consumers (Mathisix backend/UI).

## Goal

- Use Evolution internal state as source of truth.
- Avoid rebuilding identity from fragmented webhooks.
- Normalize direct-chat identities (`@lid` vs `@s.whatsapp.net`) and filter system/broadcast noise.

## Endpoints

All endpoints require the same auth guards used by the standard API (instance exists, instance logged, apikey).

### 1) Snapshot

`GET /bridge/snapshot/:instanceName?take=500&skip=0`

Returns:

- canonical conversations list
- aliases per conversation
- group/direct flags
- normalized display name fallback
- unread count
- last message (mapped)

### 2) Conversation

`GET /bridge/conversation/:instanceName?remoteJid=<jid>&take=80&page=1`

Returns:

- paged messages for the provided conversation JID
- mapped direction/text/type/timestamp metadata
- raw message payload preserved

### 3) Labels/Tags

`GET /bridge/labels/:instanceName`

Returns:

- all labels available in the instance
- canonical source for UI tag chips and filtering

### 4) Live Stream (SSE)

`GET /bridge/stream/:instanceName?events=messages.upsert,messages.update,chats.update`

Returns Server-Sent Events with:

- `event`: original Evolution event name
- `data`: normalized realtime payload
- `conversationIds`: inferred affected conversations

Also emits `ready` and periodic `heartbeat` events.

## Important Notes

- `status@broadcast`, `*@broadcast`, `*@newsletter` are ignored.
- Canonical identity prefers `remoteJidAlt` when primary JID is `@lid`.
- Stream payloads are emitted from the same internal dispatch path used by webhook/socket integrations (`sendDataWebhook`), so you get inbound and outbound message traffic in realtime.
