import { describe, it, expect } from "vitest";
import {
  UriConnector,
  ConnectorRegistry,
  createDefaultConnectorRegistry,
  type JoinDescriptor,
  type PeerConnector,
} from "@brain/core";

describe("UriConnector.parse", () => {
  const c = new UriConnector();

  it("parses a full brain://join deep link incl api + label", () => {
    const d = c.parse(
      "brain://join?url=nats://10.0.0.5:4222&token=deadbeef&api=http://10.0.0.5:3000&label=Studio",
    );
    expect(d).toEqual({
      nats_url: "nats://10.0.0.5:4222",
      token: "deadbeef",
      http_url: "http://10.0.0.5:3000",
      hub_label: "Studio",
    });
  });

  it("parses a brain:// link without optional parts", () => {
    expect(c.parse("brain://join?url=nats://h:4222")).toEqual({ nats_url: "nats://h:4222" });
  });

  it("rejects a brain:// link missing the nats url", () => {
    expect(c.parse("brain://join?token=x")).toBeNull();
  });

  it("parses the bash invite snippet", () => {
    const d = c.parse('BRAIN_NATS_URL=nats://host:4222 BRAIN_NATS_TOKEN=abc123 node run.js');
    expect(d).toEqual({ nats_url: "nats://host:4222", token: "abc123" });
  });

  it("parses a bare nats:// url", () => {
    expect(c.parse("nats://192.168.1.9:4222")).toEqual({ nats_url: "nats://192.168.1.9:4222" });
  });

  it("returns null on junk", () => {
    expect(c.parse("not a hub")).toBeNull();
    expect(c.parse("")).toBeNull();
  });
});

describe("UriConnector.format", () => {
  it("round-trips a descriptor through format → parse", () => {
    const c = new UriConnector();
    const desc: JoinDescriptor = {
      nats_url: "nats://10.0.0.5:4222",
      token: "tok",
      http_url: "http://10.0.0.5:3000",
      hub_label: "Lab",
    };
    expect(c.parse(c.format(desc))).toEqual(desc);
  });
});

describe("ConnectorRegistry", () => {
  it("default registry resolves URIs via the uri connector", () => {
    const reg = createDefaultConnectorRegistry();
    expect(reg.names()).toEqual(["uri"]);
    expect(reg.parse("nats://h:4222")).toEqual({ nats_url: "nats://h:4222" });
    expect(reg.resolve("nats://h:4222")?.name).toBe("uri");
    expect(reg.resolve("ssh://nope")).toBeNull();
  });

  it("lets a custom connector claim its scheme first", () => {
    const ssh: PeerConnector = {
      name: "ssh",
      canParse: (i) => i.startsWith("ssh://"),
      parse: () => ({ nats_url: "nats://tunneled:4222" }),
    };
    const reg = createDefaultConnectorRegistry().register(ssh);
    expect(reg.resolve("ssh://user@host")?.name).toBe("ssh");
    expect(reg.parse("ssh://user@host")).toEqual({ nats_url: "nats://tunneled:4222" });
    // URI connector still handles its own input.
    expect(reg.resolve("nats://h:4222")?.name).toBe("uri");
  });
});
