import { ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';
import { ChatBlockService } from './chat-block.service';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

type FakeSocket = {
  readyState: number;
  send: jest.Mock;
  close: jest.Mock;
  user?: unknown;
};

function socket(): FakeSocket {
  return { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
}

function req(cookie?: string): IncomingMessage {
  return { headers: cookie ? { cookie } : {} } as IncomingMessage;
}

function lastEvent(s: FakeSocket, n = 1) {
  const call = s.send.mock.calls[s.send.mock.calls.length - n];
  return call ? JSON.parse(call[0]) : null;
}

describe('ChatGateway', () => {
  let auth: { verifyToken: jest.Mock };
  let users: { findByUsername: jest.Mock };
  let chat: { enqueue: jest.Mock; drain: jest.Mock; deleteByIds: jest.Mock };
  let blocks: { isBlocked: jest.Mock };
  let config: { get: jest.Mock };
  let gw: ChatGateway;

  function build(chatEnabled = true) {
    auth = { verifyToken: jest.fn() };
    users = { findByUsername: jest.fn() };
    chat = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      drain: jest.fn().mockResolvedValue([]),
      deleteByIds: jest.fn().mockResolvedValue(undefined),
    };
    blocks = { isBlocked: jest.fn().mockResolvedValue(false) };
    config = { get: jest.fn().mockReturnValue({ chatEnabled }) };
    gw = new ChatGateway(
      auth as unknown as AuthService,
      users as unknown as UsersService,
      chat as unknown as ChatService,
      blocks as unknown as ChatBlockService,
      config as unknown as ConfigService,
    );
  }

  const authPayload = (over = {}) => ({
    sub: 1,
    username: 'alice',
    storageId: 'sid-alice',
    purpose: 'auth',
    ...over,
  });

  beforeEach(() => build());

  it('closes the socket when chat is disabled', async () => {
    build(false);
    const s = socket();
    await gw.handleConnection(s as unknown as WebSocket, req('wo_token=x'));
    expect(s.close).toHaveBeenCalledWith(4003, 'chat_disabled');
  });

  it('closes unauthenticated sockets', async () => {
    const s = socket();
    await gw.handleConnection(s as unknown as WebSocket, req());
    expect(s.close).toHaveBeenCalledWith(4001, 'unauthorized');
  });

  it('rejects a non-auth token purpose', async () => {
    auth.verifyToken.mockReturnValue(authPayload({ purpose: 'pending' }));
    const s = socket();
    await gw.handleConnection(s as unknown as WebSocket, req('wo_token=x'));
    expect(s.close).toHaveBeenCalledWith(4001, 'unauthorized');
  });

  it('registers an authenticated socket and sends ready', async () => {
    auth.verifyToken.mockReturnValue(authPayload());
    const s = socket();
    await gw.handleConnection(s as unknown as WebSocket, req('wo_token=x'));
    expect(s.close).not.toHaveBeenCalled();
    expect(lastEvent(s)).toEqual({
      event: 'ready',
      data: { username: 'alice' },
    });
  });

  it('flushes queued envelopes on connect, then deletes them', async () => {
    auth.verifyToken.mockReturnValue(authPayload());
    chat.drain.mockResolvedValue([
      { id: 9, fromUsername: 'bob', envelope: 'E', createdAt: new Date(5) },
    ]);
    const s = socket();
    await gw.handleConnection(s as unknown as WebSocket, req('wo_token=x'));
    const frames = s.send.mock.calls.map((c) => JSON.parse(c[0]));
    const msg = frames.find((f) => f.event === 'message');
    expect(msg.data).toMatchObject({
      from: 'bob',
      envelope: 'E',
      queued: true,
    });
    expect(chat.deleteByIds).toHaveBeenCalledWith([9]);
  });

  it('relays to an online recipient without queuing', async () => {
    // alice connects, bob connects.
    auth.verifyToken.mockReturnValueOnce(authPayload());
    const alice = socket();
    await gw.handleConnection(alice as unknown as WebSocket, req('wo_token=a'));
    auth.verifyToken.mockReturnValueOnce(
      authPayload({ sub: 2, username: 'bob', storageId: 'sid-bob' }),
    );
    const bob = socket();
    await gw.handleConnection(bob as unknown as WebSocket, req('wo_token=b'));

    users.findByUsername.mockResolvedValue({ storageId: 'sid-bob' });
    await gw.handleSend(alice as unknown as WebSocket, {
      to: 'bob',
      envelope: 'CIPHER',
      clientMsgId: 'm1',
    });

    const bobFrames = bob.send.mock.calls.map((c) => JSON.parse(c[0]));
    const delivered = bobFrames.find((f) => f.event === 'message');
    expect(delivered.data).toMatchObject({ from: 'alice', envelope: 'CIPHER' });
    expect(chat.enqueue).not.toHaveBeenCalled();
    expect(lastEvent(alice)).toMatchObject({
      event: 'sent',
      data: { clientMsgId: 'm1', ok: true, delivered: true },
    });
  });

  it('queues ciphertext when the recipient is offline', async () => {
    auth.verifyToken.mockReturnValue(authPayload());
    const alice = socket();
    await gw.handleConnection(alice as unknown as WebSocket, req('wo_token=a'));

    users.findByUsername.mockResolvedValue({ storageId: 'sid-bob' });
    await gw.handleSend(alice as unknown as WebSocket, {
      to: 'bob',
      envelope: 'CIPHER',
      clientMsgId: 'm2',
    });

    expect(chat.enqueue).toHaveBeenCalledWith('sid-bob', 'alice', 'CIPHER');
    expect(lastEvent(alice)).toMatchObject({
      event: 'sent',
      data: { clientMsgId: 'm2', ok: true, delivered: false, queued: true },
    });
  });

  it('silently drops (no deliver, no queue) when the recipient blocked the sender', async () => {
    auth.verifyToken.mockReturnValue(authPayload());
    const alice = socket();
    await gw.handleConnection(alice as unknown as WebSocket, req('wo_token=a'));
    users.findByUsername.mockResolvedValue({ storageId: 'sid-bob' });
    blocks.isBlocked.mockResolvedValue(true);
    await gw.handleSend(alice as unknown as WebSocket, {
      to: 'bob',
      envelope: 'CIPHER',
      clientMsgId: 'm5',
    });
    expect(chat.enqueue).not.toHaveBeenCalled();
    // Ack mirrors the offline case so the block is not disclosed.
    expect(lastEvent(alice)).toMatchObject({
      event: 'sent',
      data: { clientMsgId: 'm5', ok: true, delivered: false, queued: false },
    });
  });

  it('acks no_recipient for an unknown target', async () => {
    auth.verifyToken.mockReturnValue(authPayload());
    const alice = socket();
    await gw.handleConnection(alice as unknown as WebSocket, req('wo_token=a'));
    users.findByUsername.mockResolvedValue(null);
    await gw.handleSend(alice as unknown as WebSocket, {
      to: 'ghost',
      envelope: 'CIPHER',
      clientMsgId: 'm3',
    });
    expect(lastEvent(alice)).toMatchObject({
      event: 'sent',
      data: { ok: false, error: 'no_recipient' },
    });
    expect(chat.enqueue).not.toHaveBeenCalled();
  });

  it('rejects an oversized envelope', async () => {
    auth.verifyToken.mockReturnValue(authPayload());
    const alice = socket();
    await gw.handleConnection(alice as unknown as WebSocket, req('wo_token=a'));
    const big = 'x'.repeat(24 * 1024 * 1024 + 1);
    await gw.handleSend(alice as unknown as WebSocket, {
      to: 'bob',
      envelope: big,
      clientMsgId: 'm4',
    });
    expect(lastEvent(alice)).toMatchObject({
      event: 'sent',
      data: { ok: false, error: 'too_large' },
    });
    expect(users.findByUsername).not.toHaveBeenCalled();
  });
});
