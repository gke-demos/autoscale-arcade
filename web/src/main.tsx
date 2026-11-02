import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useArcade } from './store';
import './index.css';

// Debug hook for the browser console / automated checks (e.g. `__arcade.getState().view`).
declare global {
  interface Window {
    __arcade: typeof useArcade;
  }
}
window.__arcade = useArcade;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
