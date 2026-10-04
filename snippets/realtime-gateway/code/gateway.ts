/**
 * A tab-scoped realtime gateway.
 *
 * One socket per tab, one subscribe frame per channel, lazy connect on the
 * first subscription. It carries four policies that are easy to get subtly
 * wrong:
 *
 *   1. the access token rides as a WebSocket subprotocol, because a browser
 *      cannot set an `Authorization` header on a handshake (`protocol.ts`);
 *   2. a refusal is classified by its close code, and the ambiguous one is told
 *      apart by the credential itself (refresh once, reconnect only on change);
 *   3. every event's per-channel `seq` is tracked so a dropped frame becomes a
 *      refetch rather than a silent patch of stale state;
 *   4. reconnect schedules back off and cap, and a teardown stops the loop.
 *
 * The transport, the reconnect scheduler and the credential are injectable, so
 * a test can drive a whole connect / refuse / reconnect story with no network,
 * no real timers and no session.
 */

import {
	BEARER_SUBPROTOCOL,
	CLOSE_UNAUTHORIZED,
	classifyClose,
	type Channel,
	type GatewayOptions,
	type ServerEvent,
	type ServerFrame,
	type Transport,
	type TransportFactory,
} from "./protocol";
import { SequenceTracker } from "./sequence-tracker";

/** An event delivered to a subscriber, with its computed gap. */
export interface EventMessage {
	channel: string;
	name: string;
	payload: unknown;
	occurredAt: string;
	seq: number;
	/** Frames the server sent on this channel that this client never saw. */
	gap: number;
}

export type EventHandler = (message: EventMessage) => void;
export type Unsubscribe = () => void;

/** First reconnect delay before jitter; doubles per consecutive attempt. */
const BACKOFF_BASE_MS = 500;
/** Upper bound for any reconnect delay, jitter included. */
const BACKOFF_MAX_MS = 30_000;

/**
 * Adapts the DOM `WebSocket` — whose events arrive wrapped — to the plain
 * `Transport` seam the gateway speaks. The handlers are read lazily through the
 * adapter, so the gateway can set them after the factory returns.
 */
const defaultTransport: TransportFactory = (url, protocols) => {
	const socket = new WebSocket(url, [...protocols]);
	const adapter: Transport = {
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
		send: (data) => socket.send(data),
		close: () => socket.close(),
	};
	socket.onopen = () => adapter.onopen?.();
	socket.onmessage = (event) => adapter.onmessage?.(event.data);
	socket.onclose = (event) => adapter.onclose?.(event.code);
	socket.onerror = () => adapter.onerror?.();
	return adapter;
};

const defaultScheduleReconnect = (delayMs: number, reconnect: () => void) => {
	const timer = setTimeout(reconnect, delayMs);
	return () => clearTimeout(timer);
};

function parseFrame(raw: unknown): ServerFrame | null {
	if (typeof raw !== "string") return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const frame = parsed as Record<string, unknown>;
	return typeof frame.type === "string"
		? (frame as unknown as ServerFrame)
		: null;
}

export class RealtimeGateway {
	private readonly options: GatewayOptions;
	private readonly listeners = new Map<string, Set<EventHandler>>();
	/** The socket currently being opened or open (the retry guard). */
	private transport: Transport | null = null;
	/** The socket the server has accepted subscribe frames on, if any. */
	private live: Transport | null = null;
	/**
	 * The credential presented on the current (or last) attempt. After a
	 * refusal it is what a refreshed credential is compared against: a gateway
	 * never presents the same refused credential twice, which is what makes a
	 * permanent "no" stop instead of spin.
	 */
	private presentedToken: string | null = null;
	/** A token a refusal already resolved, waiting for its reconnect to use it. */
	private pendingToken: string | null = null;
	/** The in-flight refresh, shared by concurrent refusals (single-flight). */
	private refreshInFlight: Promise<string | null> | null = null;
	private reconnectAttempt = 0;
	private cancelReconnect: (() => void) | null = null;
	/**
	 * The code the server last refused this gateway with, or null. Set from a
	 * terminal close and cleared only by an explicit teardown, so a refused
	 * gateway stays quiet instead of reconnecting on the next subscription.
	 */
	private refusedCode: number | null = null;
	private stopped = true;
	/** Whether a socket has opened since the last teardown (reconnect cue). */
	private hasOpened = false;
	private readonly sequences = new SequenceTracker();
	private requestCounter = 0;
	/** Guards two overlapping initial connects while a credential resolves. */
	private connecting = false;

	constructor(options: GatewayOptions) {
		this.options = options;
	}

	/** Whether a socket is open and has been sent its subscribe frames. */
	isConnected(): boolean {
		return this.live !== null;
	}

