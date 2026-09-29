export interface TunnelConfig {
  readonly port: number;
  readonly authtoken: string;
  readonly domain?: string;
}

export interface Tunnel {
  /** Public hostname without scheme, e.g. "abcd-12.ngrok-free.app". */
  readonly host: string;
  readonly url: string;
  close(): Promise<void>;
}

/** The part of an `@ngrok/ngrok` listener this service relies on. */
interface NgrokListener {
  url(): string | null;
  close(): Promise<void>;
}

export type ForwardFn = (config: {
  addr: number;
  authtoken: string;
  domain?: string;
}) => Promise<NgrokListener>;

async function defaultForward(): Promise<ForwardFn> {
  // Loaded lazily: the native ngrok binding is only needed when the tunnel is enabled.
  const ngrok = await import('@ngrok/ngrok');
  return (config) => ngrok.forward(config);
}

/** Opens an ngrok tunnel to the local port. ngrok retries the upstream, so this may run before listen(). */
export async function startTunnel(config: TunnelConfig, forward?: ForwardFn): Promise<Tunnel> {
  const open = forward ?? (await defaultForward());
  let listener: NgrokListener;
  try {
    listener = await open({ addr: config.port, authtoken: config.authtoken, domain: config.domain });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start the ngrok tunnel (check NGROK_AUTHTOKEN / NGROK_DOMAIN): ${reason}`);
  }

  const url = listener.url();
  if (!url) {
    await listener.close();
    throw new Error('ngrok started but did not report a public URL');
  }
  return { url, host: new URL(url).host, close: () => listener.close() };
}
