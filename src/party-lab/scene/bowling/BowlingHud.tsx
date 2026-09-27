import { BOWLING_DRIVE_PRESETS } from './camera';
import type { BowlingPhase } from './game';
import './bowling.css';
import { FLIGHT } from './config';
export interface BowlingSnapshot {
  phase: BowlingPhase; player: number; round: number; totals: number[]; throws: number[][];
  charging:boolean;nudgeUsed:boolean;angle:number;angleDirection:'rising'|'falling';airHint:boolean; speed: number; countdown: number; inZone: boolean; missedEject: boolean; knocked: number; lastPoints: number; lastPlayer: number;
  cameraPreset?: number; cameraNotice?: number; winners: number[]; retry: boolean; debug?: Record<string, unknown>;
}
export const bowlingPlayerName = (id: number) => id === 0 ? 'Sen' : id === 1 ? 'Misket' : 'Fırtına';
export default function BowlingHud({ snapshot: s, restart, debugOpen }: { snapshot: BowlingSnapshot; restart: () => void; debugOpen: boolean }) {
  const mine = s.player === 0, driving = s.phase === 'drive', result = s.phase === 'results';
  return <div className="pl-bowling-hud">
    <div className="pl-bowling-title"><span>PARTY LAB / YEREL</span><b>İnsan Bowlingi</b></div>
    {driving && !!s.cameraNotice && <div key={s.cameraNotice} className="pl-bowling-camera-notice" role="status">KAMERA · {BOWLING_DRIVE_PRESETS[s.cameraPreset ?? 1].label}</div>}
    <ol className="pl-bowling-scores" aria-label="Toplam puanlar">{s.totals.map((total, i) => <li key={i} data-active={!result && s.player === i}>
      <span className="pl-bowling-slot" style={{ background: ['#f6c773', '#e985a2', '#79bbed'][i] }}>{i + 1}</span>
      <span><b>{bowlingPlayerName(i)}{i > 0 && <small> BOT</small>}</b><span className="pl-bowling-throws">{[0, 1, 2].map(n => <span key={n}>{s.throws[i][n] ?? '·'}</span>)}</span></span><strong>{total}<small>/30</small></strong>
    </li>)}</ol>
    {!result && <div className="pl-bowling-turn" role="status"><b>{bowlingPlayerName(s.player)} · Atış {s.round}/3</b><span>{s.phase === 'countdown' ? 'Direksiyona geç!' : driving ? mine ? 'Hızlan · Hizalan · Fırlat' : 'Piste çıkıyor…' : s.phase === 'score' ? 'Sıradaki oyuncu hazırlanıyor' : s.airHint ? 'Havada yön ver!' : 'Bırak yuvarlansın!'}</span></div>}
    {s.phase === 'countdown' && <div className="pl-bowling-countdown" role="status">{s.countdown}</div>}
    <aside className="pl-bowling-charge" data-charging={s.charging} data-direction={s.angleDirection} aria-label="Atış göstergeleri">
      <div className="pl-bowling-meter-label"><b>FIRLATMA AÇISI</b><span aria-label={s.charging ? s.angleDirection==='rising' ? 'Açı yükseliyor' : 'Açı azalıyor' : undefined}>{s.charging ? s.angleDirection==='rising' ? '↗' : '↘' : driving || s.phase==='countdown' ? 'SPACE TUT' : 'KİLİTLİ'}</span></div>
      <svg className="pl-bowling-dial" data-angle={s.angle} viewBox="0 0 240 150" role="meter" aria-label="Fırlatma açısı" aria-valuenow={Math.round(s.angle)} aria-valuemin={FLIGHT.angleMin} aria-valuemax={FLIGHT.angleMax}>
        <path className="pl-bowling-dial-track" d="M 178 132 A 130 130 0 0 0 92.46 9.84" />
        {[0,5,10,15,20,25,30].map(degree=>{const a=degree/30*70*Math.PI/180;return <g key={degree}><line x1={48+130*Math.cos(a)} y1={132-130*Math.sin(a)} x2={48+120*Math.cos(a)} y2={132-120*Math.sin(a)} /><text x={48+150*Math.cos(a)} y={136-140*Math.sin(a)}>{degree}°</text></g>;})}
        <g className="pl-bowling-needle" transform={`rotate(${-s.angle/30*70} 48 132)`}><path d="M 48 128 L 175 132 L 48 136 Z" /></g>
        <circle cx="48" cy="132" r="6" />
        <text className="pl-bowling-degrees" x="55" y="85">{Math.round(s.angle)}°</text>
      </svg>
      <div className="pl-bowling-range"><span>ALÇAK</span><b>{s.charging ? '0,40× · AĞIR ÇEKİM' : 'AÇI'}</b><span>YÜKSEK</span></div>
      <p className={s.phase==='flight'?'pl-bowling-nudge':undefined} data-used={s.nudgeUsed}>{s.charging ? 'SPACE’i bırak · Fırla' : driving ? s.inZone ? 'SPACE tut · Açı gidip gelir, bırakınca fırlarsın' : 'Sarı bölgeye ulaş · SPACE ile açı seç' : s.phase==='flight' ? s.nudgeUsed ? 'NUDGE · KULLANILDI' : s.airHint ? 'SPACE · NUDGE · HAZIR' : 'NUDGE: UÇUŞ BİTTİ' : 'W · Gaz   S · Fren   A / D · Direksiyon'}</p>
    </aside>
    {!result && <aside className="pl-bowling-speedometer" aria-label="Gerçek hız"><span>{s.phase==='flight' ? 'BEDEN HIZI' : 'ARAÇ HIZI'}</span><strong>{Math.round(s.speed*3.6)}</strong><b>km/sa</b></aside>}
    {!result && (driving || s.phase==='countdown') && <div className="pl-bowling-drive">
      <b>{s.charging ? 'ANI SEÇ.' : mine ? 'HIZLAN. HİZALAN.' : 'BOT SÜRÜYOR'}</b>
      <p>W / S · Gaz / Fren &nbsp; A / D · Direksiyon &nbsp; <span className="pl-bowling-camera-key">V · Kamera</span></p>
      <span data-zone={s.inZone}>{s.inZone ? s.charging ? 'Açı gidip geliyor · Araç hâlâ ilerliyor' : 'FIRLATMA BÖLGESİ · SPACE’i basılı tut' : 'Bayırda hız topla, topların arasından geç'}</span>
    </div>}
    {s.airHint && <div className="pl-bowling-air">A / D · Yön &nbsp; W / S veya ↑ / ↓ · Beden açısı<br />W · İleri eğil &nbsp; SPACE · Tek ileri + yukarı Nudge</div>}
    {s.phase === 'flight' && <div className="pl-bowling-hit"><strong>{s.knocked}</strong><span>/ 10 devrildi</span></div>}
    {s.phase === 'score' && <div className="pl-bowling-callout" role="status"><strong>{s.missedEject ? 'Fırlatamadın!' : s.lastPoints === 10 ? 'TAM İSABET!' : `${s.lastPoints} lobut!`}</strong><span>{bowlingPlayerName(s.lastPlayer)} · +{s.lastPoints} puan</span></div>}
    {s.retry && <div className="pl-bowling-retry" role="status">Atış yenilendi. Bir daha deneyelim!</div>}
    {result && <div className="pl-bowling-result" role="status"><span>3 ATIŞ · SONUÇ</span><h2>{s.winners.length > 1 ? 'Berabere!' : `${bowlingPlayerName(s.winners[0])} kazandı!`}</h2><p>{s.winners.map(bowlingPlayerName).join(' & ')} · {Math.max(...s.totals)} puan</p><button type="button" className="pl-button pl-create" onClick={restart}>Bir daha oyna</button></div>}
    {s.debug && <pre className="pl-bowling-debug" hidden={!debugOpen} data-bowling={JSON.stringify(s.debug)}>{JSON.stringify(s.debug, null, 2)}</pre>}
  </div>;
}
