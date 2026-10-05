import { useEffect, useRef, useState } from 'react';
import { captureBinding } from '../../input/capture';
import { bindingLabel, changeBinding, conflicts, type Bindings } from '../../input/bindings';
import { ACTION_LABELS, type Action } from '../../input/actions';
import { defaultBindings } from '../../input/defaults';
import { RACE_ACTIONS, RACE_LABELS, changeRaceBinding, defaultRaceExtras, raceConflicts, type RaceAction, type RaceBindings, type RaceExtras } from './controls';

export default function RaceControls({ bindings, shared, onShared, onExtras, onClose, saved, online=false }: { bindings: RaceBindings; shared: Bindings; onShared: (b: Bindings) => void; onExtras: (b: RaceExtras) => void; onClose: () => void; saved: boolean;online?:boolean }) {
  const [capture, setCapture] = useState<{ action: RaceAction; slot: 0 | 1 } | null>(null), [notice, setNotice] = useState('');
  const button = useRef<HTMLButtonElement | null>(null), title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  useEffect(() => {
    if (!capture) { button.current?.focus(); return; }
    return captureBinding(binding => {
      const { action, slot } = capture;
      if (!binding) setNotice('Tuş atama iptal edildi.');
      else {
        const next = changeRaceBinding(bindings, action, slot, binding);
        const movement = action.startsWith('move');
        const sharedNext = movement ? changeBinding(shared, action as Action, slot, binding) : shared;
        if (next && sharedNext) {
          if (movement) onShared(sharedNext); else onExtras({ raceHandbrake: next.raceHandbrake, raceCamera: next.raceCamera, raceReset: next.raceReset });
          setNotice(`${RACE_LABELS[action]}: ${bindingLabel(binding)} atandı.`);
        } else {
          const used = [...raceConflicts(bindings, action, binding).map(a => RACE_LABELS[a]), ...(movement ? conflicts(shared, action as Action, binding).map(a => ACTION_LABELS[a]) : [])];
          setNotice(`${bindingLabel(binding)} zaten ${[...new Set(used)].join(', ')} için kullanılıyor. Önce o atamayı değiştir.`);
        }
      }
      setCapture(null);
    });
  }, [capture, bindings, shared, onShared, onExtras]);
  const remove = (action: RaceAction) => {
    if (action.startsWith('move')) { const next = changeBinding(shared, action as Action, 1, null); if (next) onShared(next); }
    else onExtras({ raceHandbrake: bindings.raceHandbrake, raceCamera: bindings.raceCamera, raceReset: bindings.raceReset, [action]: [bindings[action][0], null] });
  };
  return <div className="pl-race-menu-controls" data-party-controls>
    <button className="pl-button pl-join" disabled={!!capture} onClick={onClose}>← Menüye Dön</button>
    <h2 id="pl-menu-title" ref={title} tabIndex={-1}>Araba Yarışı kontrolleri</h2>
    <p>Bir atamayı seç, yeni tuşa veya fare düğmesine basıp bırak. Esc ile iptal et. {online?'Maç menü açıkken sürer.':'Yarış duraklatıldı.'}</p>
    <div role="status" className="pl-settings-feedback">{capture ? `${RACE_LABELS[capture.action]}: Yeni tuşa bas.` : notice || 'Atamalar bu tarayıcıda otomatik kaydedilir.'}</div>
    <div className="pl-binding-head"><span>Hareket</span><span>Birincil</span><span>İkincil</span></div>
    <div className="pl-binding-list">{RACE_ACTIONS.map(action => <div className="pl-binding-row" key={action}>
      <span className="pl-action-label">{RACE_LABELS[action]}</span>
      {([0, 1] as const).map(slot => <div className="pl-binding-slot" key={slot}>
        <button className="pl-binding-button" disabled={!!capture} aria-label={`${RACE_LABELS[action]} ${slot === 0 ? 'birincil' : 'ikincil'}: ${bindings[action][slot] ? bindingLabel(bindings[action][slot]!) : 'Ata'}`} onClick={event => { button.current = event.currentTarget; setCapture({ action, slot }); }}>{capture?.action === action && capture.slot === slot ? 'Bekleniyor…' : bindings[action][slot] ? bindingLabel(bindings[action][slot]!) : '+ Ata'}</button>
        {slot === 1 && bindings[action][slot] && <button className="pl-binding-remove" disabled={!!capture} aria-label={`${RACE_LABELS[action]} ikincil atamasını kaldır`} onClick={() => remove(action)}>Kaldır</button>}
      </div>)}
    </div>)}</div>
    {!saved && <p role="alert">Atamalar bu oturumda geçerli; tarayıcı kaydetmeye izin vermedi.</p>}
    <p>Gaz, fren ve yön tuşları ortak hareket atamalarını kullanır. El freni, kamera ve sıfırlama yalnız bu yarışa özeldir.</p>
    <button className="pl-button pl-join" disabled={!!capture} onClick={() => { const defaults = defaultBindings(); let next = shared; for (const action of ['moveForward', 'moveBackward', 'moveLeft', 'moveRight'] as const) next = { ...next, [action]: defaults[action] }; if (Object.keys(next).some(a => next[a as Action].some(b => b && conflicts(next, a as Action, b).length))) { setNotice('Ortak hareket tuşları başka eylemlerde kullanılıyor. Önce ortak Kontroller ekranından çakışmayı çöz.'); return; } onShared(next); onExtras(defaultRaceExtras()); setNotice('Varsayılan yarış kontrolleri geri yüklendi.'); }}>Varsayılana Dön</button>
    <p>3 tur. Virajdan önce yavaşla. Kısa el freni dokunuşu yönünü düzeltir; uzun tutmak hız kaybettirir. Çim daha yavaş ve kaygandır. Sıfırla, son geçerli kontrol noktasına döndürür. Esc: menü.</p>
  </div>;
}
