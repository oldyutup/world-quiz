import { useEffect, useState } from 'react';
import { captureBinding } from '../../input/capture';
import { actionBindingLabel, changeBinding, type Bindings } from '../../input/bindings';
import { defaultBindings } from '../../input/defaults';
export default function ClassicControls({ bindings, onBindings, onClose }: { bindings: Bindings; onBindings: (b: Bindings) => void; onClose: () => void }) {
  const [capture, setCapture] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => {
    if (!capture) return;
    return captureBinding(key => {
      if (key) {
        const next = changeBinding(bindings, 'jump', 0, key);
        if (next) { onBindings(next); setNotice('Seçim tuşu kaydedildi.'); }
        else setNotice('Bu tuş başka bir harekete atanmış. Farklı bir tuş seç.');
      }
      setCapture(false);
    });
  }, [capture, bindings, onBindings]);
  return <div data-party-controls className="pl-classic-controls">
    <button className="pl-button pl-join" disabled={capture} onClick={onClose}>← Menüye Dön</button>
    <h2 id="pl-menu-title">Klasik Bowling kontrolleri</h2>
    <p>Üç kez bas: konumu seç, yönü seç, topu at. Göstergeler sürekli gidip gelir. Basılı tutmak bir sonraki aşamayı seçmez.</p>
    <button className="pl-button" aria-label="Seç / At tuşunu değiştir" disabled={capture} onClick={() => setCapture(true)}>{capture ? 'Yeni tuşa bas…' : `Seç / At: ${actionBindingLabel(bindings, 'jump')}`}</button>
    <button className="pl-button" disabled={capture} onClick={() => { const next = changeBinding(bindings, 'jump', 0, defaultBindings().jump[0]); if (next) { onBindings({ ...next, jump: [next.jump[0], null] }); setNotice('SPACE geri yüklendi.'); } else setNotice('SPACE başka bir harekete atanmış. Ana kontrollerden önce onu değiştir.'); }}>Varsayılan tuş</button>
    <p role="status">{notice}</p><p>Bu seçim, Party Lab’in ortak Zıpla atamasını kullanır. Maç menü açıkken duraklar.</p>
    <p>3 tur, tur başına en fazla 2 atış. Her devrilen pin 1 puan. İlk atışta 10 pin: strike. İki atışta 10 pin: spare. Gelecek turlardan bonus yok.</p>
  </div>;
}
