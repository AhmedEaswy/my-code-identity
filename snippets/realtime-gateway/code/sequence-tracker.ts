/**
 * Per-channel sequence tracking and dropped-frame detection.
 *
 * The server stamps every event on a channel with a monotonic `seq`. Keeping
 * the last one seen per channel is what lets a handler tell an in-order frame
 * from one that arrived after unknown predecessors were lost. The distinction
 * matters because the two need opposite responses: an in-order frame can be
 * applied, while a frame behind a gap must not be, because the state it would
 * be applied to is already missing however many frames went before it.
 *
 * The whole reason the counter is carried to the client is so a non-zero gap
 * can force a refetch of the channel instead of a patch.
 */
export class SequenceTracker {
	private readonly last = new Map<string, number>();

	/**
	 * Forgets every channel. Called on each (re)connect: the server's counter
	 * does not restart with the socket, so the distance from a previous
	 * socket's last `seq` is not a number of frames this client can claim it
	 * missed. The reconnect itself is already the caller's cue to refetch, and
	 * the first frame it sees reports a gap of zero.
	 */
	reset(): void {
		this.last.clear();
	}

	/** Forgets one channel, e.g. after the server revoked a subscription. */
	forget(channel: string): void {
		this.last.delete(channel);
	}

	/**
	 * Records `seq` for `channel` and returns how many frames preceded it
	 * unobserved, or `0` in the normal case.
	 *
	 * A first-ever frame is never a gap. A frame whose `seq` is at or below the
	 * last one is a duplicate or a reorder, not a run of missing frames, so it
	 * also returns `0` — neither is a distance the caller can act on by
	 * refetching.
	 */
	observe(channel: string, seq: number): number {
		const previous = this.last.get(channel);
		this.last.set(channel, seq);

		if (previous === undefined || seq <= previous) {
			return 0;
		}
		return seq - previous - 1;
	}
}
