import type { FastifyInstance } from "fastify";
import type { AppSettingsStatus, ProviderAuthStatus, WorkspaceSnapshot } from "@/shared/types";
import type { AppConfig } from "../config";
import type { CronService } from "../cron";
import type { LoginRateLimiter } from "../login-rate-limit";
import type { PasskeyAuthService } from "../passkeys";
import type { PiService } from "../pi-service";
import type { WebPushService } from "../web-push";

export interface RouteContext {
  app: FastifyInstance;
  config: AppConfig;
  passkeys: PasskeyAuthService;
  service: PiService;
  cronService: CronService;
  webPush: WebPushService;
  authAttemptLimiter: LoginRateLimiter;
  buildId: string;
  routePath: (route: string) => string;
  workspaceSnapshot: (workspaceId: string) => Promise<WorkspaceSnapshot>;
}

export function unauthenticatedAuthStatus() {
  return {
    passkeyCount: 0,
    passkeyLoginAvailable: false,
    registrationOpen: false,
    setupRequired: false,
  };
}

export function appSettingsStatus(config: AppConfig): AppSettingsStatus {
  return {
    braveSearchConfigured: Boolean(config.braveSearchKey),
  };
}

export function unauthenticatedProviderAuthStatus(): ProviderAuthStatus {
  return { providers: [] };
}
