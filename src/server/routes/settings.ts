import fs from "node:fs/promises";
import path from "node:path";
import { battyAgentDir } from "../pi-paths";
import type { AppColor } from "@/shared/appearance";
import {
  setAppearance,
  setAssistantWorkspace,
  setBraveSearchKey,
  setDefaultModel,
} from "../options";
import { listWorkspaceRoots, listWorkspaces, resolveWorkspace } from "../workspaces";
import type { RouteContext } from "./context";
import {
  appSettingsStatus,
  unauthenticatedAuthStatus,
  unauthenticatedProviderAuthStatus,
} from "./context";

async function readBattyAgentsFile(context: RouteContext): Promise<string> {
  const filePath = path.join(battyAgentDir(context.config), "AGENTS.md");
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeBattyAgentsFile(context: RouteContext, content: string): Promise<string> {
  const filePath = path.join(battyAgentDir(context.config), "AGENTS.md");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return content;
}

export function registerSettingsRoutes(context: RouteContext): void {
  const { app, config, passkeys, service, routePath, buildId } = context;

  app.get(routePath("/api/bootstrap"), async (request) => {
    const authenticated = request.auth;
    const workspaces = authenticated ? await listWorkspaces(config) : [];

    return {
      authenticated,
      auth: authenticated ? await passkeys.getStatus() : unauthenticatedAuthStatus(),
      providerAuth: authenticated
        ? service.getProviderAuthStatus()
        : unauthenticatedProviderAuthStatus(),
      settings: appSettingsStatus(config),
      buildId,
      workspaceRoots: authenticated ? listWorkspaceRoots(config) : [],
      workspaces,
      workspaceUiSettings: Object.fromEntries(
        workspaces.map((workspace) => [workspace.id, context.getWorkspaceUiSettings(workspace.id)]),
      ),
      models: authenticated ? await service.listModels() : [],
    };
  });

  app.get(routePath("/api/version"), async () => ({ buildId }));

  app.get(routePath("/api/models"), async (request) => {
    return request.auth ? await service.listModels() : [];
  });

  app.get(routePath("/api/provider-auth/status"), async () => {
    return service.getProviderAuthStatus();
  });

  app.post<{ Body: { apiKey?: string } }>(
    routePath("/api/settings/brave-search"),
    async (request) => {
      const apiKey = request.body?.apiKey;
      if (typeof apiKey !== "string") {
        throw new Error("Missing Brave Search API key");
      }

      const options = await setBraveSearchKey(config.battyDir, apiKey);
      config.braveSearchKey = options.braveSearchKey;
      return appSettingsStatus(config);
    },
  );

  app.post<{ Body: { modelId?: string } }>(
    routePath("/api/settings/default-model"),
    async (request) => {
      const selected = (await service.listModels()).find(
        (model) => model.id === request.body?.modelId,
      );
      if (!selected) {
        throw new Error("Invalid default model");
      }

      const modelId = selected.id.slice(`${selected.provider}/`.length);
      const options = await setDefaultModel(config.battyDir, selected.provider, modelId);
      config.defaultProvider = options.defaultProvider;
      config.defaultModel = options.defaultModel;
      return appSettingsStatus(config);
    },
  );

  app.post<{ Body: { title?: string; color?: AppColor } }>(
    routePath("/api/settings/appearance"),
    async (request) => {
      const options = await setAppearance(
        config.battyDir,
        request.body?.title as string,
        request.body?.color as AppColor,
      );
      config.appTitle = options.appTitle;
      config.appColor = options.appColor;
      return appSettingsStatus(config);
    },
  );

  app.get(routePath("/api/settings/agents"), async () => {
    return { content: await readBattyAgentsFile(context) };
  });

  app.post<{ Body: { content?: string } }>(routePath("/api/settings/agents"), async (request) => {
    if (typeof request.body?.content !== "string") {
      throw new Error("Missing AGENTS file content");
    }

    return { content: await writeBattyAgentsFile(context, request.body.content) };
  });

  app.post<{ Params: { workspaceId: string }; Body: { easyMode?: boolean } }>(
    routePath("/api/workspaces/:workspaceId/ui-settings"),
    async (request) => {
      const workspaces = await listWorkspaces(config);
      const workspace = resolveWorkspace(workspaces, request.params.workspaceId);
      return context.setWorkspaceUiSettings(workspace.id, {
        easyMode: request.body?.easyMode === true,
      });
    },
  );

  app.post<{ Body: { workspaceId?: string | null } }>(
    routePath("/api/settings/assistant-workspace"),
    async (request) => {
      const workspaceId = request.body?.workspaceId;
      if (workspaceId != null && typeof workspaceId !== "string") {
        throw new Error("Invalid assistant workspace id");
      }

      if (workspaceId) {
        const workspaces = await listWorkspaces(config);
        resolveWorkspace(workspaces, workspaceId);
      }

      await setAssistantWorkspace(config.battyDir, workspaceId ?? undefined);
      return listWorkspaces(config);
    },
  );

  app.post(routePath("/api/provider-auth/openai-codex/start"), async () => {
    return service.startProviderAuth("openai-codex");
  });

  app.post<{ Body: { attemptId?: string; callbackUrlOrCode?: string } }>(
    routePath("/api/provider-auth/openai-codex/complete"),
    async (request) => {
      if (!request.body?.attemptId) {
        throw new Error("Missing auth attempt id");
      }
      if (!request.body?.callbackUrlOrCode) {
        throw new Error("Missing callback URL or authorization code");
      }

      return service.completeProviderAuth(request.body.attemptId, request.body.callbackUrlOrCode);
    },
  );

  app.post<{ Body: { providerId?: string; apiKey?: string } }>(
    routePath("/api/provider-auth/api-key"),
    async (request) => {
      const providerId = request.body?.providerId;
      if (providerId !== "google" && providerId !== "openrouter") {
        throw new Error("Unsupported API key provider");
      }
      if (!request.body?.apiKey) {
        throw new Error("Missing API key");
      }

      return service.setProviderApiKey(providerId, request.body.apiKey);
    },
  );
}
