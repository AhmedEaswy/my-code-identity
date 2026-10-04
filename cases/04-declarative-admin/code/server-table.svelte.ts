import { createQuery, keepPreviousData, useQueryClient } from './query';
import {
	getCoreRowModel,
	type ColumnDef,
	type PaginationState,
	type RowSelectionState,
	type SortingState,
	type Updater,
	type VisibilityState
} from './table-core';
import { goto, currentUrl } from './runtime';
import type { ListResult } from './resource-api';
import type { QueryParams } from './api-types';
import { bindTable } from './table-options.svelte';
import {
	activeFilterCount,
	compactFilters,
	defaultListState,
	parseListState,
	sameListState,
	toApiQuery,
	writeListState,
	type FilterValues,
	type ListState,
	type ListStateConfig
} from './list-state';

export interface ServerTableOptions<Row> {
	/** Cache prefix, e.g. `['items', 'list']`; the API query is appended to it. */
	queryKey: () => readonly unknown[];
	fetch: (query: QueryParams, signal: AbortSignal) => Promise<ListResult<Row>>;
	columns: () => ColumnDef<Row, unknown>[];
	state: ListStateConfig;
	/** Fixed params merged into every request (scoped endpoints, embedded tables). */
	baseQuery?: () => QueryParams;
	/** Mirror page/search/sort/filters into the URL (default true; embedded tables use false). */
	syncUrl?: boolean;
	enabled?: () => boolean;
	enableSort?: boolean;
	enableRowSelection?: boolean | ((row: Row) => boolean);
	/** Persist column visibility under this key; omit to keep it only in memory. */
	columnVisibilityKey?: string;
	/** Column ids hidden until the user shows them. */
	defaultHidden?: readonly string[];
	getRowId?: (row: Row, index: number) => string;
}

const apply = <T>(updater: Updater<T>, current: T): T =>
	typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;

function loadVisibility(key: string | undefined, defaultHidden: readonly string[] = []) {
	const initial: VisibilityState = Object.fromEntries(defaultHidden.map((id) => [id, false]));
	if (!key || typeof localStorage === 'undefined') return initial;
	try {
		const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
		if (stored && typeof stored === 'object') return { ...initial, ...stored } as VisibilityState;
	} catch {
		// A corrupt entry falls back to the declared defaults.
	}
	return initial;
}

/**
 * Server-side list: the query cache fetches `fetch(apiQuery)`, the table core
 * renders it in manual mode. Page, size, search, sort and filters live in the
 * URL; the table mirrors them, it does not own them.
 */
