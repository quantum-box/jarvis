import { useEffect, useState } from 'react';
import { CoreScene } from './CoreScene';

/** Development-only visual fixture; never starts authentication, microphone, or an API call. */
export default function MotionPreview() {
  const [activity, setActivity] = useState<'idle'|'listening'|'thinking'|'speaking'>('idle');
  const [level, setLevel] = useState(0);
  const [renderer, setRenderer] = useState('');
  useEffect(() => {
    const start = performance.now();
    const timer = setInterval(() => {
      const time = (performance.now() - start) / 1000;
      setLevel(activity === 'speaking' ? Math.pow(.5 + .5 * Math.sin(time * 5), 2) * .85 : 0);
    }, 40);
    return () => clearInterval(timer);
  }, [activity]);
  return <main style={{maxWidth:900, margin:'auto', padding:24}}>
    <h1>球体の動きのプレビュー</h1>
    <p>開発用の模擬状態です。音声・APIには接続しません。</p>
    <div className="controls">{([['idle','待機'],['listening','聞く'],['thinking','思考中'],['speaking','発話中']] as const).map(([state,label]) => <button className="primary" aria-pressed={activity===state} key={state} onClick={() => setActivity(state)}>{label}</button>)}</div>
    <CoreScene level={level} active={activity !== 'idle'} activity={activity} onRenderer={setRenderer}/>
    <p aria-live="polite">{renderer} / {activity}</p>
  </main>;
}
