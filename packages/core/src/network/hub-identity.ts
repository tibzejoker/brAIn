/**
 * Stable per-machine hub identity.
 *
 * The id is the same value the agent-presence layer uses as `agent_id`
 * (kv setting `api_agent_id`), so the snapshot channel and the
 * `brain.agents.<id>.*` control channel refer to the same hub. We resolve
 * it through the shared kv store rather than minting a fresh uuid per
 * boot — a peer that restarts must keep its identity or every other hub
 * would re-list it as a new machine.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { HubRef } from "@brain/sdk";
import type Database from "better-sqlite3";
import { getSetting, setSetting } from "../db";

/** kv key — kept as `api_agent_id` for back-compat with installs that
 *  already persisted one via agent-presence. */
const HUB_ID_KEY = "api_agent_id";

/** Read the persisted hub id, creating + storing one on first call. */
export function resolveHubId(db: Database.Database): string {
  let id = getSetting(db, HUB_ID_KEY);
  if (!id) {
    id = `${hostname()}-api-${randomBytes(4).toString("hex")}`;
    setSetting(db, HUB_ID_KEY, id);
  }
  return id;
}

/** Friendly label, overridable via `BRAIN_HUB_LABEL`; defaults to hostname. */
export function resolveHubLabel(): string {
  const fromEnv = process.env.BRAIN_HUB_LABEL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : hostname();
}

/**
 * Assemble the {@link HubRef} this instance advertises on the bus.
 * `httpUrls` is every candidate HTTP base (one per interface); the first
 * is surfaced as the single `http_url` for back-compat (join URI, older
 * peers), the full list as `http_urls` for consumers to probe.
 */
export function buildHubRef(db: Database.Database, httpUrls: string[] = []): HubRef {
  return {
    hub_id: resolveHubId(db),
    hub_label: resolveHubLabel(),
    http_url: httpUrls[0],
    http_urls: httpUrls.length > 0 ? httpUrls : undefined,
  };
}
