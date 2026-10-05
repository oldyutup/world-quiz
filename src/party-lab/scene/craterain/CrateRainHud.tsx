import type { CSSProperties } from 'react';
import { CRATE_RAIN as C, PLAYER_COLORS, PLAYER_NAMES, waveAt } from './config';
import type { CrateSnapshot } from './game';
import './craterain.css';
import { crateBindingLabel as label, type CrateBindings } from './controls';
import type { CrateView } from './camera';
export default function CrateRainHud({ snapshot: s, restart, bindings, view }: { bindings: CrateBindings; view: CrateView; snapshot: CrateSnapshot; restart: () => void }) {
  const leaders = s.wins.flatMap((score, i) => score === Math.max(...s.wins) ? [i] : []);
  const title = s.phase === 'results' ? leaders.length === 1 ? leaders[0] === 0 ? 'Maçı kazandın!' : `${PLAYER_NAMES[leaders[0]]} kazandı!` : 'Maç berabere!'
    : s.winner < 0 ? s.timeout ? '20 saniye! Hayatta kaldınız.' : 'Birlikte elendiniz!' : s.winner === 0 ? 'Turu kazandın!' : `${PLAYER_NAMES[s.winner]} turu aldı`;
  return <div className="pl-crate-hud">
    <div className="pl-crate-heading" data-urgent={s.phase === 'playing' && s.seconds <= 5}><span>KUTU YAĞMURU</span><strong>Tur {s.round}<small> / {C.rounds}</small></strong><span>{s.alive.filter(Boolean).length} kişi oyunda <i>·</i> {s.phase === 'countdown' ? 'Hazır ol' : `SÜRE · ${s.seconds}`}</span></div>
    <ol className="pl-crate-scores" aria-label="Tur galibiyetleri">{s.wins.map((wins, i) => <li key={i} data-out={!s.alive[i]} style={{ '--crate-player': PLAYER_COLORS[i] } as CSSProperties}><i>{i + 1}</i><span>{PLAYER_NAMES[i]}<small>{s.alive[i] ? 'Oyunda' : 'Elendi'}</small></span><b>{wins}</b></li>)}</ol>
    {s.phase === 'countdown' && <div className="pl-crate-message" role="status"><span>Kutular düşer. Avlu dolar.</span><strong>{s.seconds || 1}</strong><p>Gölgelere ve düşüş sesine dikkat.<br />Zıplayıp kutulara tırman.<br />20 saniye dayan. Son kalan turu kazanır.</p></div>}
    {s.phase === 'playing' && <><div className="pl-crate-phase" key={s.wave}>{waveAt(s.elapsed).label}</div>{!s.alive[0] && <div className="pl-crate-spectate" role="status">Elendin · Kalan oyuncuları izliyorsun</div>}</>}
    {(s.phase === 'roundOver' || s.phase === 'results') && <div className="pl-crate-message" role="status"><span>{s.phase === 'results' ? '3 tur tamamlandı' : `Tur ${s.round} tamamlandı`}</span><strong className="pl-crate-result">{title}</strong><p>{s.wins.map((w, i) => `${PLAYER_NAMES[i]} ${w}`).join(' · ')}</p>{s.phase === 'results' ? <button className="pl-button pl-create" onClick={restart}>Yeniden oyna</button> : <small>{s.round === C.rounds ? 'Maç sonucu hazırlanıyor…' : 'Yeni tur, boş bir avlu…'}</small>}</div>}
    {s.phase === 'playing' && s.alive[0] && s.danger && <div className="pl-crate-danger" role="status">↑ Yukarıdan kutu geliyor</div>}
    <div className="pl-crate-controls"><span>Tıkla · Fareyle bak</span><span><kbd>{(['moveForward', 'moveLeft', 'moveBackward', 'moveRight'] as const).map(a => label(bindings, a)).join(' ')}</kbd> Hareket</span><span><kbd>{label(bindings, 'sprint')}</kbd> Koş</span><span><kbd>{label(bindings, 'jump')}</kbd> Zıpla</span><span><kbd>{label(bindings, 'camera')}</kbd> {view === 'third' ? '3. kişi' : '1. kişi'}</span><span><kbd>{(['lookLeft', 'lookRight', 'lookUp', 'lookDown'] as const).map(a => label(bindings, a)).join(' ')}</kbd> Bak</span></div>
  </div>;
}
