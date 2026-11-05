/**
 * seolyticize doctor: one PASS, FAIL or INFO line per check, read with the
 * least the job needs (a client_viewer key pinned to the client is enough).
 * Exit 10 on any FAIL. An optional connection is INFO: a site that has chosen not
 * to connect Bing is healthy, and a sweep that is always red gets ignored.
 */
type Caller = { call(tool: string, input: unknown): Promise<unknown> };

export type DoctorCheck = {
  name: string;
  result: "PASS" | "FAIL" | "INFO";
  detail: string;
};

export async function runDoctor(sdk: Caller, clientId: string): Promise<DoctorCheck[]> {
  const steps = (await sdk.call("get_next_steps", { clientId })) as {
    items: Array<{ id: string; status: string; code?: string; detail: string }>;
  };
  const hook = (await sdk.call("get_deploy_hook", { clientId })) as {
    exists: boolean;
    deployHook: { lastCalledAt: string | null; lastResult: string | null } | null;
  };
  const analytics = (await sdk.call("get_web_analytics_setup", { clientId })) as {
    configured: boolean;
    lastEventAt?: string | null;
  };
  const checks: DoctorCheck[] = steps.items
    .filter((item) => item.status !== "done" && item.status !== "in_progress")
    .map((item) => ({
      name: item.code ?? item.id,
      result: item.status === "optional" ? "INFO" : "FAIL",
      detail: item.detail,
    }));
  checks.push(
    hook.deployHook?.lastCalledAt
      ? {
          name: "deploy_hook",
          result: "PASS",
          detail: `last called ${hook.deployHook.lastCalledAt}: ${hook.deployHook.lastResult ?? ""}`,
        }
      : {
          name: "deploy_hook",
          result: "FAIL",
          detail: hook.exists
            ? "The hook has never been called."
            : "No deploy hook: create_deploy_hook.",
        },
    analytics.lastEventAt
      ? {
          name: "analytics_events",
          result: "PASS",
          detail: `last event ${analytics.lastEventAt}`,
        }
      : {
          name: "analytics_events",
          result: "FAIL",
          detail: analytics.configured
            ? "The tag is set up, but no event has arrived."
            : "Web analytics is not set up: set_up_web_analytics.",
        },
  );
  return checks;
}
