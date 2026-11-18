/**
 * seolyticize verify --client: verify_site, with what a deploy pipeline needs
 * to gate on it. Without --ci only a failed item fails the run. With --ci every
 * item not done, optional, in progress or dismissed fails it (failed, todo,
 * blocked), except those named by --allow: `todo:web_analytics` allows that
 * item in that status, `web_analytics` in any. An item matches by id or code.
 * --junit writes one testcase per item, for CI test reports.
 */
export type VerifyItem = {
  id: string;
  title?: string;
  status: string;
  code?: string;
  detail: string;
  next: unknown;
  dismissed?: unknown;
};

const PASSING = new Set(["done", "optional", "in_progress"]);

export function failingItems(
  items: VerifyItem[],
  options: { ci: boolean; allow: string[] },
): VerifyItem[] {
  const allowed = (item: VerifyItem) =>
    options.allow.some((entry) => {
      const [status, id] = entry.includes(":") ? entry.split(":", 2) : [null, entry];
      return (
        (status === null || status === item.status) &&
        (id === item.id || id === item.code)
      );
    });
  return items.filter((item) =>
    options.ci
      ? !PASSING.has(item.status) && !item.dismissed && !allowed(item)
      : item.status === "failed" && !allowed(item),
  );
}

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A JUnit report: one testcase per item, failed when it gates the run, skipped when optional or allowed. */
export function junitReport(
  clientId: string,
  items: VerifyItem[],
  failing: VerifyItem[],
): string {
  const failed = new Set(failing);
  const cases = items.map((item) => {
    const name = xml(item.code ?? item.id);
    const head = `  <testcase classname="seolyticize.verify_site" name="${name}">`;
    if (failed.has(item)) {
      const next = item.next ? ` Next: ${JSON.stringify(item.next)}` : "";
      return `${head}\n    <failure message="${xml(item.status)}">${xml(item.detail + next)}</failure>\n  </testcase>`;
    }
    if (item.status !== "done") {
      return `${head}\n    <skipped message="${xml(item.status)}">${xml(item.detail)}</skipped>\n  </testcase>`;
    }
    return `${head}</testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="seolyticize verify ${xml(clientId)}" tests="${items.length}" failures="${failing.length}">`,
    ...cases,
    "</testsuite>",
    "",
  ].join("\n");
}
