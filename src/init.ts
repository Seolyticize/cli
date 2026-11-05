import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The parts of onboard_site's answer that init writes to the repo. */
export type OnboardAnswer = {
  clientId: string;
  domain: string;
  files: Array<{ path: string; content: string; purpose: string }>;
  analytics: { siteKey: string | null; install: string | null; suggestedExclude: string };
  csp: { "script-src": string[]; "connect-src": string[] };
  robots?: { path: string; content: string };
  next: string;
};

/**
 * The files `seolyticize init` writes for a framework, from onboard_site's
 * answer: the verification and IndexNow files in public/, robots, and for
 * Next.js an analytics component (with the CSP origins) and a sitemap source.
 */
export function initFiles(
  answer: OnboardAnswer,
  framework: string,
  publicDir = "public",
): Array<{ path: string; content: string; purpose: string }> {
  const out = answer.files.map((file) => ({
    path: join(publicDir, file.path.replace(/^\//, "")),
    content: file.content,
    purpose: file.purpose,
  }));
  if (answer.robots) {
    out.push({
      path: answer.robots.path.startsWith("/")
        ? join(publicDir, answer.robots.path.slice(1))
        : answer.robots.path,
      content: answer.robots.content,
      purpose: "robots.txt: the suggested exclusions and the sitemap",
    });
  }
  if (framework === "nextjs" && answer.analytics.siteKey) {
    const exclude = answer.analytics.suggestedExclude.split(",").filter(Boolean);
    out.push(
      {
        path: "app/seolyticize.tsx",
        content: [
          'import { Analytics, csp } from "@seolyticize/next";',
          "",
          "/** Seolyticize's cookieless analytics: render <SeolyticizeAnalytics /> once in app/layout.tsx. */",
          "export function SeolyticizeAnalytics({ nonce }: { nonce?: string }) {",
          `  return <Analytics siteKey="${answer.analytics.siteKey}" exclude={${JSON.stringify(exclude)}} nonce={nonce} />;`,
          "}",
          "",
          "/** The origins to add to a Content-Security-Policy: script-src and connect-src. */",
          "export const seolyticizeCsp = csp.tag;",
          "",
        ].join("\n"),
        purpose: "the analytics component and its CSP origins",
      },
      {
        path: "app/sitemap.ts",
        content: [
          'import type { MetadataRoute } from "next";',
          "",
          "// The host is read per request, so a build machine's URL never ends up in <loc>.",
          `const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://${answer.domain}";`,
          "",
          "export default function sitemap(): MetadataRoute.Sitemap {",
          "  // List every public page; lastModified lets each deploy find what changed.",
          "  return [{ url: `${BASE}/`, lastModified: new Date() }];",
          "}",
          "",
        ].join("\n"),
        purpose: "a sitemap source to fill with the public pages",
      },
    );
  }
  return out;
}

/** Writes each file unless it exists (or force), and says which. */
export async function writeInitFiles(
  dir: string,
  files: Array<{ path: string; content: string }>,
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<Array<{ path: string; outcome: "written" | "kept" | "would_write" }>> {
  const results: Array<{ path: string; outcome: "written" | "kept" | "would_write" }> =
    [];
  for (const file of files) {
    const target = join(dir, file.path);
    const exists = await access(target).then(
      () => true,
      () => false,
    );
    if (exists && !options.force) {
      results.push({ path: file.path, outcome: "kept" });
    } else if (options.dryRun) {
      results.push({ path: file.path, outcome: "would_write" });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
      results.push({ path: file.path, outcome: "written" });
    }
  }
  return results;
}
