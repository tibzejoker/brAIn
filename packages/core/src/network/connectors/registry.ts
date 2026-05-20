/**
 * Connector registry — the facade over all {@link PeerConnector}
 * strategies. Callers hand it raw user input and get a normalised
 * {@link JoinDescriptor} without caring which transport matched. Register
 * new connectors (SSH, mDNS, …) once at startup and every paste box,
 * deep-link handler, and CLI flag picks them up for free.
 */
import type { JoinDescriptor, PeerConnector } from "./types";
import { UriConnector } from "./uri-connector";

export class ConnectorRegistry {
  private readonly connectors: PeerConnector[] = [];

  /** Add a strategy. Later registrations win ties (checked first). */
  register(connector: PeerConnector): this {
    this.connectors.unshift(connector);
    return this;
  }

  /** The connector that claims `input`, or null if none does. */
  resolve(input: string): PeerConnector | null {
    return this.connectors.find((c) => c.canParse(input)) ?? null;
  }

  /** Parse `input` with the first connector that claims it. */
  parse(input: string): JoinDescriptor | null {
    return this.resolve(input)?.parse(input) ?? null;
  }

  /** Registered connector names, in resolve order. */
  names(): string[] {
    return this.connectors.map((c) => c.name);
  }
}

/** Default registry, pre-loaded with the URI connector. Most callers use
 *  this; tests can build their own to register fakes in isolation. */
export function createDefaultConnectorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry().register(new UriConnector());
}
