/// <reference types="vite/client" />
import type { ChiefbotApi } from "../../preload/index.ts";

declare global {
  interface Window {
    chiefbot: ChiefbotApi;
  }
}
