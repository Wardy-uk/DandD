import { useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import Login from './components/Login.js';
import CampaignList from './components/CampaignList.js';
import CharacterCreate from './components/CharacterCreate.js';
import GameView from './components/GameView.js';
import AdminPanel from './components/AdminPanel.js';

const API_URL = import.meta.env.VITE_API_URL || '';
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'https://pi5.tailecb90f.ts.net';

interface Player {
  id: string;
  username: string;
  displayName: string;
  role: string;
  token: string;
}

type View = 'login' | 'campaigns' | 'create-character' | 'game' | 'admin';

export default function App() {
  const [player, setPlayer] = useState<Player | null>(null);
  const [view, setView] = useState<View>('login');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Restore session from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('quest_player');
    if (stored) {
      try {
        const p = JSON.parse(stored) as Player;
        // Verify token is still valid
        fetch(`${API_URL}/api/auth/me`, {
          headers: { Authorization: `Bearer ${p.token}` },
        })
          .then(r => r.json())
          .then(data => {
            if (data.ok) {
              setPlayer(p);
              setView('campaigns');
            } else {
              localStorage.removeItem('quest_player');
            }
          })
          .catch(() => localStorage.removeItem('quest_player'));
      } catch {
        localStorage.removeItem('quest_player');
      }
    }
  }, []);

  // Connect socket when player is authenticated
  useEffect(() => {
    if (!player) return;

    const s = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      path: '/quest/socket.io',
    });

    s.on('connect', () => console.log('[Socket] Connected'));
    s.on('disconnect', () => console.log('[Socket] Disconnected'));

    setSocket(s);
    return () => { s.disconnect(); };
  }, [player]);

  const handleLogin = useCallback((p: Player) => {
    setPlayer(p);
    localStorage.setItem('quest_player', JSON.stringify(p));
    setView('campaigns');
  }, []);

  const handleLogout = useCallback(() => {
    setPlayer(null);
    localStorage.removeItem('quest_player');
    socket?.disconnect();
    setSocket(null);
    setView('login');
  }, [socket]);

  const handleJoinCampaign = useCallback((cId: string, charId: string | null) => {
    setCampaignId(cId);
    if (charId) {
      setCharacterId(charId);
      setView('game');
    } else {
      setView('create-character');
    }
  }, []);

  const handleCharacterCreated = useCallback((charId: string) => {
    setCharacterId(charId);
    setView('game');
  }, []);

  const handleBackToCampaigns = useCallback(() => {
    if (socket && campaignId) {
      socket.emit('game:leave', { campaignId });
    }
    setCampaignId(null);
    setCharacterId(null);
    setView('campaigns');
  }, [socket, campaignId]);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-leather/20 bg-parchment-dark/30">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-heading font-bold text-leather-dark tracking-wide">
              QUEST
            </span>
            <span className="text-xs text-ink-faint font-body italic">
              AI Dungeon Master &mdash; AD&D 2nd Edition
            </span>
          </div>
          {player && (
            <div className="flex items-center gap-4">
              <span className="text-sm text-ink-faint font-body">
                {player.displayName}
              </span>
              {player.role === 'admin' && (
                <button
                  onClick={() => setView(view === 'admin' ? 'campaigns' : 'admin')}
                  className={`text-xs font-body transition-colors ${view === 'admin' ? 'text-leather-dark font-semibold' : 'text-leather hover:text-leather-dark'}`}
                >
                  {view === 'admin' ? 'Campaigns' : 'Admin'}
                </button>
              )}
              <button
                onClick={handleLogout}
                className="text-xs text-leather hover:text-blood transition-colors font-body"
              >
                Sign Out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {view === 'login' && (
          <Login apiUrl={API_URL} onLogin={handleLogin} />
        )}
        {view === 'campaigns' && player && (
          <CampaignList
            apiUrl={API_URL}
            player={player}
            onJoinCampaign={handleJoinCampaign}
          />
        )}
        {view === 'create-character' && player && campaignId && (
          <CharacterCreate
            apiUrl={API_URL}
            player={player}
            campaignId={campaignId}
            onCreated={handleCharacterCreated}
            onBack={handleBackToCampaigns}
          />
        )}
        {view === 'game' && player && campaignId && socket && (
          <GameView
            apiUrl={API_URL}
            player={player}
            campaignId={campaignId}
            characterId={characterId}
            socket={socket}
            onBack={handleBackToCampaigns}
          />
        )}
        {view === 'admin' && player && player.role === 'admin' && (
          <AdminPanel apiUrl={API_URL} player={player} />
        )}
      </main>
    </div>
  );
}
