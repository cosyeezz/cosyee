import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/motion.css';
import { App } from './App.tsx';
import { installSpotlight } from './ui/motion/spotlight';
import { installTheme } from './core/theme';

installTheme();
installSpotlight();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
