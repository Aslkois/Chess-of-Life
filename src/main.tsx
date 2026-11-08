import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import { App } from './App';
import { AppProvider } from './ui/context';
import { unlockAudio } from './audio/sounds';
import './styles/tokens.css';
import './styles/app.css';

// audio may only start after a user gesture
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, unlockAudio, { once: true, capture: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
