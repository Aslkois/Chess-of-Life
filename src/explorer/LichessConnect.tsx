import { useState, useSyncExternalStore } from 'react';
import { accountName, getLichessUser, getToken, isValidToken, logoutLichess, onTokenChange, setToken, startLichessLogin } from './lichess';

export const useLichessToken = () => useSyncExternalStore(onTokenChange, () => getToken(), () => null);

/** Connect a Lichess account: Log in with Lichess (PKCE), or paste a personal access token. */
export function LichessConnect({ reason, inline }: { reason?: string; inline?: boolean }) {
  const token = useLichessToken();
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (inline) return <button type="button" className="link-btn" onClick={() => void logoutLichess()}>Disconnect</button>;
  if (token) return <p className="small dim">Connected to Lichess{getLichessUser() ? ` as ${getLichessUser()}` : ''}. <button type="button" className="link-btn" onClick={() => void logoutLichess()} data-testid="lichess-disconnect">Disconnect</button></p>;
  const login = async () => {
    const redirect = `${location.origin}${location.pathname}`;
    location.assign(await startLichessLogin(redirect));
  };
  const usePaste = async () => {
    if (!isValidToken(paste)) { setMsg('That does not look like a Lichess token.'); return; }
    const user = await accountName(paste);
    setToken(paste, user);
    setMsg(user ? null : 'Token saved. Lichess did not confirm the account name; if the explorer reports an error, check the token.');
  };
  return (
    <div className="xp-connect" data-testid="lichess-connect">
      <p className="small" style={{ margin: 0 }}>{reason} The Lichess explorer is free but requires a Lichess account. Nothing is shown until you connect one.</p>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void login()} data-testid="lichess-login">Log in with Lichess</button>
        <span className="xs faint">or paste a <a href="https://lichess.org/account/oauth/token" target="_blank" rel="noreferrer">personal token</a> (no scopes needed):</span>
      </div>
      <div className="row-nowrap" style={{ gap: 6 }}>
        <input className="input input-sm" type="password" value={paste} onChange={(e) => setPaste(e.target.value.trim())} placeholder="lip_…" aria-label="Lichess personal access token" data-testid="lichess-token" style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={() => void usePaste()} disabled={!paste} data-testid="lichess-token-save">Save</button>
      </div>
      {msg && <p className="xs" style={{ margin: 0 }}>{msg}</p>}
      <p className="xs faint" style={{ margin: 0 }}>The token is kept in this browser only and is not part of backups. My games and Book work without it, offline.</p>
    </div>
  );
}