export function createServerTable<Row>(options: ServerTableOptions<Row>) {
	const cfg = options.state;
	const syncUrl = options.syncUrl ?? true;
	const queryClient = useQueryClient();

	// When synced, the URL is the source of truth. Local state exists only so an
	// embedded table (syncUrl: false) can page without touching the host URL.
	let localState = $state<ListState>(defaultListState(cfg));
	const listState = $derived(syncUrl ? parseListState(currentUrl().searchParams, cfg) : localState);

	function setListState(next: ListState) {
		// A no-op change must not push a history entry.
		if (sameListState(next, listState, cfg)) return;
		if (!syncUrl) {
			localState = next;
			return;
		}
		const qs = writeListState(next, cfg, currentUrl().searchParams).toString();
		void goto(`${currentUrl().pathname}${qs ? `?${qs}` : ''}`, {
			keepFocus: true,
			noScroll: true
		});
	}

	const apiQuery = $derived(toApiQuery(listState, options.baseQuery?.() ?? {}));

	const query = createQuery(() => ({
		queryKey: [...options.queryKey(), apiQuery],
		queryFn: ({ signal }) => options.fetch(apiQuery, signal),
		placeholderData: keepPreviousData,
		enabled: options.enabled?.() ?? true
	}));

	let visibility = $state<VisibilityState>(
		loadVisibility(options.columnVisibilityKey, options.defaultHidden)
	);

	// Selection belongs to one page/filter set: a different query shows different
	// rows, and a checkbox index means nothing across them.
	const queryId = $derived(JSON.stringify(apiQuery));
	let selection = $state<{ query: string; rows: RowSelectionState }>({ query: '', rows: {} });
	const rowSelection = $derived(selection.query === queryId ? selection.rows : {});

	const pagination = $derived<PaginationState>({
		pageIndex: listState.page - 1,
		pageSize: listState.limit
	});
	const sorting = $derived<SortingState>(
		listState.sort ? [{ id: listState.sort.key, desc: listState.sort.dir === 'desc' }] : []
	);

	const table = bindTable<Row>({
		get data() {
			return query.data?.rows ?? [];
		},
		get columns() {
			return options.columns();
		},
		get pageCount() {
			return query.data?.pagination.pageCount ?? -1;
		},
		get rowCount() {
			return query.data?.pagination.total;
		},
		getCoreRowModel: getCoreRowModel(),
		getRowId: options.getRowId ?? ((row, index) => String((row as { id?: unknown }).id ?? index)),
		manualPagination: true,
		manualSorting: true,
		manualFiltering: true,
		enableSorting: options.enableSort ?? false,
		enableSortingRemoval: true,
		enableRowSelection: (row) => {
			const rule = options.enableRowSelection ?? false;
			return typeof rule === 'function' ? rule(row.original) : rule;
		},
		state: {
			get pagination() {
				return pagination;
			},
			get sorting() {
				return sorting;
			},
			get columnVisibility() {
				return visibility;
			},
			get rowSelection() {
				return rowSelection;
			}
		},
		onPaginationChange: (updater) => {
			const next = apply(updater, pagination);
			const sizeChanged = next.pageSize !== listState.limit;
			setListState({
				...listState,
				page: sizeChanged ? 1 : next.pageIndex + 1,
				limit: next.pageSize
			});
		},
		onSortingChange: (updater) => {
			const [first] = apply(updater, sorting);
			setListState({
				...listState,
				page: 1,
				sort: first ? { key: first.id, dir: first.desc ? 'desc' : 'asc' } : null
			});
		},
		onColumnVisibilityChange: (updater) => {
			visibility = apply(updater, visibility);
			if (options.columnVisibilityKey) {
				try {
					localStorage.setItem(options.columnVisibilityKey, JSON.stringify(visibility));
				} catch {
					// Storage blocked: visibility still applies for this session.
				}
			}
		},
		onRowSelectionChange: (updater) => {
			selection = { query: queryId, rows: apply(updater, rowSelection) };
		}
	});

	return {
		table,
		query,
		get state() {
			return listState;
		},
		get apiQuery() {
			return apiQuery;
		},
		get rows() {
			return query.data?.rows ?? [];
		},
		get pagination() {
			return query.data?.pagination;
		},
		/** First load (no data yet). */
		get isLoading() {
			return query.isPending;
		},
		/** Any fetch in flight, including page changes over placeholder data. */
		get isFetching() {
			return query.isFetching;
		},
		get activeFilters() {
			return activeFilterCount(listState.filters);
		},
		get selectedRows(): Row[] {
			return table.getSelectedRowModel().rows.map((r) => r.original);
		},
		setPage(page: number) {
			setListState({ ...listState, page: Math.max(1, page) });
		},
		setLimit(limit: number) {
			setListState({ ...listState, limit, page: 1 });
		},
		setSearch(search: string) {
			setListState({ ...listState, search, page: 1 });
		},
		applyFilters(filters: Record<string, unknown>) {
			setListState({ ...listState, filters: compactFilters(filters), page: 1 });
		},
		removeFilters(names: readonly string[]) {
			const filters: FilterValues = { ...listState.filters };
			for (const name of names) delete filters[name];
			setListState({ ...listState, filters, page: 1 });
		},
		resetFilters() {
			setListState({ ...listState, filters: {}, page: 1 });
		},
		clearSelection() {
			selection = { query: queryId, rows: {} };
		},
		refetch() {
			return query.refetch();
		},
		/** Patch cached rows in place (a status flip that does not need a refetch). */
		patchRows(match: (row: Row) => boolean, patch: (row: Row) => Row) {
			queryClient.setQueriesData<ListResult<Row>>({ queryKey: options.queryKey() }, (old) =>
				old ? { ...old, rows: old.rows.map((row) => (match(row) ? patch(row) : row)) } : old
			);
		}
	};
}

export type ServerTable<Row> = ReturnType<typeof createServerTable<Row>>;
