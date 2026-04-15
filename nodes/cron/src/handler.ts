import type { NodeHandler } from "@brain/sdk";

interface CronConfig {
  topic?: string;
  content?: string;
  criticality?: number;
  type?: "text" | "alert";
  alert_title?: string;
}

function getConfig(overrides: Record<string, unknown>): CronConfig {
  return {
    topic: (overrides.topic as string | undefined) ?? "cron.tick",
    content: (overrides.content as string | undefined) ?? new Date().toISOString(),
    criticality: (overrides.criticality as number | undefined) ?? 0,
    type: (overrides.type as "text" | "alert" | undefined) ?? "text",
    alert_title: overrides.alert_title as string | undefined,
  };
}

export const handler: NodeHandler = (ctx) => {
  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);

  if (config.type === "alert") {
    ctx.publish(config.topic ?? "cron.alert", {
      type: "alert",
      criticality: config.criticality ?? 3,
      payload: {
        title: config.alert_title ?? "Cron alert",
        description: config.content ?? "",
      },
    });
  } else {
    ctx.publish(config.topic ?? "cron.tick", {
      type: "text",
      criticality: config.criticality ?? 0,
      payload: { content: config.content ?? new Date().toISOString() },
    });
  }

  // Re-tick based on configured interval (default 10s)
  const interval = (ctx.node.config_overrides?.interval as string | undefined) ?? "10s";
  ctx.sleep([{ type: "timer", value: interval }]);

  return Promise.resolve();
};
