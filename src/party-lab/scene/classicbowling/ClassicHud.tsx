import type { CSSProperties } from 'react';
import { actionBindingLabel, type Bindings } from '../../input/bindings';
import { CLASSIC as C, COLORS, PLAYER_NAMES } from './config';
import type { ClassicSnapshot } from './game';
import './classic.css';
const phases = ['position', 'direction', 'power'];
export default function ClassicHud({ snapshot: s, bindings, restart, names=PLAYER_NAMES }: { snapshot: ClassicSnapshot; bindings: Bindings; restart?: () => void;names?:string[] }) {
  const phase = phases.indexOf(s.phase), binding = actionBindingLabel(bindings, 'jump');
  // Looking along +Z, camera-right is world -X.
  const value = phase === 0 ? (1 - s.position / C.positionRange) / 2 : phase === 1 ? (1 - s.angle / C.angleRange) / 2 : (s.power - C.powerMin) / (C.powerMax - C.powerMin);
  const title = s.phase === 'results' ? (s.winners.length > 1 ? 'BERABERE!' : `${names[s.winners[0]].toLocaleUpperCase('tr-TR')} KAZANDI!`) : s.message;
  return <div className="pl-classic-hud">
    <div className="pl-classic-title"><span>{restart?'YEREL TEST · 3 TUR':'3 TUR'}</span><strong>KLASİK BOWLING</strong><small>Her pin 1 puan · En fazla 30</small></div>
    <div className="pl-classic-scores" aria-label="Skor tablosu">
      {s.totals.map((total, i) => <div key={i} className={i === s.seat && s.phase !== 'results' ? 'is-active' : ''} style={{ '--player': COLORS[i] } as CSSProperties}>
        <span className="pl-classic-player"><i />{names[i]}{restart&&i > 0 && <small>BOT</small>}</span>
        <span className="pl-classic-frames">{s.cards[i].map((f, j) => <span key={j} title={`${j + 1}. tur: ${f.rolls.join(' + ') || 'Henüz oynanmadı'}`}>{f.kind === 'strike' ? 'X' : f.kind === 'spare' ? '/' : f.rolls.length ? f.rolls.join('·') : '–'}</span>)}</span>
        <b>{total}</b>
      </div>)}
    </div>
    {s.phase === 'feedback' && <div className="pl-classic-feedback" role="status"><strong>{title}</strong><span>{s.roll === 1 && s.standing.length ? `${s.standing.length} pin kaldı · Bir atış daha` : 'Tur tamamlandı'}</span></div>}
    {s.phase === 'results' ? <div className="pl-classic-result" role="status"><span>MAÇ TAMAMLANDI</span><h2>{title}</h2><p>{s.totals.map((n, i) => `${names[i]} ${n}`).join(' · ')}</p>{restart?<button className="pl-button pl-primary" onClick={restart}>Yeniden oyna</button>:<small>Lobiye dönülüyor…</small>}</div> : <div className="pl-classic-console">
      <div className="pl-classic-turn"><strong>{s.bot ? `${names[s.seat]} oynuyor` : 'Sıra sende'}</strong><span>TUR {s.frame}/3 <i>·</i> ATIŞ {s.roll}/2 <i>·</i> {s.standing.length} PİN</span></div>
      <ol className="pl-classic-phases">{['KONUM', 'YÖN', 'GÜÇ'].map((label, i) => <li key={label} aria-current={phase === i ? 'step' : undefined} className={phase === i ? 'is-current' : phase > i || s.phase === 'rolling' ? 'is-locked' : ''}><span>{i + 1}</span>{label}</li>)}</ol>
      {phase >= 0 ? <>
        <div className="pl-classic-gauge" role="meter" aria-label={['Konum', 'Yön', 'Güç'][phase]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
          <span className="pl-classic-center" /><i style={{ transform: `translateX(${value * 312}px)` }} />
        </div>
        <div className="pl-classic-scale"><span>{phase === 2 ? '%35' : 'SOL'}</span><b>{phase === 0 ? `${Math.abs(s.position).toFixed(2)} m ${s.position < -.025 ? 'sağ' : s.position > .025 ? 'sol' : 'orta'}` : phase === 1 ? `${s.angle < 0 ? '+' : ''}${(-s.angle).toFixed(1)}°` : `%${Math.round(s.power)}`}</b><span>{phase === 2 ? '%100' : 'SAĞ'}</span></div>
        <p>{s.bot ? (restart?'Bot da aynı göstergeleri durduruyor':'Diğer oyuncunun atışı bekleniyor') : <><kbd>{binding}</kbd> {phase === 0 ? 'Konumu seç' : phase === 1 ? 'Yönü seç' : 'At!'} <small>· Acele etme, gösterge geri gelir</small></>}</p>
      </> : <p className="pl-classic-wait">{s.phase === 'rolling' ? 'Top yuvarlanıyor…' : s.phase === 'return' ? 'Sıradaki atış hazırlanıyor…' : 'Pinler sayıldı'}</p>}
    </div>}
  </div>;
}
