import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// IBM Plex tri-family: Condensed sets the display headings (a tighter
// editorial voice, distinct from the body), Sans is the reading/body face,
// Mono is the technical apparatus (gutter, line-tags, chips, code). Bundled
// via @fontsource so it works offline in Tauri.
import "@fontsource-variable/ibm-plex-sans/standard.css";
import "@fontsource-variable/ibm-plex-sans/standard-italic.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@fontsource/ibm-plex-sans-condensed/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
