/**
 * Wire contract shared by the gateway and its tests.
 *
 * The gateway holds one WebSocket per tab and sends one subscribe frame per
 * channel. This module names the frames the server may send, the close codes
 * that mean the server refused this client for good rather than merely dropping
 * it, and the transport / credential / scheduler seams the gateway depends on.
 *
 * The seams are the point. A test swaps them to run a full connect → refuse →
 * reconnect story with no network, no timers and no signed-in session.
 */

/** A subscription address: `chat:{space}:{room}` or `presence:{space}:{room}`. */
export type Channel = `chat:${string}:${string}` | `presence:${string}:${string}`;

/** A domain event on a channel, stamped with the server's per-channel counter. */
export interface ServerEvent {
	readonly type: "event";
	readonly channel: string;
	readonly name: string;
	readonly payload: unknown;
	readonly occurredAt: string;
	readonly seq: number;
}

export interface ServerSubscribed {
	readonly type: "subscribed";
	readonly channel: string;
	readonly requestId: string;
}

export interface ServerUnsubscribed {
	readonly type: "unsubscribed";
	readonly channel: string;
	readonly requestId: string | null;
	/** Present exactly when `requestId` is null — the server took it away. */
	readonly reason?: Reason;
}

export interface ServerError {
	readonly type: "error";
	readonly requestId: string | null;
	readonly code: string;
	readonly messageKey: string;
	readonly message: string;
}

export interface ServerPong {
	readonly type: "pong";
	readonly requestId: string;
}

/**
 * A union rather than one shape with every field optional, so a handler that
 * reaches for `seq` on an error frame fails to compile instead of reading
 * `undefined` at runtime.
 */
export type ServerFrame =
	| ServerEvent
	| ServerSubscribed
	| ServerUnsubscribed
	| ServerError
	| ServerPong;

/** Why the server refused or revoked something. `message` is pre-translated. */
export interface Reason {
	readonly code: string;
	readonly messageKey: string;
	readonly message: string;
}

/**
 * The two close codes the server sends with a defined meaning. Everything else
 * is an ordinary drop.
 *
 * `UNAUTHORIZED` is ambiguous: it arrives both for a credential the server
 * rejects and for a healthy socket whose access token aged out under the
 * server's heartbeat. `AT_CAPACITY` is not: another connection has to close
 * before this one can open, and nothing this client does changes that.
 */
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_AT_CAPACITY = 4002;

export type CloseDisposition =
	| { readonly kind: "terminal"; readonly code: number }
	| { readonly kind: "reauthorize" }
	| { readonly kind: "drop" };

export function classifyClose(code: number | undefined): CloseDisposition {
	if (code === CLOSE_AT_CAPACITY) return { kind: "terminal", code };
	if (code === CLOSE_UNAUTHORIZED) return { kind: "reauthorize" };
	return { kind: "drop" };
}

/**
 * The subprotocol slot the server reads the bearer token from. A browser cannot
 * set an `Authorization` header on a WebSocket, so the token rides beside this
 * marker in the protocol list and the server lifts it back into a header.
 */
export const BEARER_SUBPROTOCOL = "chat.bearer";

/**
 * The slice of a socket the gateway uses. A DOM `WebSocket` is adapted to it in
 * `gateway.ts`; a test stub is a plain object whose handlers take the raw
 * payload, no event wrapper.
 */
export interface Transport {
	onopen: (() => void) | null;
	onmessage: ((payload: unknown) => void) | null;
	onclose: ((code: number | undefined) => void) | null;
	onerror: (() => void) | null;
	send(data: string): void;
	close(): void;
}

export type TransportFactory = (
	url: string,
	protocols: readonly string[],
) => Transport;

/**
 * Resolves the credential to present, or null when there is none.
 *
 * `refresh` is true only after the server refused the previous credential: the
 * provider is being asked for a *different* one, and returning the same token
 * (or null) is how it reports that there is nothing better to present.
 */
export type CredentialProvider = (options: {
	readonly refresh: boolean;
}) => Promise<string | null> | string | null;

/** Schedules one reconnect after `delayMs`; returns a cancel function. */
export type ReconnectScheduler = (
	delayMs: number,
	reconnect: () => void,
) => () => void;

export interface GatewayOptions {
	readonly url: string;
	readonly credential: CredentialProvider;
	readonly transport?: TransportFactory;
	readonly scheduleReconnect?: ReconnectScheduler;
	/** Called once when the server refuses the gateway for good. */
	readonly onRefused?: (code: number) => void;
	/** Called for any refusal other than UNAUTHORIZED, which the gateway owns. */
	readonly onError?: (reason: Reason) => void;
	/** Called when the server ends a subscription the client did not end. */
	readonly onRevoked?: (channel: string, reason: Reason | null) => void;
	/** Called when a socket opens again after a drop; the caller refetches. */
	readonly onReconnected?: () => void;
}

export function chatChannel(spaceId: string, roomId: string): Channel {
	return `chat:${spaceId}:${roomId}`;
}

export function presenceChannel(spaceId: string, roomId: string): Channel {
	return `presence:${spaceId}:${roomId}`;
}
