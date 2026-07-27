import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { AppConfig } from '../config/configuration';
import { UsersService } from '../users/users.service';
import { ChatBlockService } from './chat-block.service';
import { ChatService } from './chat.service';

/** A connected chat socket tagged with its authenticated identity. */
type ChatSocket = WebSocket & { user?: AuthenticatedUser; isAlive?: boolean };

/**
 * Upper bound on a single base64 envelope. Envelopes carry ciphertext, and an
 * image attachment's ciphertext rides inside one, so this must be generous —
 * but it still caps how large a single queued/relayed blob can get, protecting
 * the transient DB queue from abuse. ~24 MB of base64 ≈ ~18 MB of bytes.
 */
const MAX_ENVELOPE_B64 = 24 * 1024 * 1024;

/**
 * WebSocket relay for end-to-end encrypted chat. It authenticates each socket
 * from the auth cookie (same JWT as the REST API), then does exactly one job:
 * move opaque ciphertext envelopes between users. It never derives a key, never
 * decrypts, and never stores plaintext. When the recipient is offline the
 * envelope is queued (ciphertext only) and flushed on their next connection.
 *
 * Socket registry is in-process (keyed by the recipient's storage id), so this
 * assumes a single app instance; a multi-instance deployment would need a
 * shared pub/sub, which is out of scope for the current single-node setup.
 */
@WebSocketGateway({ path: '/ws/chat' })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('ChatGateway');

  /** storageId -> live sockets for that user (multiple tabs/devices). */
  private readonly sockets = new Map<string, Set<ChatSocket>>();

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly chat: ChatService,
    private readonly blocks: ChatBlockService,
    private readonly config: ConfigService,
  ) {}

  private get app(): AppConfig {
    return this.config.get<AppConfig>('app');
  }

  async handleConnection(
    client: ChatSocket,
    request: IncomingMessage,
  ): Promise<void> {
    if (!this.app.chatEnabled) {
      this.close(client, 4003, 'chat_disabled');
      return;
    }

    const user = this.authenticate(request);
    if (!user) {
      this.close(client, 4001, 'unauthorized');
      return;
    }

    client.user = user;
    this.register(user.storageId, client);
    this.send(client, 'ready', { username: user.username });

    // Drain anything that arrived while this user was offline. Best-effort:
    // failures are logged but must not tear down the connection.
    try {
      await this.flushPending(client, user.storageId);
    } catch (err) {
      this.logger.error(`Failed to flush pending for ${user.username}: ${err}`);
    }
  }

  handleDisconnect(client: ChatSocket): void {
    const storageId = client.user?.storageId;
    if (!storageId) return;
    const set = this.sockets.get(storageId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) this.sockets.delete(storageId);
  }

  /**
   * Relay an encrypted envelope to a recipient identified by username. Delivers
   * to every live socket the recipient has; if they have none, queues the
   * ciphertext for later. Acks the sender with the delivery outcome.
   */
  @SubscribeMessage('send')
  async handleSend(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const user = client.user;
    if (!user) return;

    const data = (body ?? {}) as {
      to?: unknown;
      envelope?: unknown;
      clientMsgId?: unknown;
    };
    const to = typeof data.to === 'string' ? data.to.toLowerCase().trim() : '';
    const envelope = typeof data.envelope === 'string' ? data.envelope : '';
    const clientMsgId =
      typeof data.clientMsgId === 'string' ? data.clientMsgId : null;

    if (!to || !envelope) {
      this.send(client, 'sent', {
        clientMsgId,
        ok: false,
        error: 'bad_request',
      });
      return;
    }
    if (envelope.length > MAX_ENVELOPE_B64) {
      this.send(client, 'sent', { clientMsgId, ok: false, error: 'too_large' });
      return;
    }

    const recipient = await this.users.findByUsername(to);
    if (!recipient) {
      this.send(client, 'sent', {
        clientMsgId,
        ok: false,
        error: 'no_recipient',
      });
      return;
    }

    // If the recipient has blocked the sender, silently drop the message: do not
    // deliver, do not queue. The ack mirrors the "offline" case so the block is
    // not disclosed to the sender.
    if (await this.blocks.isBlocked(recipient.storageId, user.username)) {
      this.send(client, 'sent', {
        clientMsgId,
        ok: true,
        delivered: false,
        queued: false,
        ts: Date.now(),
      });
      return;
    }

    const payload = {
      from: user.username,
      envelope,
      ts: Date.now(),
    };
    const delivered = this.deliver(recipient.storageId, 'message', payload);

    if (!delivered) {
      await this.chat.enqueue(recipient.storageId, user.username, envelope);
    }

    this.send(client, 'sent', {
      clientMsgId,
      ok: true,
      delivered,
      queued: !delivered,
      ts: payload.ts,
    });
  }

  /**
   * Best-effort typing indicator: relayed to the recipient's live sockets only,
   * never queued (a stale "typing" is meaningless).
   */
  @SubscribeMessage('typing')
  async handleTyping(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const user = client.user;
    if (!user) return;
    const to =
      typeof (body as { to?: unknown })?.to === 'string'
        ? (body as { to: string }).to.toLowerCase().trim()
        : '';
    if (!to) return;
    const recipient = await this.users.findByUsername(to);
    if (!recipient) return;
    this.deliver(recipient.storageId, 'typing', { from: user.username });
  }

  // --- internals ------------------------------------------------------------

  /** Verify the auth cookie on the handshake; returns the user or null. */
  private authenticate(request: IncomingMessage): AuthenticatedUser | null {
    const token = this.readCookie(request.headers.cookie, AUTH_COOKIE);
    if (!token) return null;
    try {
      const payload = this.auth.verifyToken(token);
      if (payload.purpose !== 'auth') return null;
      return {
        id: payload.sub,
        username: payload.username,
        storageId: payload.storageId,
      };
    } catch {
      return null;
    }
  }

  /** Parse a single cookie value out of a Cookie header. */
  private readCookie(header: string | undefined, name: string): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === name) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
    return null;
  }

  private register(storageId: string, client: ChatSocket): void {
    let set = this.sockets.get(storageId);
    if (!set) {
      set = new Set();
      this.sockets.set(storageId, set);
    }
    set.add(client);
  }

  /**
   * Send an event to every live socket for a storage id. Returns true if at
   * least one open socket received it.
   */
  private deliver(storageId: string, event: string, data: unknown): boolean {
    const set = this.sockets.get(storageId);
    if (!set || set.size === 0) return false;
    let any = false;
    for (const socket of set) {
      if (this.send(socket, event, data)) any = true;
    }
    return any;
  }

  /** Drain and deliver anything queued for this user, then delete it. */
  private async flushPending(
    client: ChatSocket,
    storageId: string,
  ): Promise<void> {
    const queued = await this.chat.drain(storageId);
    if (queued.length === 0) return;
    const delivered: number[] = [];
    for (const item of queued) {
      const ok = this.send(client, 'message', {
        from: item.fromUsername,
        envelope: item.envelope,
        ts: item.createdAt.getTime(),
        queued: true,
      });
      if (ok) delivered.push(item.id);
    }
    await this.chat.deleteByIds(delivered);
  }

  private send(client: ChatSocket, event: string, data: unknown): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    try {
      client.send(JSON.stringify({ event, data }));
      return true;
    } catch (err) {
      this.logger.warn(`Failed to send ${event}: ${err}`);
      return false;
    }
  }

  private close(client: ChatSocket, code: number, reason: string): void {
    try {
      client.close(code, reason);
    } catch {
      /* already closing */
    }
  }
}
