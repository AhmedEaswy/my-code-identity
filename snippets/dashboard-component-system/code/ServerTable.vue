<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

/**
 * A server-paginated table described entirely by its columns. Each column
 * carries its own title, whether it is sortable, and the permission that
 * reveals it; the table derives the picker, the sort behaviour and the request
 * from that one list, so a column added on the API is one declaration here,
 * never three.
 *
 * The account's chosen columns are kept per table in `localStorage`. Because a
 * stored choice outlives a change of default, the cache key carries a version:
 * bumping it is the only way to retire a choice made under the old default.
 */

export interface TableColumn {
  key: string
  title: string
  /** Offered only to an account holding this permission; absent means public. */
  permission?: string
  sortable?: boolean
  /** Excluded from the picker and always shown, e.g. the row's name. */
  alwaysVisible?: boolean
}

const props = withDefaults(defineProps<{
  endpoint: string
  columns: TableColumn[]
  query?: Record<string, unknown>
  /** Names the table for its stored column choice; falls back to the endpoint. */
  name?: string
  defaultLimit?: number
  maxVisibleColumns?: number
  enableSort?: boolean
  prefetch?: boolean
  resultKey?: string
}>(), {
  query: () => ({}),
  name: '',
  defaultLimit: 25,
  maxVisibleColumns: 8,
  enableSort: false,
  prefetch: true,
  resultKey: '',
})

const emit = defineEmits<{ loaded: [] }>()

const { t } = useI18n({ useScope: 'global' })
const { can } = useAccess()

const canSee = (column: TableColumn): boolean => !column.permission || can(column.permission)

/**
 * A permission-gated column is not merely hidden: it never enters the list the
 * picker or the request can see, so a gated field cannot leak through a stored
 * choice made while it was permitted.
 */
const columns = computed(() => props.columns.filter(canSee))

const search = ref('')
const page = ref(1)
const limit = ref(props.defaultLimit)
const total = ref(0)
const loading = ref(false)
const fetched = ref(false)
const rows = ref<Record<string, unknown>[]>([])
const sortBy = ref<{ key: string, order: 'asc' | 'desc' } | null>(null)

/** What the rows on screen were fetched with, so an export asks for the same rows. */
const applied = ref<Record<string, unknown>>({})

let controller: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | null = null

const fetchData = async (): Promise<void> => {
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  fetched.value = false

  const query = {
    ...props.query,
    search: search.value || undefined,
    page: page.value,
    limit: limit.value,
    orderBy: props.enableSort ? sortBy.value?.key : undefined,
    sortBy: props.enableSort ? sortBy.value?.order : undefined,
  }

  try {
    const body = await $fetch<{ result?: Record<string, unknown> }>(
      props.endpoint,
      { query, signal: controller.signal },
    )
    const result = body.result ?? {}
    const data = props.resultKey ? result[props.resultKey] : result.data
    const pagination = result.pagination as { total?: number } | undefined
    rows.value = Array.isArray(data) ? data as Record<string, unknown>[] : []
    total.value = pagination?.total ?? 0
    applied.value = query
    fetched.value = true
  }
  catch (failure) {
    // A response that arrives after its request was abandoned answers a question
    // nobody is asking any more: drop it, do not redraw.
    if (!(failure instanceof Error && failure.name === 'AbortError'))
      throw failure
  }
  finally {
    if (!controller.signal.aborted)
      loading.value = false
  }

  emit('loaded')
}

const searchMethod = (): void => {
  if (timer)
    clearTimeout(timer)
  page.value = 1
  timer = setTimeout(fetchData, 300)
}

const onSort = (value: Array<{ key: string, order: 'asc' | 'desc' }>): void => {
  // A third click clears the sort, and the table emits an empty array for it:
  // keeping the old key would leave the server sorting by a column the header
  // no longer marks.
  sortBy.value = value[0] ?? null
  void fetchData()
}

const onPage = (value: number): void => {
  page.value = value
  void fetchData()
}

// An external query change (a link's parameter) resets to the first page.
watch(() => props.query, () => { page.value = 1; void fetchData() }, { deep: true })

// --- Column visibility, versioned -----------------------------------------

