import { createAdaptorServer, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";

/**
 * Fly Proxy dials each machine on private IPv4, so the process must listen on
 * 0.0.0.0. Peer stats use `<id>.vm.<app>.internal`, which is a 6PN AAAA record.
 * Node's 0.0.0.0 socket does not accept that IPv6 connection (ECONNREFUSED on
 * fdaa:…). Binding only `::` is not enough either: without IPV6_V6ONLY the
 * kernel may map IPv4 onto that socket and the 0.0.0.0 bind fails with
 * EADDRINUSE, and with bindv6only=1 a lone `::` socket drops Fly Proxy.
 *
 * Two sockets on the same port — 0.0.0.0, and `::` with IPV6_V6ONLY — cover
 * both paths. Flycast is not a substitute: it load-balances, and this app
 * sets force_https, which Flycast does not speak. Peer reads stay direct and
 * scope=local.
 */
export const IPV4_WILDCARD = "0.0.0.0";
export const IPV6_WILDCARD = "::";

export type HttpListenBinding = {
  host: typeof IPV4_WILDCARD | typeof IPV6_WILDCARD;
  family: "IPv4" | "IPv6";
  port: number;
};

export type HttpListenResult = {
  servers: ServerType[];
  bindings: HttpListenBinding[];
  /** Set when IPv6 could not be bound and requireIPv6 was false. */
  ipv6Error?: string;
};

type FetchHandler = Parameters<typeof createAdaptorServer>[0]["fetch"];

export type ListenHttpOptions = {
  fetch: FetchHandler;
  port: number;
  /** Fail if `[::]` cannot be bound. Set on Fly, where peer stats need 6PN. */
  requireIPv6?: boolean;
};

function listenOn(server: ServerType, port: number, host: string, ipv6Only: boolean): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`HTTP listen on ${host} returned no port`));
        return;
      }
      resolve(address);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, ipv6Only });
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export function formatListenBinding(binding: HttpListenBinding): string {
  const host = binding.host === IPV6_WILDCARD ? "[::]" : binding.host;
  return `${host}:${binding.port}`;
}

export async function listenHttp(options: ListenHttpOptions): Promise<HttpListenResult> {
  const ipv4 = createAdaptorServer({ fetch: options.fetch, hostname: IPV4_WILDCARD });
  let v4: AddressInfo;
  try {
    v4 = await listenOn(ipv4, options.port, IPV4_WILDCARD, false);
  } catch (error) {
    await closeServer(ipv4);
    throw error;
  }

  const bindings: HttpListenBinding[] = [
    { host: IPV4_WILDCARD, family: "IPv4", port: v4.port },
  ];
  const ipv6 = createAdaptorServer({ fetch: options.fetch, hostname: IPV4_WILDCARD });
  try {
    const v6 = await listenOn(ipv6, v4.port, IPV6_WILDCARD, true);
    bindings.push({ host: IPV6_WILDCARD, family: "IPv6", port: v6.port });
    return { servers: [ipv4, ipv6], bindings };
  } catch (error) {
    await closeServer(ipv6);
    const message = error instanceof Error ? error.message : String(error);
    if (options.requireIPv6) {
      await closeServer(ipv4);
      throw new Error(
        `IPv6 listen on [::]:${v4.port} failed; Fly 6PN peer stats need this socket. ${message}`,
        { cause: error },
      );
    }
    return { servers: [ipv4], bindings, ipv6Error: message };
  }
}
