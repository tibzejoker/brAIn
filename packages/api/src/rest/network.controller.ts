import { Controller, Get, Post, Delete, Body, Query, Param, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { BrainService, BrokerService, readBrokerPrefs, writeBrokerPrefs, readExternalBrokerPrefs, writeExternalBrokerPrefs, clearExternalBrokerPrefs, getDb, getSetting, setSetting, resolveHubId, resolveHubCanvasPos, type HistoryEntry, type ProviderStatus, type CLIStatus } from "@brain/core";
import { type Message, type NodeInfo, type NodeState } from "@brain/sdk";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { BROKER_PREFS_PATH, EXTERNAL_BROKER_PREFS_PATH, resolveSelfHttpUrls } from "../app.module";

/**
 * Discover the IPv4 addresses of this host's external interfaces.
 * `os.networkInterfaces()` is Node's cross-OS API — same shape on
 * macOS / Linux / Windows. We filter out loopback (127/8) since the
 * dashboard already exposes the broker's bind URL for that.
 */
function getLanIps(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

interface NodeSnapshot extends Omit<NodeInfo, "subscriptions"> {
  subscriptions: Array<{ id: string; pattern: string }>;
}

interface NetworkSnapshot {
  node_count: number;
  nodes: NodeSnapshot[];
}

@Controller("network")
export class NetworkController {
  constructor(
    private readonly brain: BrainService,
    private readonly broker: BrokerService,
  ) {}

  @Get()
  snapshot(
    @Query("state") state?: string,
    @Query("tags") tags?: string,
  ): NetworkSnapshot {
    const local = this.brain.getNetworkSnapshot({
      state: (state ?? "all") as NodeState | "all",
      tags: tags ? tags.split(",") : undefined,
    });

    // Union with peer hubs' live nodes (each tagged `owner_hub`), so the
    // dashboard renders one machine-grouped view. A local `remote` stub is
    // dropped when a peer's snapshot already carries that id — the peer is
    // authoritative for nodes it actually hosts.
    const remote = this.brain.network.mergedNodes();
    const remoteIds = new Set(remote.map((n) => n.id));
    const localKept = local.filter((n) => !(n.transport === "remote" && remoteIds.has(n.id)));

    const localSnaps: NodeSnapshot[] = localKept.map((n) => ({
      ...n,
      subscriptions: this.brain.bus.getSubscriptions(n.id),
      unread_count: this.brain.bus.getUnreadCount(n.id),
    }));
    // Remote nodes: this instance has no local bus subscriptions for them,
    // so derive the topic handles from the snapshot's own subscription list.
    const remoteSnaps: NodeSnapshot[] = remote.map((n) => ({
      ...n,
      subscriptions: n.subscriptions.map((s) => ({ id: `${n.id}:${s.topic}`, pattern: s.topic })),
    }));

    const nodes = [...localSnaps, ...remoteSnaps];
    return { node_count: nodes.length, nodes };
  }

  @Get("messages")
  messages(
    @Query("topic") topic?: string,
    @Query("from") from?: string,
    @Query("last") last?: string,
    @Query("min_criticality") minCriticality?: string,
    @Query("exclude") exclude?: string,
  ): Message[] {
    const lastN = last ? parseInt(last, 10) : undefined;
    const minCrit = minCriticality ? parseInt(minCriticality, 10) : undefined;
    // No exclude → fast path, let the bus apply `last` itself.
    if (!exclude) {
      return this.brain.bus.getMessageHistory({ topic, from, last: lastN, min_criticality: minCrit });
    }
    // With exclude we must filter BEFORE capping, or a window full of
    // infra topics (cursor/snapshot) would leave nothing meaningful. Pull
    // the full retained history, drop excluded topics, then take the last N.
    // Comma-separated; a trailing `*` is a prefix wildcard (`brain.network.*`).
    const patterns = exclude.split(",").map((s) => s.trim()).filter(Boolean);
    const blocked = (t: string): boolean =>
      patterns.some((p) => (p.endsWith("*") ? t.startsWith(p.slice(0, -1)) : t === p));
    const filtered = this.brain.bus
      .getMessageHistory({ topic, from, min_criticality: minCrit })
      .filter((m) => !blocked(m.topic));
    return lastN ? filtered.slice(-lastN) : filtered;
  }

  /**
   * Walk the causal chain for a given trace_id. Returns every message
   * that shares the trace, oldest first — used by the dashboard to
   * render conversation flows and by debug tools to replay an
   * interaction. 404 if no message in the in-memory history carries
   * that trace.
   */
  @Get("traces/:trace_id")
  trace(@Param("trace_id") traceId: string): Message[] {
    const chain = this.brain.bus.getTrace(traceId);
    if (chain.length === 0) {
      throw new HttpException(`trace not found: ${traceId}`, HttpStatus.NOT_FOUND);
    }
    return chain;
  }

  /**
   * Re-publish every message of a past trace as fresh emissions —
   * "replay this scenario". Each new message gets a new id and the
   * causal `parent_id` chain is rewritten under a new `trace_id`,
   * with `metadata.replayed_from` pointing back at the original.
   * 404 if the trace fell out of the bus history (sliding window).
   * `interval_ms` query param spaces emissions out for visualisation.
   */
  @Post("traces/:trace_id/replay")
  async replay(
    @Param("trace_id") traceId: string,
    @Query("interval_ms") intervalMs?: string,
  ): Promise<{ replayed: number; new_trace_id: string }> {
    const interval = intervalMs ? Math.max(0, parseInt(intervalMs, 10)) : undefined;
    const result = await this.brain.replayTrace(traceId, { intervalMs: interval });
    if (result.replayed === 0 || !result.new_trace_id) {
      throw new HttpException(`trace not found or empty: ${traceId}`, HttpStatus.NOT_FOUND);
    }
    return { replayed: result.replayed, new_trace_id: result.new_trace_id };
  }

  @Get("history")
  history(
    @Query("last") last?: string,
    @Query("action") action?: string,
    @Query("node_id") nodeId?: string,
    @Query("since") since?: string,
  ): HistoryEntry[] {
    return this.brain.getNetworkHistory({
      last: last ? parseInt(last, 10) : undefined,
      action: action as HistoryEntry["action"] | undefined,
      node_id: nodeId,
      since: since ? parseInt(since, 10) : undefined,
    });
  }

  @Post("seed")
  async seed(
    @Body("file") file?: string,
    @Body("merge") merge?: boolean,
  ): Promise<{ spawned: number; skipped: number; killed: number; installed: string[] }> {
    const seedPath = file ?? process.env.BRAIN_SEED_FILE ?? "./seed.yaml";
    try {
      return await this.brain.seed(seedPath, { merge });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post("reset")
  reset(): { killed: number } {
    const killed = this.brain.killAll();
    this.brain.resetDb();
    return { killed };
  }

  @Get("providers")
  providers(): { llm: ProviderStatus[]; cli: CLIStatus[] } {
    return this.brain.getProviderStatuses();
  }

  @Get("devmode")
  getDevMode(): { enabled: boolean } {
    return { enabled: this.brain.isDevMode() };
  }

  /**
   * Every topic currently visible across the merged network — union of every
   * node's `default_subscriptions[].topic` and `default_publishes[]`. Powers
   * the live-wiring autocomplete in the dashboard side panel. Wildcards
   * (`chat.response.*`, `memory.>`) are returned verbatim so the user can
   * pick them as-is. Sorted alphabetically, deduplicated. No payload schema
   * here — that lives on the subscriptions themselves and is enforced at
   * publish-time by the bus.
   */
  @Get("topics")
  listTopics(): { topics: string[] } {
    const set = new Set<string>();
    const localNodes = this.brain.instanceRegistry.list();
    const peerNodes = this.brain.network.mergedNodes();
    for (const n of [...localNodes, ...peerNodes]) {
      for (const s of n.subscriptions) set.add(s.topic);
      for (const p of n.default_publishes ?? []) set.add(p);
    }
    return { topics: [...set].sort() };
  }

  /**
   * Surface the bus broker info for the dashboard. `lan_ips` lists
   * this machine's IPv4 addresses (non-loopback) so the user can
   * build a URL reachable from another host without `ifconfig`.
   * `bind_address` is the persisted preference — the dashboard's
   * "Open to network" toggle flips it via POST /transport/bind.
   */
  @Get("transport")
  transport(): {
    url: string | null;
    mode: "embedded" | "external";
    bind_address: string;
    lan_ips: string[];
    token: string | null;
    /** This hub's stable id — lets the dashboard filter out its own
     *  presence cursor (never render your own pointer). */
    hub_id: string;
    /** Our own container position on the shared canvas (null until moved).
     *  Local nodes carry no owner_hub, so the dashboard reads our block
     *  placement from here. */
    canvas_pos: { x: number; y: number } | null;
    /** Our own externally-reachable HTTP base (best guess, first of
     *  `http_urls`) — used by the invite URI `&api=`. */
    http_url: string | null;
    /** All candidate HTTP bases (one per interface) for peers to probe. */
    http_urls: string[];
    /** When the API is joined to a remote hub via the persistent
     *  external-broker config file, surface its label + HTTP base so the
     *  dashboard can show "Connected to <hub>", route node UIs/spawn at
     *  it, and offer Disconnect. Null in embedded mode and when external
     *  was set via env var only. */
    joined_hub: { url: string; hubName?: string; http_url?: string } | null;
  } {
    const prefs = readBrokerPrefs(BROKER_PREFS_PATH);
    // Only expose the token in embedded mode — in external mode the
    // user owns the broker, we don't have a token to share.
    const token = this.broker.getMode() === "embedded"
      ? getSetting(getDb(), "broker_token")
      : null;
    const fileExternal = readExternalBrokerPrefs(EXTERNAL_BROKER_PREFS_PATH);
    return {
      url: this.broker.getUrl(),
      mode: this.broker.getMode(),
      bind_address: prefs.bindAddress,
      lan_ips: getLanIps(),
      token,
      hub_id: resolveHubId(getDb()),
      canvas_pos: resolveHubCanvasPos(getDb()) ?? null,
      http_url: resolveSelfHttpUrls()[0] ?? null,
      http_urls: resolveSelfHttpUrls(),
      joined_hub: fileExternal
        ? { url: fileExternal.url, hubName: fileExternal.hubName, http_url: fileExternal.httpUrl }
        : null,
    };
  }

  /**
   * Persist an external NATS broker as the API's bus and exit(0) so
   * the supervisor restarts in `external` mode. After restart this
   * dashboard joins the remote hub — every node + agent on that bus
   * becomes visible here, libs installed locally on either side
   * announce themselves through the same NATS topics.
   *
   * Idempotent for the same URL+token (returns restart_scheduled: false).
   */
  @Post("transport/external")
  joinExternal(
    @Body() body: { url?: string; token?: string; hubName?: string; httpUrl?: string; api?: string },
  ): { joined: boolean; restart_scheduled: boolean; url?: string } {
    const log = new Logger("NetworkController");
    const url = (body.url ?? "").trim();
    if (!url) throw new HttpException("url required", HttpStatus.BAD_REQUEST);
    if (!/^nats:\/\//i.test(url)) throw new HttpException("url must start with nats://", HttpStatus.BAD_REQUEST);
    const current = readExternalBrokerPrefs(EXTERNAL_BROKER_PREFS_PATH);
    const token = (body.token ?? "").trim() || undefined;
    const hubName = (body.hubName ?? "").trim() || undefined;
    // Accept `httpUrl` or the URI-style alias `api`. Lets the joined
    // dashboard reach the hub's node UIs + spawn endpoint over HTTP.
    const httpUrl = (body.httpUrl ?? body.api ?? "").trim() || undefined;
    if (current && current.url === url && current.token === token && current.hubName === hubName && current.httpUrl === httpUrl) {
      return { joined: true, restart_scheduled: false, url };
    }
    writeExternalBrokerPrefs(EXTERNAL_BROKER_PREFS_PATH, { url, token, hubName, httpUrl });
    log.log(`joining external broker ${url}; exiting in 200ms for restart`);
    setTimeout(() => { process.exit(0); }, 200);
    return { joined: true, restart_scheduled: true, url };
  }

  /**
   * Drop the persisted external-broker config and exit(0) so the
   * supervisor brings the API back in embedded mode (spawns its own
   * nats-server on a free local port).
   */
  @Delete("transport/external")
  leaveExternal(): { left: boolean; restart_scheduled: boolean } {
    const log = new Logger("NetworkController");
    const wasPresent = clearExternalBrokerPrefs(EXTERNAL_BROKER_PREFS_PATH);
    if (!wasPresent) {
      // Nothing to leave — caller is already in embedded mode.
      return { left: false, restart_scheduled: false };
    }
    log.log("left external broker; exiting in 200ms for restart back to embedded");
    setTimeout(() => { process.exit(0); }, 200);
    return { left: true, restart_scheduled: true };
  }

  /**
   * Generate a fresh broker token, persist it, and exit so the
   * supervisor restarts the API with the new token. Existing agents
   * will lose their connection — they need the new token to
   * reconnect (intentional for credential rotation).
   */
  @Post("transport/rotate-token")
  rotateToken(): { rotated: boolean; restart_scheduled: boolean } {
    const log = new Logger("NetworkController");
    if (this.broker.getMode() !== "embedded") {
      throw new HttpException("rotate only valid for embedded broker", HttpStatus.BAD_REQUEST);
    }
    const fresh = randomBytes(32).toString("hex");
    setSetting(getDb(), "broker_token", fresh);
    log.log(`broker token rotated; exiting in 200ms for restart`);
    setTimeout(() => { process.exit(0); }, 200);
    return { rotated: true, restart_scheduled: true };
  }

  /**
   * Persist a new bind address ("127.0.0.1" or "0.0.0.0") and
   * exit(0) — relying on `nest start --watch` (dev) or pm2/systemd
   * (prod) to bring the API back with the new bind. The dashboard
   * sees the connection drop and polls until the new transport
   * info comes back.
   *
   * No-op when the request matches the existing preference.
   */
  @Post("transport/bind")
  bind(@Body("open") open: boolean): { bind_address: string; restart_scheduled: boolean } {
    const log = new Logger("NetworkController");
    const next = open ? "0.0.0.0" : "127.0.0.1";
    const current = readBrokerPrefs(BROKER_PREFS_PATH);
    if (current.bindAddress === next) {
      return { bind_address: next, restart_scheduled: false };
    }
    writeBrokerPrefs(BROKER_PREFS_PATH, { bindAddress: next });
    log.log(`broker bind preference changed → ${next}; exiting in 200ms for restart`);
    // Defer so the HTTP response can flush before we tear down.
    setTimeout(() => { process.exit(0); }, 200);
    return { bind_address: next, restart_scheduled: true };
  }

  @Post("devmode")
  setDevMode(@Body("enabled") enabled: boolean): { enabled: boolean } {
    this.brain.setDevMode(enabled);
    return { enabled: this.brain.isDevMode() };
  }

  @Post("tick")
  tickAll(): { ticked: number } {
    return { ticked: this.brain.tickAll() };
  }
}
