import { createRouter, createWebHistory } from "vue-router";
import ChatView from "@/client/views/ChatView.vue";
import LoginView from "@/client/views/LoginView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "chat", component: ChatView },
    { path: "/login", name: "login", component: LoginView },
  ],
});
