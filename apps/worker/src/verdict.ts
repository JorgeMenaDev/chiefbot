import type { Tool } from "@github/copilot-sdk";
import { ApiError, isPng, RecordedVerdict, SCREENSHOT_BYTES_MAX, VerdictArgs, type VerdictReport } from "@chiefbot/contracts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const verdictToolName = "report_verdict";

// A verifier's one way to end: its verdict on the commit it checked, sent to
// control with its report and screenshots, which control keeps in the project's
// context, so they outlive this computer. Screenshots are PNG files here, by
// path; a relative one is in the clone (`cwd`). The project's secrets are hidden
// in the summary and report (`redact`, secretRedactor.ts) before they leave.
// `base` is the worker's control routes (/task-worker/:id); `turnKey` gives its turn's key.
export function verdictTool({ base, turnKey, cwd, redact }: { base: string; turnKey: () => string; cwd: string; redact: (text: string) => string }) {
  return {
    name: verdictToolName,
    description: "End your check: report your verdict on the pull request, with your report and the screenshots you saved. Call it once.",
    parameters: VerdictArgs,
    async handler(raw) {
      const { result, summary, report, screenshots } = VerdictArgs.parse(raw);
      const images = await Promise.all(
        screenshots.map(async (path) => {
          const bytes = await readFile(resolve(cwd, path)).catch(() => null);
          if (bytes === null) throw new Error(`There is no file ${path}. Save each screenshot first, such as with scrot /tmp/verify-1.png.`);
          if (!isPng(bytes)) throw new Error(`${path} is not a PNG image: report_verdict takes PNG screenshots only.`);
          if (bytes.byteLength > SCREENSHOT_BYTES_MAX) throw new Error(`${path} is over 2 MB: take a smaller screenshot.`);
          return bytes.toString("base64");
        }),
      );
      const res = await fetch(`${base}/verdict`, {
        method: "POST",
        headers: { authorization: `Bearer ${turnKey()}`, "content-type": "application/json" },
        body: JSON.stringify({ result, summary: redact(summary), report: redact(report), screenshots: images } satisfies VerdictReport),
      });
      if (!res.ok) {
        const error = ApiError.safeParse(await res.json().catch(() => null));
        throw new Error(error.success ? (error.data.message ?? error.data.error) : `Control answered ${res.status}`);
      }
      const { evidence } = RecordedVerdict.parse(await res.json());
      return `Recorded your verdict, ${result}. Your report is in the project's context at ${evidence}.`;
    },
  } satisfies Tool<VerdictArgs>;
}
