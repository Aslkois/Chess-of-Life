import { useEffect, useState } from 'react';
import { useRoute, navigate } from './ui/router';
import { useApp } from './ui/context';
import { IconBoard, IconCoach, IconHome, IconImport, IconLibrary, IconLock, IconMenu, IconProfile, IconSettings, IconSword } from './ui/icons';
import { HomePage } from './pages/HomePage';
import { ReconstructPage } from './pages/ReconstructPage';
import { ImportPage } from './pages/ImportPage';
import { LibraryPage } from './pages/LibraryPage';
import { ReviewPage } from './pages/ReviewPage';
import { CoachPage } from './pages/CoachPage';
import { RankedPage } from './pages/RankedPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';

const NAV = [
  { id: 'home', label: 'Home', icon: <IconHome /> },
  { id: 'reconstruct', label: 'Reconstruct game', icon: <IconBoard /> },
  { id: 'import', label: 'Import PGN', icon: <IconImport /> },
  { id: 'library', label: 'Library & review', icon: <IconLibrary /> },
  { sep: true },
  { id: 'coach', label: 'Coach', icon: <IconCoach /> },
  { id: 'ranked', label: 'Ranked Rival', icon: <IconSword /> },
  { sep: true },
  { id: 'profile', label: 'Progress', icon: <IconProfile /> },
  { id: 'settings', label: 'Settings & data', icon: <IconSettings /> },
] as const;

export function App() {
  const route = useRoute();
  const { engineStatus, activeRanked, rankedLoaded, toasts } = useApp();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [route.page, route.params.join('/')]);

  // During an active Ranked match nothing but the match itself is reachable.
  const locked = !!activeRanked && route.page !== 'ranked';

  let page: JSX.Element;
  if (!rankedLoaded) {
    page = <div className="empty">Loading…</div>;
  } else if (locked) {
    page = (
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="lock-banner"><IconLock /><h2 style={{ margin: 0 }}>Ranked match in progress</h2></div>
        <p className="muted" style={{ marginTop: 10 }}>Analysis, the Coach, saved reviews and branches are unavailable until your Ranked game is finished. This keeps every Ranked decision your own.</p>
        <button className="btn primary" onClick={() => navigate('ranked')}>Return to the match</button>
      </div>
    );
  } else {
    switch (route.page) {
      case 'reconstruct': page = <ReconstructPage />; break;
      case 'import': page = <ImportPage />; break;
      case 'library': page = <LibraryPage />; break;
      case 'review': page = <ReviewPage key={route.params[0]} gameId={route.params[0]} />; break;
      case 'coach': page = <CoachPage />; break;
      case 'ranked': page = <RankedPage />; break;
      case 'profile': page = <ProfilePage />; break;
      case 'settings': page = <SettingsPage />; break;
      default: page = <HomePage />;
    }
  }
  const dotCls = engineStatus.error ? 'err' : !engineStatus.ready ? '' : engineStatus.busy ? 'busy' : 'ok';
  const engineText = engineStatus.error ? 'Engine restarting' : !engineStatus.ready ? 'Engine loading…' : engineStatus.busy ? `Engine thinking${engineStatus.queued ? ` (+${engineStatus.queued})` : ''}` : 'Engine ready';
  const hideEngine = !!activeRanked;
  return (
    <div className="app">
      <div className="topbar-mobile">
        <button className="btn icon ghost" aria-label="Menu" onClick={() => setMenu(true)}><IconMenu /></button>
        <img src="./icon.svg" width={24} height={24} alt="" />
        <b>Chess of Life</b>
        <span className="spacer" />
        {!hideEngine && <span className={`dot ${dotCls}`} title={engineText} />}
      </div>
      <aside className={`sidebar${menu ? ' open' : ''}`}>
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <div>Chess of Life<small>every move, a branch</small></div>
          <span className="spacer" />
          {menu && <button className="btn ghost sm" onClick={() => setMenu(false)} aria-label="Close menu">✕</button>}
        </div>
        <nav className="nav">
          {NAV.map((n, i) => ('sep' in n ? <div className="sep" key={i} /> : (
            <a key={n.id} href={`#/${n.id}`} className={`${route.page === n.id || (n.id === 'library' && route.page === 'review') ? 'active' : ''} ${activeRanked && n.id !== 'ranked' ? 'locked' : ''}`}>
              {n.icon}{n.label}{activeRanked && n.id === 'ranked' && <span className="pill warn" style={{ marginLeft: 'auto' }}>live</span>}
            </a>
          )))}
        </nav>
        {!hideEngine && (
          <div className="engine-status" data-testid="engine-status"><span className={`dot ${dotCls}`} />{engineText}{engineStatus.name ? <span className="faint" style={{ marginLeft: 'auto' }}>{engineStatus.name.replace(' WASM', '')}</span> : null}</div>
        )}
      </aside>
      <main className="main">{page}</main>
      <div style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 60 }}>
        {toasts.map((t) => <div key={t.id} className="notice" style={{ background: '#121a10', borderColor: '#35502c' }} role="status">{t.msg}</div>)}
      </div>
    </div>
  );
}
