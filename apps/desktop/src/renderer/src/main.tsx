import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startTheme } from "./lib/theme.ts";
import "./styles.css";

startTheme();
// A file dropped anywhere but the composer would open in the window, in place of the app.
for (const type of ["dragover", "drop"]) window.addEventListener(type, (event) => event.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
