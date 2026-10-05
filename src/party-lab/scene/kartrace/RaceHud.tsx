import type { RaceSnapshot } from './game';
import { COLORS } from './config';
import './race.css';
import { raceHelp, raceBindingLabel, type RaceBindings } from './controls';
export const raceTime=(s:number)=>`${Math.floor(s/60)}:${(s%60).toFixed(2).padStart(5,'0')}`;
export default function RaceHud({snapshot:s,restart,bindings,self=0,names}:{snapshot:RaceSnapshot;restart?:()=>void;bindings:RaceBindings;self?:number;names?:string[]}){
  const finished=s.order.find(p=>p.id===self)?.finish!==null;
  return <div className="pl-race-hud">
    <div className="pl-race-top"><div className="pl-race-position"><strong>{s.position}.</strong><span>/ {s.count}</span></div><div className="pl-race-lap">TUR <b>{s.lap} / {s.laps}</b><time>{raceTime(s.time)}</time></div></div>
    {s.phase==='countdown'&&<div className="pl-race-callout"><span>ARABA YARIŞI</span><strong>{s.countdown}</strong><small>3 tur. İlk bitiren kazanır.</small></div>}
    {s.phase==='racing'&&<div className="pl-race-message" role="status">{s.resetting?'PİSTE DÖNÜŞ':s.wrong?'TERS YÖN':s.missed?`KONTROL NOKTASINI KAÇIRDIN · ${raceBindingLabel(bindings,'raceReset')}`:finished?'BİTİŞ!':s.time<1.2?'BAŞLA!':s.finalLap?'SON TUR!':s.camera??''}</div>}
    <div className="pl-race-speed"><strong>{Math.round(s.speed)}</strong><span>km/sa</span>{s.grass&&s.speed>4&&<small>ÇİM</small>}</div>
    <div className="pl-race-controls">{raceHelp(bindings).map(({action,key,label})=><span key={action}><kbd>{key}</kbd> {label}</span>)}</div>
    {s.phase==='results'&&<section className="pl-race-results" aria-label="Yarış sonucu"><p>ARABA YARIŞI</p><h2>{s.winner===self?'KAZANDIN!':s.winner===null?'SÜRE DOLDU':'YARIŞ BİTTİ'}</h2><ol>{s.order.map((p,i)=><li key={p.id}><b>{i+1}.</b><span className="pl-race-dot" style={{background:COLORS[p.id]}}/><strong>{names?.[p.id]??p.name}</strong><span>{p.finish===null?'Bitiremedi':raceTime(p.finish)}</span></li>)}</ol>{restart&&<button className="pl-button pl-primary" onClick={restart}>Yeniden oyna</button>}<small>{restart?'Harita ve oyuncu sayısı için Esc':'Lobiye dönülüyor…'}</small></section>}
  </div>;
}