const COLUMN_CACHE_PREFIX = 'dashboard-table-columns-'
const COLUMN_CACHE_VERSION = 'v2'

/**
 * The previous generation is removed, not abandoned: a bump without this sweep
 * leaves one dead entry per table in every account's browser, and a third
 * generation would leave two.
 */
const retireOldColumnCaches = (): void => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(COLUMN_CACHE_PREFIX) && !key.startsWith(`${COLUMN_CACHE_PREFIX}${COLUMN_CACHE_VERSION}-`))
        localStorage.removeItem(key)
    }
  }
  catch {}
}

const cacheKey = computed(() => {
  const id = props.name || props.endpoint || columns.value.map(column => column.key).join(',')

  return `${COLUMN_CACHE_PREFIX}${COLUMN_CACHE_VERSION}-${id}`
})

const visibleKeys = ref<Set<string>>(new Set())
const pickerOpen = ref(false)

const dataColumns = computed(() => columns.value.filter(column => !column.alwaysVisible))
const hasManyColumns = computed(() => columns.value.length > props.maxVisibleColumns)

const initVisibility = (): void => {
  if (!hasManyColumns.value) {
    visibleKeys.value = new Set(columns.value.map(column => column.key))
    return
  }

  try {
    const raw = localStorage.getItem(cacheKey.value)
    const stored: string[] = raw ? JSON.parse(raw) : []
    // A stored key whose column no longer exists, or is no longer permitted, is
    // dropped rather than shown: the column list is the source of truth.
    const valid = stored.filter(key => columns.value.some(column => column.key === key))
    if (valid.length > 0) {
      visibleKeys.value = new Set(valid)
      return
    }
  }
  catch {}

  // Everything, by default. Hiding the tail meant a column as basic as the
  // row's status was invisible until someone found the picker.
  visibleKeys.value = new Set(columns.value.map(column => column.key))
}

const persist = (): void => {
  try {
    localStorage.setItem(cacheKey.value, JSON.stringify([...visibleKeys.value]))
  }
  catch {}
}

const toggleColumn = (key: string): void => {
  const next = new Set(visibleKeys.value)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  visibleKeys.value = next
  persist()
}

const headerList = computed(() => columns.value
  .filter(column => !hasManyColumns.value || column.alwaysVisible || visibleKeys.value.has(column.key))
  .map(column => ({ ...column, sortable: props.enableSort && !!column.sortable })))

retireOldColumnCaches()
watch(columns, initVisibility, { immediate: true })

onMounted(() => {
  if (props.prefetch)
    void fetchData()
})
</script>

<template>
  <VCard rounded="lg">
    <div class="d-flex justify-space-between align-center px-4 py-3">
      <VTextField
        v-model="search"
        :placeholder="t('dashboard.table.search')"
        prepend-inner-icon="tabler-search"
        hide-details
        @keyup="searchMethod"
      />

      <VBtn
        v-if="hasManyColumns"
        icon
        variant="text"
        @click="pickerOpen = true"
      >
        <VIcon icon="tabler-columns-3" />
      </VBtn>
    </div>

    <VDataTableServer
      :headers="headerList"
      :items="rows"
      :items-length="total"
      :items-per-page="limit"
      :page="page"
      :loading="loading"
      :disable-sort="!enableSort"
      item-value="id"
      @update:sort-by="onSort"
      @update:page="onPage"
    >
      <template #item.status="{ item }">
        <VChip size="small" variant="tonal">{{ item.status }}</VChip>
      </template>

      <template #bottom>
        <div class="d-flex justify-end pa-3 text-caption">
          {{ total }}
        </div>
      </template>
    </VDataTableServer>

    <VDialog v-model="pickerOpen" max-width="420">
      <VCard class="pa-4">
        <VCardTitle>{{ t('dashboard.table.showHideColumns') }}</VCardTitle>
        <VCardText>
          <VCheckbox
            v-for="column in dataColumns"
            :key="column.key"
            :model-value="visibleKeys.has(column.key)"
            :label="column.title"
            @update:model-value="toggleColumn(column.key)"
          />
        </VCardText>
      </VCard>
    </VDialog>
  </VCard>
</template>
