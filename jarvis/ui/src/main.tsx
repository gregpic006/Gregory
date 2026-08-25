import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { installSession } from "./lib/session";
import "./styles/global.css";

// Avant tout appel reseau: le jeton doit etre en place des la premiere requete.
installSession();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
