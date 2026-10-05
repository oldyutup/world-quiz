import type { CSSProperties } from 'react';
import { COLORS, NAMES, FIGHT as C } from './config';
import type { FightSnapshot } from './game';
import type { LookStatus } from '../../input/look';
import './snowfight.css';
export default function SnowFightHud({snapshot:s,restart,lookStatus,names=NAMES,self=0}:{names?:string[];self?:number;snapshot:FightSnapshot;restart?:()=>void;lookStatus:LookStatus}){
  const p=s.players[self],result=s.leaders.length===1?s.leaders[0]===self?'Kar parkının şampiyonu!':`${names[s.leaders[0]]} kazandı!`:'Kartopu kardeşliği, berabere!';
  return <div className="pl-fight-hud">
    <div className="pl-fight-heading"><span>KARTOPU SAVAŞI</span><strong>{s.phase==='countdown'?'Hazır ol':`${Math.floor(s.seconds/60)}:${String(s.seconds%60).padStart(2,'0')}`}</strong><small>Her KO +1 puan</small></div>
    <ol className="pl-fight-scores" aria-label="Skorlar">{s.players.map((p,i)=><li key={i} style={{'--fighter':COLORS[i]} as CSSProperties}><i>{i+1}</i><span>{names[i]}</span><b>{p.score}</b></li>)}</ol>
    {s.phase==='playing'&&p.hp>0&&<>
      <div className="pl-fight-reticle" data-hit={s.hitMarker} aria-hidden="true"><i/><b/></div>
      <div className="pl-fight-pocket"><div className="pl-fight-health" aria-label={`Can ${p.hp} / ${C.hp}`}>{Array.from({length:C.hp},(_,i)=><i key={i} data-full={i<p.hp}>♥</i>)}</div><div className="pl-fight-ammo"><span aria-hidden="true">{Array.from({length:C.inventory},(_,i)=><i key={i} data-full={i<p.ammo}/>)}</span><b>{p.ammo}<small> / {C.inventory}</small></b></div><p>{p.protected?'Yeni doğdun · Korunuyorsun':p.ammo===C.inventory?'Cepler dolu, sıra sende!':s.canGather?<><kbd>E</kbd> basılı tut · Kar topla</>:'Kar toplamak için karlı zemine geç'}</p></div>
      {p.gather>0&&<div className="pl-fight-gather" role="progressbar" aria-label="Kartopu hazırlanıyor" aria-valuenow={Math.round(p.gather*100)} aria-valuemin={0} aria-valuemax={100}><span>Kartopu hazırlanıyor…</span><div><i style={{transform:`scaleX(${p.gather})`}}/></div></div>}
      {lookStatus!=='locked'&&lookStatus!=='dragging'&&<div className="pl-fight-lock">{lookStatus==='error'?'İmleç kilitlenemedi. Tekrar tıkla.':'Bakmak için arenaya tıkla'}<small>Fare ile nişan al · Esc ile menü</small></div>}
    </>}
    {s.phase==='countdown'&&<div className="pl-fight-message"><span>{lookStatus==='locked'?'Topla. Saklan. Fırlat.':'Başlamak için arenaya tıkla'}</span><strong>{s.seconds}</strong><p>En çok KO yapan kazanır.<br/>Vurulursan geri dönersin!</p><small>WASD · Hareket　 SHIFT · Koş　 SPACE · Zıpla<br/>C / CTRL · Çömel　 E · Kar Topla　 Mouse1 · Fırlat</small></div>}
    {s.phase==='playing'&&p.hp===0&&<div className="pl-fight-message" role="status"><span>Kara bulandın!</span><strong>{Math.max(1,Math.ceil(p.respawn))}</strong><p>Az sonra yeniden oyundasın.</p></div>}
    {s.phase==='results'&&<div className="pl-fight-message pl-fight-result" role="status"><span>Kar parkında süre doldu</span><strong>{result}</strong><p>{s.players.map((p,i)=>`${names[i]} ${p.score}`).join(' · ')}</p>{restart&&<button className="pl-button pl-create" onClick={restart}>Yeniden oyna</button>}</div>}
    <div className="pl-fight-controls"><span><kbd>WASD</kbd> Hareket</span><span><kbd>SHIFT</kbd> Koş</span><span><kbd>SPACE</kbd> Zıpla</span><span><kbd>C / CTRL</kbd> Çömel</span><span><kbd>E</kbd> Kar topla</span><span><kbd>Mouse1</kbd> Fırlat</span></div>
  </div>;
}
