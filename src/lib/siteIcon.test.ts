import { afterEach, describe, expect, it } from "vitest";
import { originFromBaseUrl, parseIconHrefs, resetSiteIconCache } from "./siteIcon";

describe("siteIcon", () => {
  afterEach(() => {
    resetSiteIconCache();
  });

  it("strips path and query from the site base URL", () => {
    expect(originFromBaseUrl("https://api.example.com/v1/chat")).toBe("https://api.example.com");
    expect(originFromBaseUrl("https://api.example.com:8443/openai")).toBe(
      "https://api.example.com:8443",
    );
    expect(originFromBaseUrl("not a url")).toBeNull();
  });

  it("parses rel=icon hrefs from HTML and resolves them against the page URL", () => {
    const html = `
      <html><head>
        <link rel="stylesheet" href="/app.css" />
        <link rel="icon" href="/assets/mark.png" sizes="32x32" />
        <link rel="apple-touch-icon" href="/apple.png" />
        <link rel="shortcut icon" href="https://cdn.example.com/fav.ico" />
      </head></html>
    `;
    const hrefs = parseIconHrefs(html, "https://api.example.com/docs");
    expect(hrefs[0]).toBe("https://api.example.com/assets/mark.png");
    expect(hrefs).toContain("https://cdn.example.com/fav.ico");
    expect(hrefs).toContain("https://api.example.com/apple.png");
    expect(hrefs).not.toContain("https://api.example.com/app.css");
  });
});
