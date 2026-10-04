import {
	createTable,
	type RowData,
	type TableOptions,
	type TableOptionsResolved,
	type TableState
} from './table-core';

type Merge<T extends readonly unknown[]> = (T extends [infer Head, ...infer Rest]
	? Head & Merge<Rest>
	: unknown) & {};

/**
 * Copies every source onto one target, but copies accessor properties as
 * accessors.
 *
 * This is the whole reason the table stays reactive. The table core takes a
 * plain options object and reads `options.data`, `options.columns` later, from
 * outside Svelte's reactive graph. Writing `{ ...options }` would evaluate those
 * getters once, here, and the table would keep the first snapshot forever.
 * Re-defining the getter on the target instead means every later read runs the
 * rune again — in whichever scope happened to ask for it.
 *
 * Plain values (callbacks, flags, booleans) are copied normally.
 */
export function mergeLive<Sources extends readonly unknown[]>(...sources: Sources): Merge<Sources> {
	const target = {};
	for (let i = 0; i < sources.length; i++) {
		let source = sources[i];
		if (typeof source === 'function') source = source();
		if (!source) continue;
		for (const key of Object.keys(source as object)) {
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (!descriptor) continue;
			if (descriptor.get) {
				Object.defineProperty(target, key, {
					enumerable: true,
					configurable: true,
					get: descriptor.get
				});
			} else {
				Object.defineProperty(target, key, {
					enumerable: true,
					configurable: true,
					writable: true,
					value: descriptor.value
				});
			}
		}
	}
	return target as Merge<Sources>;
}

/**
 * Svelte 5 adapter for a headless table core.
 *
 * The core is not rune-aware: it stores the options it is given and calls them
 * back. We keep our own `$state` in step with the table's internal state, and
 * re-apply the options in a `$effect.pre`, so a change to data, columns or page
 * is visible before the next paint rather than one frame late.
 */
export function bindTable<TData extends RowData>(options: TableOptions<TData>) {
	const resolved: TableOptionsResolved<TData> = mergeLive(
		{
			state: {},
			onStateChange() {},
			renderFallbackValue: null,
			mergeOptions: (base: TableOptions<TData>, override: Partial<TableOptions<TData>>) =>
				mergeLive(base, override)
		},
		options
	);

	const table = createTable(resolved);
	let state = $state<Partial<TableState>>(table.initialState);

	function sync() {
		table.setOptions((previous) =>
			mergeLive(previous, options, {
				state: mergeLive(state, options.state || {}),
				onStateChange: (updater: unknown) => {
					if (updater instanceof Function) state = updater(state);
					else state = mergeLive(state, updater);
					options.onStateChange?.(updater as never);
				}
			})
		);
	}

	sync();
	$effect.pre(() => sync());

	return table;
}
