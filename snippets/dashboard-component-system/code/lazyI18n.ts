import { ref } from 'vue'

/**
 * A feature's text loads when the feature opens, never with the first page.
 * Each namespace is split in two files: the part read outside the feature's own
 * routes stays eager (`locales/<lang>/<namespace>.json`), the rest is its lazy
 * part (`locales/<lang>/lazy/<namespace>.json`), merged under the same
 * namespace once loaded. A test keeps the split and the map below honest.
 */
export const LAZY_NAMESPACES = ['analytics', 'actions', 'campaigns', 'audit', 'calendar', 'insights'] as const

export type LazyNamespace = typeof LAZY_NAMESPACES[number]

/** The one map: a route whose path starts with the prefix loads these namespaces before it draws. */
export const LAZY_ROUTES: Record<string, LazyNamespace[]> = {
  '/analytics': ['analytics', 'insights'],

  // The reports screen draws the analytics writers and its own chrome as they are.
  '/reports': ['insights', 'analytics'],
  '/campaigns': ['campaigns'],
  '/calendar': ['calendar', 'audit'],
}

export const lazyNamespacesFor = (path: string): LazyNamespace[] => [...new Set(Object.entries(LAZY_ROUTES)
  .filter(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))
  .flatMap(([, names]) => names))]

type LazyFile = () => Promise<{ default: Record<string, unknown> }>

const LOCALES = ['ar', 'en'] as const

/** Both languages, since the language switches without a reload. Each file is its own chunk, out of the entry. */
const FILES: Record<string, Record<string, LazyFile>> = {
  ar: import.meta.glob('./locales/ar/lazy/*.json') as Record<string, LazyFile>,
  en: import.meta.glob('./locales/en/lazy/*.json') as Record<string, LazyFile>,
}

export interface MessageTarget {
  global: { mergeLocaleMessage: (locale: string, messages: Record<string, unknown>) => void }
}

export function createMessageLoader(i18n: MessageTarget, files: Record<string, Record<string, LazyFile>> = FILES) {
  const loaded = new Set<string>()
  const loading = new Map<string, Promise<void>>()

  /** Moves once per landed namespace: a text read before it landed is drawn again. */
  const landed = ref(0)

  const load = (name: string): Promise<void> => {
    if (loaded.has(name))
      return Promise.resolve()

    const inFlight = loading.get(name)
    if (inFlight)
      return inFlight

    const task = Promise.all(LOCALES.map(locale => {
      const file = files[locale]?.[`./locales/${locale}/lazy/${name}.json`]

      return file ? file() : Promise.reject(new Error(`no lazy text for ${name} in ${locale}`))
    }))
      .then(modules => {
        modules.forEach((module, index) => i18n.global.mergeLocaleMessage(LOCALES[index], { [name]: module.default }))
        loaded.add(name)
        landed.value++
      })
      .catch(error => {
        // A chunk that failed (a deploy, a dropped connection) is asked for again next time; the page goes on.
        console.error(`[i18n] The text of "${name}" did not load; it is asked for again next time.`, error)
      })
      .finally(() => loading.delete(name))

    loading.set(name, task)

    return task
  }

  /** Loads both languages of each namespace, once. It never throws: a route always draws. */
  const loadMessages = async (names: readonly string[]): Promise<void> => {
    await Promise.all(names.map(load))
  }

  /**
   * vue-i18n's missing handler, the safety net: a key of a lazy namespace not
   * loaded yet starts its load and reads empty until it lands, never as the raw
   * key. Any other key reads as it always did.
   */
  const missing = (locale: string, key: string): string | void => {
    const name = key.split('.')[0]

    if ((LAZY_NAMESPACES as readonly string[]).includes(name) && !loaded.has(name)) {
      void landed.value
      load(name)

      return ''
    }

    if (import.meta.env.DEV)
      console.warn(`[intlify] Not found '${key}' key in '${locale}' locale messages.`)
  }

  return { loadMessages, missing }
}
