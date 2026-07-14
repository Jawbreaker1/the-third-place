import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isAdminPath } from "./adminModel";

const root = createRoot(document.getElementById("root")!);

async function renderApplication() {
  if (isAdminPath(window.location.pathname)) {
    const [{ default: AdminApp }] = await Promise.all([
      import("./AdminApp"),
      import("./admin.css"),
    ]);
    root.render(<StrictMode><AdminApp /></StrictMode>);
    return;
  }

  const [{ default: App }] = await Promise.all([
    import("./App"),
    import("./styles.css"),
  ]);
  root.render(<StrictMode><App /></StrictMode>);
}

void renderApplication();
