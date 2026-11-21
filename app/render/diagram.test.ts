import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const png = Buffer.from("styled-diagram");
  const screenshot = vi.fn(async () => png);
  const renderPage = {
    setContent: vi.fn(async (_html: string) => undefined),
    addScriptTag: vi.fn(
      async (_options: { url?: string; path?: string; content?: string }) =>
        undefined,
    ),
    evaluate: vi.fn(async (_callback: unknown, _code: string) => ({
      svg: "<svg><text>Flow</text></svg>",
    })),
    close: vi.fn(async () => undefined),
  };
  const shotPage = {
    setContent: vi.fn(async (_html: string, _options?: unknown) => undefined),
    evaluate: vi.fn(async (_callback: unknown) => undefined),
    $: vi.fn(async (_selector: string) => ({ screenshot })),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newPage: vi
      .fn(
        async (_options?: unknown) =>
          renderPage as typeof renderPage | typeof shotPage,
      )
      .mockResolvedValueOnce(renderPage)
      .mockResolvedValueOnce(shotPage),
  };
  return { browser, png, renderPage, screenshot, shotPage };
});

vi.mock("./browser.js", () => ({
  getBrowser: vi.fn(async () => mocks.browser),
}));

// Set while the module loads, because the old override was read at import
// time: the tests below would not notice it coming back otherwise.
process.env["MERMAID_URL"] = "https://cdn.example.test/mermaid.min.js";
const { MERMAID_BUNDLE_PATH, renderDiagram } = await import("./diagram.js");
delete process.env["MERMAID_URL"];

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies: Record<string, string> };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.browser.newPage
    .mockResolvedValueOnce(mocks.renderPage)
    .mockResolvedValueOnce(mocks.shotPage);
});

describe("renderDiagram visual treatment", () => {
  it("applies the CopilotKit Mermaid theme and screenshots a branded frame", async () => {
    const result = await renderDiagram("flowchart LR\n A --> B");

    expect(result).toBe(mocks.png);
    const evaluate = mocks.renderPage.evaluate.mock.calls[0]?.[0];
    expect(String(evaluate)).toContain('theme: "base"');
    expect(String(evaluate)).toContain('fontFamily: "Arial, sans-serif"');
    expect(String(evaluate)).toContain('primaryTextColor: "#010507"');
    expect(String(evaluate)).toContain(
      'primaryColor: "rgba(255, 172, 77, 0.2)"',
    );
    expect(String(evaluate)).toContain('secondaryColor: "#F3F3FC"');
    expect(String(evaluate)).toContain(
      'tertiaryColor: "rgba(255, 243, 136, 0.3)"',
    );
    expect(String(evaluate)).toContain('lineColor: "#57575b"');

    const shotHtml = mocks.shotPage.setContent.mock.calls[0]?.[0] as string;
    expect(shotHtml).toContain("#dedee9");
    expect(shotHtml).toContain("rgba(255, 255, 255, 0.7)");
    expect(shotHtml).toContain('font-family:"Plus Jakarta Sans"');
    expect(shotHtml).toContain("filter:blur(103px)");
    expect(mocks.shotPage.$).toHaveBeenCalledWith("#frame");
  });
});

describe("renderDiagram Mermaid source", () => {
  it("injects the installed bundle from disk, never a URL", async () => {
    await renderDiagram("flowchart LR\n A --> B");

    expect(mocks.renderPage.addScriptTag).toHaveBeenCalledTimes(1);
    expect(mocks.renderPage.addScriptTag).toHaveBeenCalledWith({
      path: MERMAID_BUNDLE_PATH,
    });
    const html = mocks.renderPage.setContent.mock.calls[0]?.[0] as string;
    expect(html).not.toMatch(/<script/i);
  });

  it("ignores a MERMAID_URL set in the environment", async () => {
    process.env["MERMAID_URL"] = "https://cdn.example.test/mermaid.min.js";
    try {
      await renderDiagram("flowchart LR\n A --> B");
    } finally {
      delete process.env["MERMAID_URL"];
    }

    const [options] = mocks.renderPage.addScriptTag.mock.calls[0] ?? [];
    expect(options).toEqual({ path: MERMAID_BUNDLE_PATH });
    expect(JSON.stringify(options)).not.toContain("cdn.example.test");
  });

  it("resolves to the exact Mermaid release pinned in package.json", () => {
    const pinned = packageJson.dependencies["mermaid"];
    // An exact version, not a range: a range is what let a new publish change
    // the code the renderer runs without a lockfile change.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);

    expect(MERMAID_BUNDLE_PATH).toMatch(/[\\/]dist[\\/]mermaid\.min\.js$/);
    expect(existsSync(MERMAID_BUNDLE_PATH)).toBe(true);
    const manifest = join(dirname(MERMAID_BUNDLE_PATH), "..", "package.json");
    const installed = JSON.parse(readFileSync(manifest, "utf8")) as {
      name: string;
      version: string;
    };
    expect(installed).toMatchObject({ name: "mermaid", version: pinned });
  });
});
