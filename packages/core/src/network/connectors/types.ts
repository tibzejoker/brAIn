/**
 * Pluggable transport connectors (Strategy pattern).
 *
 * A connector turns some *external representation* of "how to reach a
 * hub" into a normalised {@link JoinDescriptor}, and back. Today the only
 * representation is a `brain://join?...` URI (or the bash invite snippet);
 * tomorrow an `SshConnector` could parse `ssh://user@host` and tunnel the
 * NATS port. New connectors plug into the {@link ConnectorRegistry} facade
 * without any caller — dashboard or CLI — needing to know they exist.
 */

/** Normalised, transport-agnostic "how to join this hub" descriptor. */
export interface JoinDescriptor {
  /** NATS broker URL to connect the bus to. Always present. */
  nats_url: string;
  /** Bearer token for the broker, if it requires auth. */
  token?: string;
  /** HTTP base of the hub's API — needed to render its node UIs and
   *  route spawn/kill at the hub. Absent for older/url-only invites. */
  http_url?: string;
  /** Friendly label for the connection, shown in the UI. */
  hub_label?: string;
}

/**
 * A single transport strategy. `name` is a stable identifier for logs/UI
 * ("uri", "ssh", …). `canParse` is a cheap pre-check so the registry can
 * pick the right strategy; `parse` does the real work (and may still
 * return null on malformed input). `format` is the inverse — produce the
 * canonical string a peer can paste back — and is optional for connectors
 * that are parse-only.
 */
export interface PeerConnector {
  readonly name: string;
  canParse(input: string): boolean;
  parse(input: string): JoinDescriptor | null;
  format?(desc: JoinDescriptor): string;
}
