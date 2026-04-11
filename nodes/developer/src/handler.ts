import * as fs from "fs";
import * as path from "path";
import type { NodeHandler, TextPayload } from "@brain/sdk";
import { LLMRegistry, generateText, logger } from "@brain/core";
import { NODE_TEMPLATE_DOCS } from "./template";
import { executeDevTool, TOOL_DESCRIPTIONS } from "./tools";
import { v4 as uuid } from "uuid";

const log = logger.child({ node: "developer" });

interface DevConfig {
  model: string;
  response_topic: string;
  max_steps: number;
}

function getConfig(overrides: Record<string, unknown>): DevConfig {
  return {
    model: (overrides.model as string | undefined) ?? "anthropic/claude-sonnet-4-6",
    response_topic: (overrides.response_topic as string | undefined) ?? "dev.result",
    max_steps: (overrides.max_steps as number | undefined) ?? 15,
  };
}

function resolveMonorepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function parseToolCall(text: string): ToolCall | null {
  // Find JSON tool call in the LLM response
  const patterns = [
    /\{[\s]*"tool"[\s]*:[\s]*"([^"]+)"[\s]*,[\s]*"args"[\s]*:[\s]*(\{[^}]*(?:\{[^}]*\}[^}]*)?\})\s*\}/s,
    /```json\s*(\{[\s\S]*?\})\s*```/,
    /(\{"tool"[\s\S]*?\})\s*$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        // Try the full match first
        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        if (typeof parsed.tool === "string") {
          return { tool: parsed.tool, args: (parsed.args as Record<string, unknown> | undefined) ?? {} };
        }
      } catch {
        // Try the captured group
        if (match[1]) {
          try {
            const parsed = JSON.parse(match[1]) as Record<string, unknown>;
            if (typeof parsed.tool === "string") {
              return { tool: parsed.tool, args: (parsed.args as Record<string, unknown> | undefined) ?? {} };
            }
          } catch {
            continue;
          }
        }
      }
    }
  }
  return null;
}

export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return;
  }

  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);
  const registry = LLMRegistry.getInstance();
  const monorepoRoot = resolveMonorepoRoot();

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    const request = payload.content;
    if (!request) continue;

    const workspaceId = uuid().slice(0, 8);
    const dynamicDir = path.join(monorepoRoot, "nodes", "_dynamic");
    if (!fs.existsSync(dynamicDir)) {
      fs.mkdirSync(dynamicDir, { recursive: true });
    }
    const workspacePath = path.join(dynamicDir, `dev-${workspaceId}`);
    fs.mkdirSync(workspacePath, { recursive: true });

    log.info({ workspaceId, request: request.slice(0, 100) }, "Starting node creation");

    const systemPrompt = `You are a developer agent for the brAIn framework. Create new node types based on requests.

${NODE_TEMPLATE_DOCS}

${TOOL_DESCRIPTIONS}

The workspace is at: ${workspacePath}

## Your workflow
1. Call list_existing_types to see what exists
2. Write all files: config.json, package.json, tsconfig.json, src/handler.ts
3. Call build_and_validate
4. If errors, fix and retry
5. Call register_type when build succeeds

Respond with ONE tool call at a time as JSON. After seeing the result, make the next call.`;

    const conversation: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: `Create a new brAIn node type:\n\n${request}` },
    ];

    let registeredName: string | undefined;
    let registeredPath: string | undefined;

    try {
      const model = registry.getModel(config.model);

      for (let step = 0; step < config.max_steps; step++) {
        const result = await generateText({
          model,
          system: systemPrompt,
          messages: conversation,
          maxOutputTokens: 4096,
        });

        const text = result.text || (result as unknown as { reasoning?: string }).reasoning || "";
        conversation.push({ role: "assistant", content: text });

        const toolCall = parseToolCall(text);
        if (!toolCall) {
          // No tool call — the LLM is done talking
          log.info({ step }, "LLM finished without tool call");
          break;
        }

        log.info({ step, tool: toolCall.tool }, "Executing tool");
        const toolResult = await executeDevTool(toolCall.tool, toolCall.args, workspacePath, monorepoRoot);

        // Check for registration
        if (toolCall.tool === "register_type" && toolResult.success) {
          registeredName = toolResult.name as string;
          registeredPath = toolResult.path as string;
        }

        conversation.push({
          role: "user",
          content: `Tool result for ${toolCall.tool}:\n${JSON.stringify(toolResult, null, 2)}`,
        });

        if (registeredName) break;
      }

      if (registeredName && registeredPath) {
        ctx.publish(config.response_topic, {
          type: "text",
          criticality: 5,
          payload: {
            content: JSON.stringify({
              status: "success",
              type_name: registeredName,
              type_path: registeredPath,
              message: `New node type '${registeredName}' created successfully.`,
            }),
          },
          metadata: {
            original_request: request,
            workspace: workspacePath,
          },
        });
        log.info({ name: registeredName }, "Node type created successfully");
      } else {
        ctx.publish(config.response_topic, {
          type: "alert",
          criticality: 4,
          payload: {
            title: "Node creation incomplete",
            description: "The developer did not complete registration. Check the workspace for partial work.",
          },
          metadata: { original_request: request, workspace: workspacePath },
        });
        log.warn({ workspace: workspacePath }, "Node creation incomplete");
      }
    } catch (err) {
      ctx.publish(config.response_topic, {
        type: "alert",
        criticality: 5,
        payload: {
          title: "Developer node failed",
          description: err instanceof Error ? err.message : String(err),
        },
        metadata: { original_request: request, workspace: workspacePath },
      });
      log.error({ err, workspace: workspacePath }, "Developer node failed");
    }
  }
};
