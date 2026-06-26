import { useState, useEffect } from 'react';
import { setVolume, mute, unmute, getVolume, isMuted, initFromStorage } from '../audio/audioEngine.js';

export default function VolumeControl() {
  const [vol, setVol] = useState(40);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    initFromStorage();
    setVol(Math.round(getVolume() * 100));
    setMuted(isMuted());
  }, []);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVol(v);
    setVolume(v / 100);
    if (muted && v > 0) {
      unmute();
      setMuted(false);
    }
  };

  const handleMuteToggle = () => {
    if (muted) {
      unmute();
      setMuted(false);
    } else {
      mute();
      setMuted(true);
    }
  };

  const icon = muted || vol === 0 ? '🔇' : vol < 50 ? '🔈' : '🔊';

  return (
    <div className="flex items-center gap-1.5" title={muted ? 'Unmute audio' : 'Mute audio'}>
      <button
        onClick={handleMuteToggle}
        className="text-sm leading-none text-ink-faint hover:text-ink transition-colors select-none"
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        {icon}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={muted ? 0 : vol}
        onChange={handleVolumeChange}
        className="w-14 h-1 cursor-pointer accent-leather opacity-70 hover:opacity-100 transition-opacity"
        aria-label="Volume"
      />
    </div>
  );
}