	/**
	 * Subscribes one handler to one channel, connecting lazily on the first
	 * subscription. The returned function removes the handler and tears the
	 * gateway down once the last handler leaves.
	 */
	subscribe(channel: Channel, handler: EventHandler): Unsubscribe {
		let set = this.listeners.get(channel);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(channel, set);
		}
		set.add(handler);

		// Already connected: this channel alone needs a frame. Otherwise the
		// open handler sends one for every channel the moment it opens.
		if (this.live !== null && set.size === 1) {
			this.send(this.live, "subscribe", channel);
		}
		void this.connect();

		return () => {
			const current = this.listeners.get(channel);
			if (current === undefined) return;

			current.delete(handler);
			if (current.size === 0) {
				this.listeners.delete(channel);
				// Stop the server fanning out a channel nobody reads. A gateway
				// that only stopped dispatching locally would keep paying for
				// frames it discards.
				if (this.live !== null) {
					this.send(this.live, "unsubscribe", channel);
				}
			}
			if (this.listeners.size === 0) this.close();
		};
	}

	/**
	 * Clean teardown: closes the socket, cancels a pending reconnect and drops
	 * every subscription. Runs automatically when the last subscription is
	 * removed; a torn-down gateway never retries in the background.
	 */
	close(): void {
		this.stopped = true;
		this.hasOpened = false;

		if (this.cancelReconnect !== null) {
			this.cancelReconnect();
			this.cancelReconnect = null;
		}
		this.reconnectAttempt = 0;

		// A teardown is the one thing that clears a refusal: whatever made the
		// server say no (no credential, too many sockets) is resolved by signing
		// in or closing a tab, and the next subscribe after that may try again.
		this.refusedCode = null;
		this.presentedToken = null;
		this.pendingToken = null;
		this.refreshInFlight = null;
		this.listeners.clear();
		this.live = null;

		const closing = this.transport;
		this.transport = null;
		closing?.close();
	}

	private connect(): void {
		if (this.listeners.size === 0 || this.refusedCode !== null) return;
		if (
			this.transport !== null ||
			this.cancelReconnect !== null ||
			this.connecting
		) {
			return;
		}
		this.stopped = false;

		// A retry after a refusal already resolved the credential it will
		// present. Resolving again here would spend a second refresh and, worse,
		// present something other than the token the retry decided on.
		const ready = this.pendingToken;
		if (ready !== null) {
			this.pendingToken = null;
			this.openWith(ready);
			return;
		}
		this.resolveCredential(false, (token) => this.openWith(token));
	}

	private openWith(token: string | null): void {
		// Nobody is signed in, or the session cannot produce a credential. Not a
		// refusal to report — there is simply nothing to connect as, and the
		// next subscribe after a sign-in tries again.
		if (token === null || this.listeners.size === 0 || this.transport !== null) {
			return;
		}
		this.presentedToken = token;
		const factory = this.options.transport ?? defaultTransport;
		this.attach(factory(this.options.url, [BEARER_SUBPROTOCOL, token]));
	}

	private attach(next: Transport): void {
		this.transport = next;

		// Set by the server's error frame, which always precedes its refusal
		// close, so the close handler can tell a refusal from a drop even on a
		// transport that reports no close code at all.
		let refusedByFrame = false;

		next.onopen = () => {
			this.reconnectAttempt = 0;
			this.live = next;
			// A reconnect is already the caller's cue to refetch. The server's
			// per-channel counter does not restart with the socket, so the
			// distance from the previous socket's last `seq` is not a run of
			// frames this client can claim it missed.
			this.sequences.reset();
			// Every channel, every time: the server has no memory of what this
			// client was subscribed to before the drop.
			for (const channel of this.listeners.keys()) {
				this.send(next, "subscribe", channel);
			}
			if (this.hasOpened) this.options.onReconnected?.();
			this.hasOpened = true;
		};

		next.onmessage = (payload) => {
			const frame = parseFrame(payload);
			if (frame === null) return;

			if (frame.type === "error") {
				if (frame.code === "UNAUTHORIZED") {
					refusedByFrame = true;
					return;
				}
				// Every other code — a channel refused, a subscription or socket
				// limit, a slow consumer — used to vanish, leaving the tab
				// quietly subscribed to nothing. The server already translated
				// `message`; the caller decides whether to show it.
				this.options.onError?.({
					code: frame.code,
					messageKey: frame.messageKey,
					message: frame.message,
				});
				return;
			}

			// A subscription the server took away. The socket is still healthy,
			// so nothing else would ever say so; the channel would just go quiet.
			if (frame.type === "unsubscribed" && frame.requestId === null) {
				this.sequences.forget(frame.channel);
				this.options.onRevoked?.(frame.channel, frame.reason ?? null);
				return;
			}

			// Only events carry data. `subscribed` and `unsubscribed` name a
			// channel too, and handing those to handlers is how an ack gets
			// mistaken for a notification.
			if (frame.type === "event") {
				this.dispatch(frame);
			}
		};

		next.onclose = (code) => {
			if (this.transport === next) this.transport = null;
			if (this.live === next) this.live = null;
			this.handleClose(code, refusedByFrame);
		};

		next.onerror = () => next.close();
	}

	private handleClose(code: number | undefined, refusedByFrame: boolean): void {
		const disposition = classifyClose(code);
		if (disposition.kind === "terminal") {
			this.refuse(disposition.code);
			return;
		}
		if (disposition.kind === "reauthorize" || refusedByFrame) {
			this.retryWithFreshCredential();
			return;
		}
		if (!this.stopped && this.listeners.size > 0) {
			this.scheduleReconnect();
		}
	}

	/**
	 * A refused credential is retried exactly once, and only with a different
	 * one.
	 *
	 * The same close code means two different things: an access token that aged
	 * out under the server's heartbeat (healthy; a refreshed token reconnects),
	 * and a credential the server will not accept (retrying it is the loop).
	 * Asking for a fresh token and comparing it to the one just refused
	 * separates them without the gateway knowing anything about sessions.
	 */
	private retryWithFreshCredential(): void {
		if (this.stopped || this.listeners.size === 0) return;

		const refused = this.presentedToken;
		this.resolveCredential(true, (fresh) => {
			// Same token, or none: there is no better credential to present, and
			// reconnecting would replay the same refusal forever. Stop.
			if (fresh === null || fresh === refused) {
				this.refuse(CLOSE_UNAUTHORIZED);
				return;
			}
			this.presentedToken = fresh;
			this.pendingToken = fresh;
			if (!this.stopped && this.listeners.size > 0) {
				this.scheduleReconnect();
			}
		});
	}

	private refuse(code: number): void {
		this.refusedCode = code;
		this.options.onRefused?.(code);
	}

	/**
	 * Resolves the credential and continues with it.
	 *
	 * Deliberately not an `async` method: a provider that answers synchronously
	 * (a token already in hand, or a test stub) continues in the same tick, so
	 * `subscribe` still opens its socket before it returns. Only a provider that
	 * must go to the network — a refresh — defers, and `connecting` keeps a
	 * second attempt from starting while it does.
	 *
	 * A refresh is single-flight: two sockets can be refused at nearly the same
	 * moment, and they must share one refresh, or the provider rotates the
	 * credential twice and the second socket presents a token the first already
	 * spent.
	 */
	private resolveCredential(
		refresh: boolean,
		use: (token: string | null) => void,
	): void {
		if (refresh && this.refreshInFlight !== null) {
			void this.refreshInFlight.then(use, () => use(null));
			return;
		}

		let value: Promise<string | null> | string | null;
		try {
			value = this.options.credential({ refresh });
		} catch {
			// A credential that cannot be produced is the same as none: the
			// gateway stays quiet rather than connecting without one.
			use(null);
			return;
		}

		if (!(value instanceof Promise)) {
			use(value);
			return;
		}

		const pending = value.catch(() => null);
		if (refresh) this.refreshInFlight = pending;
		this.connecting = true;
		void pending.then((token) => {
			this.connecting = false;
			if (this.refreshInFlight === pending) this.refreshInFlight = null;
			use(token);
		});
	}

	private send(
		socket: Transport,
		type: "subscribe" | "unsubscribe",
		channel: string,
	): void {
		this.requestCounter += 1;
		try {
			socket.send(
				JSON.stringify({
					type,
					channel,
					requestId: `r${this.requestCounter}`,
				}),
			);
		} catch {
			// A send on a closing socket throws in some transports; the close
			// handler that follows decides what happens next.
		}
	}

	private scheduleReconnect(): void {
		if (this.cancelReconnect !== null) return;

		const backoff = Math.min(
			BACKOFF_BASE_MS * 2 ** this.reconnectAttempt,
			BACKOFF_MAX_MS,
		);
		const delay = Math.min(backoff * (0.5 + Math.random()), BACKOFF_MAX_MS);
		this.reconnectAttempt += 1;

		const schedule = this.options.scheduleReconnect ?? defaultScheduleReconnect;
		this.cancelReconnect = schedule(delay, () => {
			this.cancelReconnect = null;
			this.connect();
		});
	}

	private dispatch(frame: ServerEvent): void {
		const { channel, name, payload, occurredAt, seq } = frame;

		// Observe before the handler lookup so a channel nobody is currently
		// listening to still advances its counter; otherwise resubscribing
		// would report every frame sent in between as missed.
		const gap = this.sequences.observe(channel, seq);

		const set = this.listeners.get(channel);
		if (set === undefined) return;

		const message: EventMessage = {
			channel,
			name,
			payload,
			occurredAt,
			seq,
			gap,
		};
		for (const handler of set) {
			try {
				handler(message);
			} catch {
				// One throwing handler must not break the socket or its peers.
			}
		}
	}
}
