import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
const Preview = import.meta.env.DEV && new URLSearchParams(location.search).get('preview') === 'motion'
  ? React.lazy(() => import('./components/MotionPreview')) : null;
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {Preview ? <React.Suspense fallback={null}><Preview /></React.Suspense> : <App />}
  </React.StrictMode>,
);
