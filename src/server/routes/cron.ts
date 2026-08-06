import type { RouteContext } from "./context";

interface CronJobRouteBody {
  workspaceId?: string;
  enabled?: boolean;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
  session?: {
    kind?: string;
    includePreviousContext?: boolean;
  };
  schedule?: {
    kind?: string;
    at?: string;
    in?: string;
    every?: string;
    expression?: string;
    timezone?: string;
  };
}

export function registerCronRoutes(context: RouteContext): void {
  const { app, cronService, routePath } = context;

  app.post<{ Body: CronJobRouteBody }>(routePath("/api/cron-jobs"), async (request) => {
    return cronService.createJob({
      workspaceId: request.body?.workspaceId ?? "",
      enabled: request.body?.enabled,
      prompt: request.body?.prompt ?? "",
      model: request.body?.model ?? "",
      thinkingLevel: request.body?.thinkingLevel ?? "",
      session: request.body?.session as never,
      schedule: (request.body?.schedule ?? {}) as never,
    });
  });

  app.patch<{ Params: { jobId: string }; Body: CronJobRouteBody }>(
    routePath("/api/cron-jobs/:jobId"),
    async (request) => {
      return cronService.updateJob(request.params.jobId, {
        workspaceId: request.body?.workspaceId,
        enabled: request.body?.enabled,
        prompt: request.body?.prompt,
        model: request.body?.model,
        thinkingLevel: request.body?.thinkingLevel,
        session: request.body?.session as never,
        schedule: request.body?.schedule as never,
      });
    },
  );

  app.delete<{ Params: { jobId: string } }>(routePath("/api/cron-jobs/:jobId"), async (request) => {
    return cronService.deleteJob(request.params.jobId);
  });

  app.delete<{ Params: { runId: string } }>(routePath("/api/cron-runs/:runId"), async (request) => {
    return cronService.stopRunningJob({ runId: request.params.runId });
  });
}
