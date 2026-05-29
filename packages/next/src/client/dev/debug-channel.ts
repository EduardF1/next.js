import { NEXT_REQUEST_ID_HEADER } from '../components/app-router-headers'
import { InvariantError } from '../../shared/lib/invariant-error'

declare global {
  interface Window {
    /**
     * Test-only flag, set once this document's debug channel entry is durably
     * committed. Persistence is deferred to an idle callback and its write is
     * async, so exposing this flag is a deliberate compromise: it lets e2e
     * tests await persistence deterministically — rather than relying on
     * timing/idle hacks — while coupling only to "an entry was persisted" and
     * not to how or where it is stored. It resets naturally on each navigation
     * since every document gets a fresh window. Only set when
     * `process.env.__NEXT_TEST_MODE` is enabled.
     */
    __NEXT_DEBUG_CHANNEL_PERSISTED?: boolean
  }
}

export interface DebugChannelReadableWriterPair {
  readonly readable: ReadableStream<Uint8Array>
  readonly writer: WritableStreamDefaultWriter<Uint8Array>
}

const pairs = new Map<string, DebugChannelReadableWriterPair>()

const DB_NAME = '__next_debug_channel'
const STORE_NAME = 'channels'
const CREATED_AT_INDEX = 'createdAt'
const MAX_ENTRIES = 10

interface DebugChannelEntry {
  readonly requestId: string
  readonly createdAt: number
  readonly chunks: Uint8Array[]
}

function openDebugChannelDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE_NAME, {
        keyPath: 'requestId',
      })
      store.createIndex(CREATED_AT_INDEX, 'createdAt')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(req.error)
  })
}

/**
 * Resolves on the next idle period via `requestIdleCallback`, falling back to a
 * `setTimeout` where `requestIdleCallback` is unavailable.
 *
 * In test mode we pass a `timeout` so the callback reliably fires under
 * Playwright, where a timeout-less `requestIdleCallback` may otherwise never
 * run. Production stays timeout-less so persistence never forces a blocking
 * write during a busy period — it fires at genuine idle or is skipped.
 */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(
        () => resolve(),
        process.env.__NEXT_TEST_MODE ? { timeout: 100 } : undefined
      )
    } else {
      setTimeout(resolve, 0)
    }
  })
}

async function persistDebugChannelToIndexedDB(
  requestId: string,
  chunks: Uint8Array[]
): Promise<void> {
  let db: IDBDatabase
  try {
    db = await openDebugChannelDB()
  } catch {
    return
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)

      store.put({
        requestId,
        createdAt: Date.now(),
        chunks,
      } satisfies DebugChannelEntry)

      // Prune oldest entries beyond the cap to bound storage growth across tabs
      // and/or page loads. The createdAt index gives ordered traversal without
      // scanning, and the cursor deletes commit atomically with the put above.
      const countReq = store.count()
      countReq.onsuccess = () => {
        let entriesToDelete = countReq.result - MAX_ENTRIES
        if (entriesToDelete <= 0) {
          return
        }
        const cursorReq = store.index(CREATED_AT_INDEX).openCursor()
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor || entriesToDelete === 0) {
            return
          }
          cursor.delete()
          entriesToDelete--
          cursor.continue()
        }
      }

      tx.oncomplete = () => {
        if (process.env.__NEXT_TEST_MODE) {
          self.__NEXT_DEBUG_CHANNEL_PERSISTED = true
        }
        resolve()
      }
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // Best-effort: if persistence fails (quota, transaction abort, etc.), an
    // HTTP cache restore will fall back to location.reload() since no entry
    // will be found.
  } finally {
    db.close()
  }
}

