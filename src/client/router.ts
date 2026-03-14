import { createRouter, createWebHistory } from "vue-router";
import ChatView from "@/client/views/ChatView.vue";
import LoginView from "@/client/views/LoginView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: ChatView },
    { path: "/workspaces/:workspaceId", name: "workspace", component: ChatView },
    {
      path: "/workspaces/:workspaceId/sessions/:sessionId",
      name: "session",
      component: ChatView,
    },
    { path: "/login", name: "login", component: LoginView },
  ],
});
