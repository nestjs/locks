import { connect, type Socket } from 'node:net';

type Reply = string | number | null | Reply[];

/**
 * A minimal Redis client (RESP2 over TCP), with the one method `RedisLockStore` calls:
 * `eval()`, which has the same signature as ioredis's. It keeps this example free of
 * dependencies; in your application, use ioredis (`new Redis(process.env.REDIS_URL)`).
 */
export class RedisClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private buffer = Buffer.alloc(0);
  private readonly pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void }[] = [];

  constructor(private readonly url: string) {}

  /** `EVAL script numKeys ...keys ...args`: runs a Lua script atomically. */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    return this.command('EVAL', script, numKeys, ...args);
  }

  async command(...args: (string | number)[]): Promise<Reply> {
    const socket = await this.connection();
    const parts = args.map(String);
    const payload = `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
    return new Promise<Reply>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      socket.write(payload);
    });
  }

  async quit(): Promise<void> {
    if (!this.socket && !this.connecting) return;
    await this.command('QUIT').catch(() => undefined);
    this.socket?.destroy();
    this.socket = undefined;
    this.connecting = undefined;
  }

  private connection(): Promise<Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    this.connecting ??= new Promise<Socket>((resolve, reject) => {
      const { hostname, port } = new URL(this.url);
      const socket = connect({ host: hostname, port: Number(port || 6379) });
      socket.once('connect', () => {
        this.socket = socket;
        resolve(socket);
      });
      socket.once('error', (error) => {
        this.connecting = undefined;
        reject(error);
      });
      socket.on('data', (chunk) => this.receive(chunk));
      socket.on('close', () => {
        this.socket = undefined;
        this.connecting = undefined;
        for (const { reject } of this.pending.splice(0)) reject(new Error('Redis connection closed'));
      });
    });
    return this.connecting;
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parse(this.buffer, 0);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.end);
      const waiter = this.pending.shift();
      if (parsed.value instanceof Error) waiter?.reject(parsed.value);
      else waiter?.resolve(parsed.value);
    }
  }
}

/** One RESP2 reply starting at `offset`, or undefined when it hasn't fully arrived. */
function parse(buffer: Buffer, offset: number): { value: Reply | Error; end: number } | undefined {
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return undefined;
  const type = String.fromCharCode(buffer[offset]!);
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;
  switch (type) {
    case '+':
      return { value: line, end: next };
    case '-':
      return { value: new Error(line), end: next };
    case ':':
      return { value: Number(line), end: next };
    case '$': {
      const length = Number(line);
      if (length === -1) return { value: null, end: next };
      if (buffer.length < next + length + 2) return undefined;
      return { value: buffer.toString('utf8', next, next + length), end: next + length + 2 };
    }
    case '*': {
      const count = Number(line);
      if (count === -1) return { value: null, end: next };
      const items: Reply[] = [];
      let end = next;
      for (let i = 0; i < count; i++) {
        const item = parse(buffer, end);
        if (!item) return undefined;
        if (item.value instanceof Error) return item;
        items.push(item.value);
        end = item.end;
      }
      return { value: items, end };
    }
    default:
      return { value: new Error(`Unexpected Redis reply type "${type}"`), end: buffer.length };
  }
}
