import { useEffect, useState, type ReactNode } from 'react';
import { useRoute, navigate } from './ui/router';
import { useApp } from './ui/context';
import { IconBook, IconCoach, IconHome, IconLibrary, IconLock, IconMenu, IconProgress, IconRanked, IconReview, IconSettings } from './ui/icons';
import { ReviewChooser } from './ui/ReviewChooser';
import { HomePage } from './pages/HomePage';
import { ReconstructPage } from './pages/ReconstructPage';
import { ImportPage } from './pages/ImportPage';
import { LibraryPage } from './pages/LibraryPage';
import { ReviewPage } from './pages/review/ReviewPage';
import { CoachPage } from './pages/CoachPage';
import { RankedPage } from './pages/RankedPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { OpeningsPage } from './pages/openings/OpeningsPage';

type NavId = 'home' | 'review' | 'coach' | 'ranked' | 'openings' | 'library' | 'profile' | 'settings';

const SECTION_OF: Record<string, NavId> = {
  home: 'home', review: 'review', reconstruct: 'review', import: 'review', coach: 'coach', ranked: 'ranked', openings: 'openings', explorer: 'openings', library: 'library', profile: 'profile', settings: 'settings',
};
const TITLES: Record<NavId, string> = { home: 'Chess of Life', review: 'Game Review', coach: 'Coach', ranked: 'Ranked Rival', openings: 'Explorer', library: 'Library', profile: 'Progress', settings: 'Settings' };

export function App() {
  const route = useRoute();
  const { engineStatus, activeRanked, rankedLoaded, toasts, openChooser } = useApp();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [route.page, route.params.join('/')]);
  useEffect(() => {
    if (!drawer) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [drawer]);

  const section = SECTION_OF[route.page] ?? 'home';
  useEffect(() => {
    document.title = section === 'home' ? 'Chess of Life' : `${TITLES[section]} · Chess of Life`;
  }, [section]);

  // During an active Ranked match nothing but the match itself is reachable.
  const locked = !!activeRanked && route.page !== 'ranked';
  let page: JSX.Element;
  if (!rankedLoaded) {
    page = <div className="empty">Loading…</div>;
  } else if (locked) {
    page = (
      <div className="page page-narrow">
        <div className="surface surface-pad stack" style={{ maxWidth: 560 }}>
          <div className="row"><IconLock /><h1 style={{ fontSize: 'var(--fs-xl)' }}>Ranked match in progress</h1></div>
          <p className="dim">Reviews, the Coach and saved analysis open again when your Ranked game ends. Every Ranked decision stays your own.</p>
          <div><button className="btn btn-primary" onClick={() => navigate('ranked')}>Return to the match</button></div>
        </div>
      </div>
    );
  } else {
    switch (route.page) {
      case 'reconstruct': page = <ReconstructPage />; break;
      case 'import': page = <ImportPage />; break;
      case 'library': page = <LibraryPage />; break;
      case 'review': page = <ReviewPage key={route.params[0]} gameId={route.params[0]} ply={route.params[1]} />; break;
      case 'coach': page = <CoachPage />; break;
      case 'ranked': page = <RankedPage />; break;
      case 'openings': page = <OpeningsPage params={route.params} />; break;
      case 'explorer': page = <OpeningsPage params={['explore', ...route.params]} />; break;
      case 'profile': page = <ProfilePage />; break;
      case 'settings': page = <SettingsPage />; break;
      default: page = <HomePage />;
    }
  }

  const engineCls = engineStatus.error ? 'is-err' : !engineStatus.ready ? '' : engineStatus.busy ? 'is-busy' : 'is-ok';
  const engineText = engineStatus.error ? 'Engine restarting' : !engineStatus.ready ? 'Engine loading' : engineStatus.busy ? 'Engine analysing' : 'Engine ready';
  const hideEngine = !!activeRanked; // even engine activity is hidden during Ranked play

  const item = (id: NavId, label: string, icon: ReactNode, onClick?: () => void) => {
    const isLocked = !!activeRanked && id !== 'ranked';
    const cls = `nav-item${section === id ? ' is-active' : ''}${isLocked ? ' is-locked' : ''}`;
    const extra = id === 'ranked' && activeRanked ? <span className="nav-badge">Live</span> : null;
    if (isLocked) {
      return <span className={cls} aria-disabled="true" title="Unavailable until your Ranked game ends">{icon}<span>{label}</span></span>;
    }
    if (onClick) return <button type="button" className={cls} onClick={() => { setDrawer(false); onClick(); }} aria-haspopup="dialog" data-testid={`nav-${id}`}>{icon}<span>{label}</span></button>;
    return <a href={`#/${id}`} className={cls} aria-current={section === id ? 'page' : undefined} data-testid={`nav-${id}`}>{icon}<span>{label}</span>{extra}</a>;
  };

  return (
    <div className="shell">
      <header className="topbar">
        <button type="button" className="btn btn-quiet btn-icon" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)} data-testid="menu"><IconMenu /></button>
        <span className="topbar-title ellipsis">{TITLES[section]}</span>
        <span className="spacer" />
        {!hideEngine && <span className={`engine-dot ${engineCls}`} title={engineText} aria-label={engineText} role="status" />}
      </header>
      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <nav className={`nav${drawer ? ' is-open' : ''}`} aria-label="Main">
        <a className="nav-brand" href="#/home" aria-label="Chess of Life home"><img src="./icon.svg" alt="" /><b>Chess of Life</b></a>
        {item('home', 'Home', <IconHome />)}
        {item('review', 'Game Review', <IconReview />, openChooser)}
        {item('coach', 'Coach', <IconCoach />)}
        {item('ranked', 'Ranked Rival', <IconRanked />)}
        {item('openings', 'Explorer', <IconBook />)}
        <div className="nav-gap" />
        {item('library', 'Library', <IconLibrary />)}
        {item('profile', 'Progress', <IconProgress />)}
        <div className="nav-foot">
          {item('settings', 'Settings', <IconSettings />)}
          {!hideEngine && <div className="engine-state" data-testid="engine-status" title={engineStatus.name ?? 'Stockfish'}><span className={`engine-dot ${engineCls}`} /><span>{engineText}</span></div>}
        </div>
      </nav>
      <main className="content" id="main">{page}</main>
      <ReviewChooser />
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className="toast">{t.msg}</div>)}
      </div>
    </div>
  );
}
