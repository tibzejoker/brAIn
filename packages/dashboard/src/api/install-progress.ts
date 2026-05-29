/**
 * Module-level "which repos have an install/uninstall in flight" store.
 *
 * The Marketplace tab is conditionally rendered (App unmounts it on tab
 * switch), so component-local install state would vanish the moment you
 * navigate away — and the spinner would be gone when you came back even
 * though the backend git clone/rm is still running. Hoisting the set out
 * of the React tree into this module keeps it alive across mounts; the
 * install promise's `finally` clears it whether or not the panel is
 * currently mounted.
 */
import { useSyncExternalStore } from "react";

const busy = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(): void {
  // Fresh immutable snapshot so useSyncExternalStore sees a new reference
  // only when the set actually changes (stable identity between emits).
  snapshot = new Set(busy);
  for (const l of listeners) l();
}

/** Mark a repo as busy (install/uninstall in flight) or clear it. */
export function setRepoBusy(repo: string, on: boolean): void {
  if (on) busy.add(repo); else busy.delete(repo);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): ReadonlySet<string> {
  return snapshot;
}

/** Reactive view of the repos with an install/uninstall in flight. */
export function useBusyRepos(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
