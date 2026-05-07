import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseJsonContent,
  pickCli,
  readTree,
} from "../../storeprojects/brAIn-essentials/nodes/developer/src/handler";
import { NODE_TEMPLATE_DOCS } from "../../storeprojects/brAIn-essentials/nodes/developer/src/template";
import type { Message } from "@brain/sdk";

function msg(overrides: Partial<Message>): Message {
  return {
    id: "x",
    from: "test",
    topic: "dev.test",
    type: "text",
    criticality: 1,
    payload: { content: "" },
    timestamp: 0,
    ...overrides,
  } as Message;
}

describe("developer helpers", () => {
  describe("parseJsonContent", () => {
    it("parses a JSON content string", () => {
      const out = parseJsonContent(msg({ payload: { content: '{"slug":"dev-abc","request":"go"}' } }));
      expect(out).toEqual({ slug: "dev-abc", request: "go" });
    });

    it("falls back to metadata when content isn't JSON", () => {
      const out = parseJsonContent(msg({
        payload: { content: "free text" },
        metadata: { slug: "dev-meta" },
      }));
      expect(out.slug).toBe("dev-meta");
    });

    it("yields {content} when content is plain text and no metadata", () => {
      const out = parseJsonContent(msg({ payload: { content: "hello" } }));
      expect(out).toEqual({ content: "hello" });
    });
  });

  describe("pickCli", () => {
    it("prefers metadata.cli when present", () => {
      expect(pickCli({ cli: "claude" }, { cli: "codex" })).toBe("codex");
    });

    it("falls back to config_overrides.cli", () => {
      expect(pickCli({ cli: "codex" }, undefined)).toBe("codex");
    });

    it("ultimate default is claude", () => {
      expect(pickCli({}, undefined)).toBe("claude");
    });

    it("ignores non-string metadata.cli", () => {
      expect(pickCli({ cli: "codex" }, { cli: 42 })).toBe("codex");
    });
  });

  describe("readTree", () => {
    it("walks a directory and skips node_modules / dist", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dev-tree-"));
      fs.mkdirSync(path.join(tmp, "src"));
      fs.writeFileSync(path.join(tmp, "src", "handler.ts"), "// hi");
      fs.writeFileSync(path.join(tmp, "config.json"), "{}");
      fs.mkdirSync(path.join(tmp, "node_modules"));
      fs.writeFileSync(path.join(tmp, "node_modules", "junk.js"), "x");
      fs.mkdirSync(path.join(tmp, "dist"));
      fs.writeFileSync(path.join(tmp, "dist", "handler.js"), "x");

      try {
        const tree = readTree(tmp);
        const names = tree.map((n) => n.name).sort();
        expect(names).toEqual(["src", "config.json"].sort());
        const src = tree.find((n) => n.name === "src");
        expect(src?.is_dir).toBe(true);
        expect(src?.children?.[0]?.name).toBe("handler.ts");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("returns an empty array on missing path", () => {
      expect(readTree("/nope/nada")).toEqual([]);
    });

    it("guards against the chat.response wildcard footgun in the template", () => {
      // Real-world bug: an authored chatbot published on `chat.response`
      // while chat subscribed to `chat.response.*`. The template must
      // explicitly call this out so the next CLI invocation doesn't
      // reproduce the mistake.
      expect(NODE_TEMPLATE_DOCS).toMatch(/chat\.response\.\*/);
      expect(NODE_TEMPLATE_DOCS).toMatch(/chat\.response\.<your-node-name>/);
      expect(NODE_TEMPLATE_DOCS).toMatch(/Topic conventions/i);
    });

    it("respects depthLeft", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dev-tree-deep-"));
      fs.mkdirSync(path.join(tmp, "a"));
      fs.mkdirSync(path.join(tmp, "a", "b"));
      fs.writeFileSync(path.join(tmp, "a", "b", "leaf.txt"), "x");
      try {
        const shallow = readTree(tmp, "", 0);
        // depth 0 = only top-level (the dir 'a' itself), no children
        expect(shallow).toHaveLength(1);
        expect(shallow[0].children).toEqual([]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
