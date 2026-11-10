import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import { App } from './App';
import { AppProvider } from './ui/context';
import { unlockAudio } from './audio/sounds';
import { completeLichessLogin } from './explorer/lichess';
import './styles/tokens.css';
import './styles/app.css';

// returning from "Log in with Lichess" (authorization code flow with PKCE)
if (new URLSearchParams(location.search).has('code')) {
  const search = location.search;
  history.replaceState(null, '', `${location.pathname}#/openings/explore`);
  completeLichessLogin(search).catch((e) => { try { sessionStorage.setItem('col.lichess.loginError', String((e as Error).message)); } catch { /* ignore */ } });
}

// audio may only start after a user gesture
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, unlockAudio, { once: true, capture: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
