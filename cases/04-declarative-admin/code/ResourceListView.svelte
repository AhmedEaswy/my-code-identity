<script lang="ts" generics="Row extends Record<string, unknown>">
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import PlusIcon from './icons/plus';
	import { currentSession } from './session.svelte';
	import { createQueryClient } from './query';
	import DataTable from './DataTable.svelte';
	import DataTablePagination from './DataTablePagination.svelte';
	import SearchInput from './SearchInput.svelte';
	import FilterDrawer from './FilterDrawer.svelte';
	import FilterChips from './FilterChips.svelte';
	import ColumnToggle from './ColumnToggle.svelte';
	import EmptyState from './EmptyState.svelte';
	import { buttonClass } from './ui/button';
	import { cn } from './utils';
	import type { Resource } from './define-resource';
	import { canPerform } from './permissions';
	import { createServerTable } from './server-table.svelte';
	import { allFilterParams, multiFilterParams, toDraft, filterChips } from './filters';

	/**
	 * The list page is generic: it renders whatever the resource declares. Search,
	 * the filter drawer, chips, the column toggle, the table and the pagination are
	 * all driven by the descriptor and the URL — this component names no resource,
	 * no column and no filter.
	 */
	interface Props {
		resource: Resource<Row, Record<string, unknown>>;
		/** Extra params for every request (embedded or scoped lists). */
		baseQuery?: Record<string, unknown>;
		/** Mirror state into the URL. Default true. */
		syncUrl?: boolean;
		/** Toolbar content after the built-in controls (exports, view switches). */
		toolbar?: Snippet;
		class?: string;
	}

	let { resource, baseQuery, syncUrl = true, toolbar, class: className }: Props = $props();

	const client = createQueryClient();
	const filters = resource.list.filters ?? [];
	const canCreate = $derived(
		!!resource.form && canPerform(resource, 'create', currentSession.permissions)
	);

	let drawerOpen = $state(false);
	let draft = $state<Record<string, unknown>>({});

	const list = createServerTable<Row>({
		queryKey: () => [...resource.cacheKey, 'list'],
		fetch: (query, signal) => resource.api.list(query, { signal }),
		columns: () => resource.list.columns(),
		state: {
			filterKeys: allFilterParams(filters),
			multiKeys: multiFilterParams(filters),
			defaultSort: resource.list.defaultSort ?? null
		},
		baseQuery: () => ({ ...resource.list.baseQuery, ...baseQuery }),
		syncUrl: untrack(() => syncUrl),
		enableSort: resource.list.enableSort ?? false,
		enableRowSelection: resource.list.selectable ?? false,
		columnVisibilityKey: `cols:${resource.slug}`,
		defaultHidden: resource.list.defaultHidden,
		getRowId: (row) => String(resource.idOf(row))
	});

	const chips = $derived(filterChips(filters, list.state.filters));
	const showColumnToggle = $derived(resource.list.columns().length > (resource.list.columnToggleFrom ?? 8));

	async function afterDelete(count: number) {
		// The last row of a page was removed: step back before refetching, or the
		// user lands on an empty page.
		if (list.rows.length <= count && list.state.page > 1) list.setPage(list.state.page - 1);
		await client.invalidateQueries({ queryKey: resource.cacheKey });
	}

	async function removeSelected() {
		const rows = list.selectedRows;
		for (const row of rows) await resource.api.remove(resource.idOf(row));
		list.clearSelection();
		await afterDelete(rows.length);
	}
</script>

<div class={cn('grid gap-4', className)} data-resource={resource.slug}>
	<div class="flex flex-wrap items-center gap-2">
		{#if resource.list.searchable !== false}
			<SearchInput
				value={list.state.search}
				onsearch={list.setSearch}
				placeholder={resource.list.searchPlaceholder?.() ?? 'Search'}
				class="w-full sm:max-w-xs"
			/>
		{/if}

		{#if filters.length}
			<FilterDrawer
				bind:open={drawerOpen}
				activeCount={list.activeFilters}
				onopen={() => (draft = toDraft(filters, list.state.filters))}
				onapply={() => {
					list.applyFilters(draft);
					drawerOpen = false;
				}}
				onreset={() => {
					draft = {};
					list.resetFilters();
					drawerOpen = false;
				}}
			/>
		{/if}

		{#if showColumnToggle}
			<ColumnToggle table={list.table} />
		{/if}

		{#if toolbar}
			<div class="ms-auto flex items-center gap-2">{@render toolbar()}</div>
		{/if}
	</div>

	{#if chips.length}
		<FilterChips
			{chips}
			onremove={(chip) => list.removeFilters(chip.names)}
			onclear={list.resetFilters}
		/>
	{/if}

	<DataTable
		table={list.table}
		loading={list.isLoading}
		fetching={list.isFetching}
		error={list.query.error}
		onretry={list.refetch}
		label={resource.labels.title()}
	>
		{#snippet empty()}
			<EmptyState title={`No ${resource.labels.plural()} yet`}>
				{#snippet action()}
					{#if canCreate}
						<a href={resource.routes.create} class={buttonClass({ size: 'sm' })}
							><PlusIcon aria-hidden="true" /> Add {resource.labels.singular()}</a
						>
					{/if}
				{/snippet}
			</EmptyState>
		{/snippet}
	</DataTable>

	{#if list.pagination && list.pagination.total > 0}
		<div class="border-t px-4 py-3">
			<DataTablePagination
				page={list.state.page}
				pageCount={list.pagination.pageCount}
				total={list.pagination.total}
				limit={list.state.limit}
				loading={list.isFetching}
				onpage={list.setPage}
				onlimit={list.setLimit}
			/>
		</div>
	{/if}
</div>
