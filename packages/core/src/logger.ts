import pino from "pino";

export const logger = pino({
  name: "brain",
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 1 } }
      : undefined,
});

export function createNodeLogger(nodeName: string): pino.Logger {
  return logger.child({ node: nodeName });
}
