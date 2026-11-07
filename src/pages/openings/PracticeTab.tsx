import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board, TONE_COLOR, type BoardMove } from '../../ui/Board';
import { PlayerStrip, Stage } from '../../ui/stage';
import { MoveList } from '../../ui/MoveList';
import { IconUndo } from '../../ui/icons';
import { navigate } from '../../ui/router';
import { useKeys } from '../../ui/useKeys';
import { fensOf, trackOpening } from '../../analysis/openings';
import type { DrillRecord, RepertoireLine } from '../../db/types';
import {
  buildRepertoire, drillId, opponentMove, practiceBack, preparedAt, reveal, startPractice, tryMove, weakness, type PracticeState, type RepIndex,
} from '../../openings/repertoire';
import { listDrills, listLines, saveDrillResult } from '../../services/repertoire';
import { mulberry32 } from '../../util/rng';
import { OpeningHeader } from './OpeningHeader';
import { pathParam } from './paths';

type Note = { kind: 'ok' | 'wrong' | 'shown' | 'info'; text: string } | null;
const cur = (s: PracticeState) => s.fens[s.fens.length - 1];

export function PracticeTab({ lineArg }: { lineArg: string }) {
  const [lines, setLines] = useState<RepertoireLine[] | null>(null);
  const [drills, setDrills] = useState<Map<string, DrillRecord>>(new Map());
  const argColor = lineArg[0] === 'b' ? 'b' : lineArg[0] === 'w' ? 'w' : null;
  const argLine = lineArg.split(':')[1] ?? null;
  const [color, setColor] = useState<'w' | 'b'>(argColor ?? 'w');
  const [only, setOnly] = useState<string | null>(argLine);
  const [deviate, setDeviate] = useState(false);
  useEffect(() => {
    (async () => {
      const ls = await listLines();
      setLines(ls);
      setDrills(new Map((await listDrills()).map((d) => [d.id, d])));
      if (!argColor && ls.length && !ls.some((l) => l.color === 'w')) setColor('b');
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => (lines ?? []).filter((l) => l.color === color && (!only || l.id === only)), [lines, color, only]);
  const idx = useMemo(() => buildRepertoire(chosen, color), [chosen, color]);

  if (!lines) return <div className="empty">Loading…</div>;
  if (!lines.length) {
    return (
      <div className="surface surface-pad stack" style={{ maxWidth: 640 }} data-testid="practice-empty">
        <h2>Nothing to practise yet</h2>
        <p className="small dim" style={{ margin: 0 }}>Save a line from the Explorer first. Practice then plays the other side of your lines and checks your moves, as many times as you like.</p>
        <div><button type="button" className="btn btn-primary" onClick={() => navigate('openings/explore')}>Open the Explorer</button></div>
      </div>
    );
  }
  const has = (c: 'w' | 'b') => lines.some((l) => l.color === c);
  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <div className="row" style={{ gap: 'var(--s-3)' }}>
        <div className="seg" role="group" aria-label="Practise as">
          <button type="button" aria-pressed={color === 'w'} disabled={!has('w')} onClick={() => { setColor('w'); setOnly(null); }}>As White</button>
          <button type="button" aria-pressed={color === 'b'} disabled={!has('b')} onClick={() => { setColor('b'); setOnly(null); }}>As Black</button>
        </div>
        <select className="input input-sm" value={only ?? ''} onChange={(e) => setOnly(e.target.value || null)} aria-label="Which lines">
          <option value="">All {color === 'w' ? 'White' : 'Black'} lines</option>
          {lines.filter((l) => l.color === color).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={deviate} onChange={(e) => setDeviate(e.target.checked)} />
          <span className="check-text">Opponent may leave my lines<small>Only with catalogued moves</small></span>
        </label>
      </div>
      {chosen.length === 0 ? <p className="small dim">No {color === 'w' ? 'White' : 'Black'} lines saved.</p>
        : <PracticeBoard key={`${color}|${only ?? ''}|${deviate}`} idx={idx} deviate={deviate} drills={drills} onDrill={(d) => setDrills((m) => new Map(m).set(d.id, d))} />}
    </div>
  );
}

function PracticeBoard({ idx, deviate, drills, onDrill }: { idx: RepIndex; deviate: boolean; drills: Map<string, DrillRecord>; onDrill: (d: DrillRecord) => void }) {
  const [st, setSt] = useState<PracticeState>(() => startPractice(idx));
  const [note, setNote] = useState<Note>(null);
  const [shown, setShown] = useState<string[]>([]);
  const wrongHere = useRef<string[]>([]);
  const rand = useRef(mulberry32(Date.now() % 1_000_000));
  const drillsRef = useRef(drills);
  drillsRef.current = drills;
  const color = idx.color;

  // the training opponent replies after a short pause
  useEffect(() => {
    if (st.status !== 'theirs') return;
    const t = setTimeout(() => {
      setSt((s) => opponentMove(s, idx, rand.current, { deviate, weakness: (f) => weakness(drillsRef.current.get(drillId(color, f))) }));
    }, st.sans.length === 0 ? 300 : 550);
    return () => clearTimeout(t);
  }, [st, idx, deviate, color]);

  const restart = () => { setSt(startPractice(idx)); setNote(null); setShown([]); wrongHere.current = []; };
  const back = () => { setSt(practiceBack(st, idx)); setNote(null); setShown([]); wrongHere.current = []; };

  const onMove = (m: BoardMove) => {
    if (st.status !== 'mine') return false;
    const fenBefore = cur(st);
    let r;
    try { r = tryMove(st, idx, m); } catch { return false; }
    if (!r.correct) {
      wrongHere.current = [r.state.lastWrong!.uci, ...wrongHere.current];
      setSt(r.state);
      setNote({ kind: 'wrong', text: `${r.state.lastWrong!.san} is not in your ${r.expected.length > 1 ? 'lines' : 'line'} here. Try again${r.state.triesHere >= 2 ? ', or use Show me' : ''}.` });
      return false;
    }
    const played = r.state.sans[r.state.sans.length - 1];
    void saveDrillResult(color, fenBefore, r.expected.map((e) => e.uci), r.firstTry, wrongHere.current).then(onDrill);
    wrongHere.current = [];
    setShown([]);
    setSt(r.state);
    setNote({ kind: 'ok', text: r.firstTry ? `${played}: correct.` : `${played}: correct, after ${st.revealed ? 'being shown' : `${st.triesHere} wrong ${st.triesHere === 1 ? 'try' : 'tries'}`}. It is noted for revision.` });
    return true;
  };
  const showMe = () => {
    const r = reveal(st, idx);
    setSt(r.state);
    setShown(r.expected.map((e) => e.uci));
    setNote({ kind: 'shown', text: `Your ${r.expected.length > 1 ? 'lines continue with' : 'line continues with'} ${r.expected.map((e) => e.san).join(' or ')}. Play it on the board.` });
  };
  useKeys({ Backspace: back, s: () => { if (st.status === 'mine') showMe(); } });

  const fen = cur(st);
  const turn = new Chess(fen).turn();
  const orientation = color === 'w' ? 'white' : 'black';
  const top = color === 'w' ? 'b' : 'w';
  const track = trackOpening(fensOf(st.sans));
  const lastUci = st.ucis[st.ucis.length - 1];
  const arrows: [string, string, string][] = shown.map((u) => [u.slice(0, 2), u.slice(2, 4), TONE_COLOR.better]);
  const highlights: [string, string][] = st.lastWrong ? [[st.lastWrong.uci.slice(0, 2), TONE_COLOR.threat], [st.lastWrong.uci.slice(2, 4), TONE_COLOR.threat]] : [];
  const decisions = st.firstTry + st.missed;
  const status = st.status === 'mine' ? 'Your move' : st.status === 'theirs' ? 'The training opponent is replying…' : st.status === 'complete' ? 'Line complete' : 'Off your prepared lines';

  return (
    <div className="board-layout">
      <Stage orientation={orientation}
        top={<PlayerStrip name="Training opponent" color={top} fen={fen} isTurn={turn === top && st.status === 'theirs'} />}
        bottom={<PlayerStrip name="You" color={color} fen={fen} isTurn={turn === color && st.status === 'mine'} />}>
        {(size) => <Board fen={fen} orientation={orientation} size={size} movable={st.status === 'mine' ? color : 'none'} onMove={onMove} lastMove={lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : null} arrows={arrows} highlights={highlights} id="practice-board" />}
      </Stage>
      <div className="panel-slot">
        <section className="panel" aria-label="Practice" data-testid="practice">
          <div className="status-line" role="status" aria-live="polite" data-testid="practice-status"><span className="status-dot" /><span>{status}</span></div>
          <div className="panel-body">
            <div className="section"><OpeningHeader ply={track.plies[track.plies.length - 1]} compact /></div>
            {note && <div className={`feedback tone-${note.kind === 'ok' ? 'good' : note.kind === 'wrong' ? 'warn' : 'info'}`} data-testid="practice-note" style={{ margin: 'var(--s-3) var(--s-4)' }}><p className="small" style={{ margin: 0 }}>{note.text}</p></div>}
            {st.status === 'complete' && (
              <div className="feedback tone-good" data-testid="practice-done" style={{ margin: 'var(--s-3) var(--s-4)' }}>
                <div className="feedback-head"><h2>End of your prepared line</h2></div>
                <p className="small">{decisions ? `${st.firstTry} of ${decisions} decision${decisions === 1 ? '' : 's'} right at the first try.` : 'There was nothing for you to play in this line.'}</p>
                <button type="button" className="btn btn-primary btn-sm" onClick={restart} data-testid="practice-again">Practise again</button>
              </div>
            )}
            {st.status === 'uncovered' && st.deviation && (
              <div className="feedback tone-info" data-testid="practice-uncovered" style={{ margin: 'var(--s-3) var(--s-4)' }}>
                <div className="feedback-head"><h2>Your opponent left your lines</h2></div>
                <p className="small">{st.deviation.san} is a catalogued move, but your repertoire has no answer to it yet.</p>
                <div className="row">
                  <button type="button" className="btn btn-sm" onClick={() => navigate(`openings/explore/${pathParam(st.ucis)}`)}>Prepare an answer in the Explorer</button>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={restart}>Practise again</button>
                </div>
              </div>
            )}
            <div className="section">
              <div className="stats" style={{ margin: 0 }}>
                <div className="stat"><b>{st.firstTry}</b><span>right first time</span></div>
                <div className="stat"><b>{st.missed}</b><span>needed another try</span></div>
              </div>
            </div>
            <div className="section">
              <MoveList moves={st.sans.map((san) => ({ san }))} current={st.sans.length} testId="practice-moves" empty="The line starts from the initial position." style={{ maxHeight: 180 }} />
            </div>
          </div>
          <div className="panel-foot">
            <div className="row-nowrap">
              <button type="button" className="btn" onClick={showMe} disabled={st.status !== 'mine'} data-testid="practice-show">Show me</button>
              <button type="button" className="btn" onClick={back} disabled={st.sans.length === 0} title="Step back (Backspace)"><IconUndo size={16} /> Back</button>
              <span className="spacer" />
              <button type="button" className="btn btn-quiet" onClick={restart}>Restart</button>
            </div>
            {st.status === 'mine' && preparedAt(idx, fen).length > 1 && <p className="xs faint" style={{ margin: 'var(--s-2) 0 0' }}>Your lines allow more than one move here; any of them counts.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