function restoreDebugChannelFromIndexedDB(
  requestId: string
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let entry: DebugChannelEntry | undefined

      try {
        const db = await openDebugChannelDB()
        try {
          entry = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly')
            const store = tx.objectStore(STORE_NAME)
            const getReq: IDBRequest<DebugChannelEntry | undefined> =
              store.get(requestId)
            getReq.onsuccess = () => resolve(getReq.result)
            getReq.onerror = () => reject(getReq.error)
          })
        } finally {
          db.close()
        }
      } catch {
        // Treat any IDB failure as "no entry" and fall through to reload.
      }

      if (!entry) {
        // Debug channel can't be restored — missing debug chunks would block
        // hydration. Force a fresh page load from the server. Leave the stream
        // parked (no enqueue, no close) so the Flight client stays put until
        // the reload tears the document down, instead of synchronously erroring
        // with "Connection closed.".
        location.reload()
        return
      }

      for (const chunk of entry.chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

function wasServedFromCache(): boolean {
  try {
    // There is exactly one PerformanceNavigationTiming entry per page load.
    const entry = performance.getEntriesByType('navigation')[0]

    if (!entry) {
      return false
    }

    // HTTP cache restore detection isn't uniform across browsers, so we combine
    // two signals:
    //
    //   1. type === 'back_forward' — set on browser-history navigations
    //      (back/forward) in all three browsers, and on tab duplication in
    //      Chrome and Firefox. This only matters when scripts actually
    //      re-execute; a bfcache restore preserves the entire JS context and
    //      never reaches this code. The HMR WebSocket disqualifies bfcache in
    //      Chrome and Firefox, so back/forward falls back to an HTTP cache
    //      restore and we land here with this type set. Safari is more lenient
    //      and often still uses bfcache for back/forward despite the WebSocket,
    //      in which case this function isn't called and no recovery is needed.
    //   2. responseStart === 0 && responseEnd > 0 — Safari uses type='navigate'
    //      on tab duplication. It sets responseStart to 0 when no
    //      first-body-byte arrived over the network; fresh loads always have
    //      responseStart > 0.
    //
    // Neither fires on Firefox's fresh streaming load, where transferSize is
    // transiently 0. That case has type='navigate' with a non-zero
    // responseStart, so it correctly returns false and avoids a
    // location.reload() loop that earlier (transferSize-only) versions of this
    // check triggered.
    return (
      entry.type === 'back_forward' ||
      (entry.responseStart === 0 && entry.responseEnd > 0)
    )
  } catch {
    return false
  }
}

export function getOrCreateDebugChannelReadableWriterPair(
  requestId: string
): DebugChannelReadableWriterPair {
  let pair = pairs.get(requestId)

  if (!pair) {
    // Buffer chunks only for the initial document's debug channel, not for
    // client-side navigation requests. Persisted to IndexedDB once complete so
    // it can be restored when the browser serves the page from HTTP cache
    // (back-forward navigation, tab duplication, etc.).
    const chunks: Uint8Array[] | null = requestId === self.__next_r ? [] : null

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunks) {
          chunks.push(chunk.slice())
        }
        controller.enqueue(chunk)
      },
    })

    pair = { readable, writer: writable.getWriter() }
    pairs.set(requestId, pair)

    pair.writer.closed
      .then(async () => {
        if (!chunks) {
          return
        }
        // The initial document's debug stream closes while hydration is still
        // running, so persisting here would steal main-thread time from it.
        // Wait for genuine idle (no timeout): persistence is best-effort, so if
        // the page never idles before navigation we skip it and a later restore
        // falls back to a reload, rather than forcing a blocking write.
        await whenIdle()
        await persistDebugChannelToIndexedDB(requestId, chunks)
      })
      .catch(() => {
        // writer.closed rejected (e.g., stream aborted) — nothing to persist.
      })
      .finally(() => {
        pairs.delete(requestId)
        // Release the buffered chunk bytes once the channel is done, whether or
        // not we were able to persist them.
        if (chunks) {
          chunks.length = 0
        }
      })
  }

  return pair
}

export function createDebugChannel(
  requestHeaders: Record<string, string> | undefined
): {
  writable?: WritableStream
  readable?: ReadableStream
} {
  let requestId: string | undefined

  if (requestHeaders) {
    requestId = requestHeaders[NEXT_REQUEST_ID_HEADER] ?? undefined

    if (!requestId) {
      throw new InvariantError(
        `Expected a ${JSON.stringify(NEXT_REQUEST_ID_HEADER)} request header.`
      )
    }
  } else {
    requestId = self.__next_r

    if (!requestId) {
      throw new InvariantError(
        `Expected a request ID to be defined for the document via self.__next_r.`
      )
    }
  }

  // Only attempt to restore the IndexedDB debug channel entry for the
  // initial document load (no request headers). Client-side navigations pass
  // request headers and should always use the WebSocket-backed debug channel.
  if (!requestHeaders && wasServedFromCache()) {
    return { readable: restoreDebugChannelFromIndexedDB(requestId) }
  }

  const { readable } = getOrCreateDebugChannelReadableWriterPair(requestId)

  return { readable }
}
