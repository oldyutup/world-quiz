import { useEffect, useRef, useState } from 'react';
import { captureBinding } from '../../input/capture';
import { bindingLabel } from '../../input/bindings';
import { CRATE_ACTIONS, CRATE_LABELS, changeCrateBinding, type CrateAction, type CrateBindings, type CrateOverrides } from './controls';

export default function CrateControls({ bindings, onChange, onClose, saved }: { bindings: CrateBindings; onChange: (b: CrateOverrides) => void; onClose: () => void; saved: boolean }) {
  const [capture, setCapture] = useState<{ action: CrateAction; slot: 0 | 1 } | null>(null), [notice, setNotice] = useState('');
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!capture) { button.current?.focus(); return; }
    return captureBinding(key => {
      if (key) {
        const next = changeCrateBinding(bindings, capture.action, capture.slot, key);
        if (next) { onChange(next); setNotice(`${CRATE_LABELS[capture.action]}: ${bindingLabel(key)} atandı.`); }
        else setNotice('Kullanılmayan bir klavye tuşu seç. Fareyle bakmak isteğe bağlıdır.');
      } else setNotice('Tuş atama iptal edildi.');
      setCapture(null);
    });
  }, [capture, bindings, onChange]);
  return <div className="pl-crate-menu-controls" data-party-controls>
    <button className="pl-button pl-join" disabled={!!capture} onClick={onClose}>← Menüye Dön</button>
    <h2 id="pl-menu-title">Kutu Yağmuru kontrolleri</h2>
    <p>İki kamera da klavyeyle oynanır. Oyuna bir kez tıkla, fare veya izleme dörtgenini basılı tutmadan hareket ettirerek bak. Esc ile imleci serbest bırak.</p>
    <div role="status">{capture ? 'Yeni tuşa basıp bırak. Esc: iptal.' : notice || 'Atamalar yalnız Kutu Yağmuru için kaydedilir.'}</div>
    <div className="pl-binding-list">{CRATE_ACTIONS.map(action => <div className="pl-binding-row" key={action}>
      <span className="pl-action-label">{CRATE_LABELS[action]}</span>
      {([0, 1] as const).map(slot => <div className="pl-binding-slot" key={slot}>
        <button className="pl-binding-button" disabled={!!capture} aria-label={`${CRATE_LABELS[action]} ${slot === 0 ? 'birincil' : 'ikincil'} tuşu`} onClick={e => { button.current = e.currentTarget; setCapture({ action, slot }); }}>{bindings[action][slot] ? bindingLabel(bindings[action][slot]!) : '+ Ata'}</button>
        {slot === 1 && bindings[action][slot] && <button className="pl-binding-remove" disabled={!!capture} onClick={() => { const next = changeCrateBinding(bindings, action, 1, null); if (next) onChange(next); }}>Kaldır</button>}
      </div>)}
    </div>)}</div>
    {!saved && <p role="alert">Tarayıcı kaydetmedi. Atamalar bu oturumda geçerli.</p>}
    <button className="pl-button pl-join" disabled={!!capture} onClick={() => { onChange({}); setNotice('Ortak hareket atamaları ve varsayılan kamera tuşları geri yüklendi.'); }}>Varsayılana Dön</button>
    <p>Gölgeleri ve düşüş sesini takip et. Kutular kalır; zıplayıp yığınlara tırman. Son kalan turu kazanır. Esc: menü ve duraklatma.</p>
  </div>;
}
