import type { CSSProperties } from 'react';
import { SNOWBALL, SNOW_COLORS, SNOW_NAMES } from './config';
import type { SnowSnapshot } from './game';
import './snowball.css';
export default function SnowballHud({snapshot:s,restart}:{snapshot:SnowSnapshot;restart:()=>void}) {
  const leaders=s.wins.flatMap((wins,i)=>wins===Math.max(...s.wins)?[SNOW_NAMES[i]]:[]);
  const title=s.phase==='results'?(leaders.length===1?(leaders[0]==='Sen'?'Maçı kazandın!':`${leaders[0]} kazandı!`):'Maç berabere!'):s.phase==='roundOver'?(s.winner<0?'Birlikte düştünüz!':s.winner===0?'Turu kazandın!':`${SNOW_NAMES[s.winner]} turu aldı`):'';
  return <div className="pl-snow-hud">
    {s.alive.map((alive,i)=>i>0&&alive&&<div key={i} className="pl-snow-edge" data-snow-edge={i} hidden style={{'--snow-color':SNOW_COLORS[i]} as CSSProperties} aria-label={`${SNOW_NAMES[i]} ekranın dışında`}><span>↑</span><b>{i+1}</b></div>)}
    <div className="pl-snow-heading"><span>KARTOPU ÇARPIŞMASI</span><strong>Tur {s.round}<small> / {SNOWBALL.rounds}</small></strong><span>{s.alive.filter(Boolean).length} / {s.alive.length} oyunda</span></div>
    <ol className="pl-snow-scores" aria-label="Tur galibiyetleri">{s.wins.map((wins,i)=><li key={i} data-out={!s.alive[i]} style={{'--snow-color':SNOW_COLORS[i]} as CSSProperties}><i>{i+1}</i><span>{SNOW_NAMES[i]}<small>{s.alive[i]?'Oyunda':'Düştü'}</small></span><b>{wins}</b></li>)}</ol>
    {s.phase==='countdown'&&<div className="pl-snow-message" role="status"><span>Son kalan kartopu kazanır</span><strong>{s.seconds||1}</strong><p>W/S · Ekranda yukarı / aşağı<br/>A/D · Ekranda sol / sağ</p><small>Ters yöne basarak frenle.</small></div>}
    {s.phase==='playing'&&!s.alive[0]&&<div className="pl-snow-spectate" role="status">Düştün · Kalan oyuncuları izliyorsun</div>}
    {s.phase==='playing'&&s.elapsed>=SNOWBALL.shrinkStart-3&&<div className="pl-snow-warning" role="status">{s.elapsed<SNOWBALL.shrinkStart?'Buz birazdan daralıyor':'Buz daralıyor'} · Merkeze yaklaş</div>}
    {!!title&&<div className="pl-snow-message" role="status"><span>{s.phase==='results'?'3 tur tamamlandı':`Tur ${s.round} tamamlandı`}</span><strong className="pl-snow-result">{title}</strong><p>{s.wins.map((w,i)=>`${SNOW_NAMES[i]} ${w}`).join(' · ')}</p>{s.phase==='results'?<button type="button" className="pl-button pl-create" onClick={restart}>Yeniden oyna</button>:<small>{s.round===SNOWBALL.rounds?'Maç sonucu hazırlanıyor…':'Bir sonraki tur hazırlanıyor…'}</small>}</div>}
  </div>;
}
