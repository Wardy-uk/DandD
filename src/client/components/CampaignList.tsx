import { useState, useEffect } from 'react';

interface Campaign {
  id: string;
  name: string;
  setting: string;
  status: string;
  session_number: number;
  character_count: number;
  player_count: number;
  created_at: string;
}

interface Props {
  apiUrl: string;
  player: { id: string; token: string; displayName: string };
  onJoinCampaign: (campaignId: string, characterId: string | null) => void;
}

export default function CampaignList({ apiUrl, player, onJoinCampaign }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [browseCampaigns, setBrowseCampaigns] = useState<Campaign[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSetting, setNewSetting] = useState('');

  const headers = { Authorization: `Bearer ${player.token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const fetchCampaigns = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/campaigns`, { headers });
      const data = await res.json();
      if (data.ok) setCampaigns(data.data);
    } catch (err) {
      console.error('Failed to fetch campaigns', err);
    } finally {
      setLoading(false);
    }
  };

  const createCampaign = async () => {
    if (!newName.trim()) return;
    try {
      const res = await fetch(`${apiUrl}/api/campaigns`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: newName, setting: newSetting }),
      });
      const data = await res.json();
      if (data.ok) {
        setShowCreate(false);
        setNewName('');
        setNewSetting('');
        fetchCampaigns();
      }
    } catch (err) {
      console.error('Failed to create campaign', err);
    }
  };

  const fetchBrowseCampaigns = async () => {
    setBrowseLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/campaigns/browse`, { headers });
      const data = await res.json();
      if (data.ok) setBrowseCampaigns(data.data);
    } catch (err) {
      console.error('Failed to browse campaigns', err);
    } finally {
      setBrowseLoading(false);
    }
  };

  const joinCampaign = async (campaignId: string) => {
    try {
      const res = await fetch(`${apiUrl}/api/campaigns/${campaignId}/join`, {
        method: 'POST',
        headers,
      });
      const data = await res.json();
      if (data.ok) {
        setShowJoin(false);
        setBrowseCampaigns([]);
        fetchCampaigns();
      }
    } catch (err) {
      console.error('Failed to join campaign', err);
    }
  };

  const enterCampaign = async (campaignId: string) => {
    // Check if player has a character in this campaign
    try {
      const res = await fetch(`${apiUrl}/api/campaigns/${campaignId}`, { headers });
      const data = await res.json();
      if (data.ok) {
        const myChar = data.data.characters.find((c: any) =>
          c.player_id === player.id && c.status !== 'dead'
        );
        onJoinCampaign(campaignId, myChar?.id || null);
      }
    } catch (err) {
      console.error('Failed to enter campaign', err);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-heading font-bold text-leather-dark tracking-wide">
          Your Campaigns
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowJoin(true); fetchBrowseCampaigns(); }}
            className="px-4 py-2 rounded-lg border border-leather/20 text-sm font-heading font-semibold text-leather hover:bg-leather/5 transition-colors"
          >
            Join Campaign
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 rounded-lg bg-leather text-parchment-light text-sm font-heading font-semibold hover:bg-leather-dark transition-colors"
          >
            New Campaign
          </button>
        </div>
      </div>

      {/* Campaign Cards */}
      {loading ? (
        <p className="text-ink-faint font-body italic text-center py-12">Loading campaigns...</p>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-leather/20 rounded-lg">
          <p className="text-ink-faint font-body italic mb-2">No campaigns yet</p>
          <p className="text-xs text-ink-faint font-body">Create a new campaign or join an existing one</p>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map(c => (
            <button
              key={c.id}
              onClick={() => enterCampaign(c.id)}
              className="w-full text-left border border-leather/15 rounded-lg p-5 bg-parchment-light/40 hover:bg-parchment-light/70 hover:border-leather/30 transition-all group"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-heading font-bold text-lg text-leather-dark group-hover:text-leather tracking-wide">
                    {c.name}
                  </h3>
                  {c.setting && (
                    <p className="text-sm text-ink-faint font-body mt-0.5 italic">{c.setting}</p>
                  )}
                </div>
                <span className={`text-xs font-heading font-semibold px-2 py-1 rounded ${
                  c.status === 'active' ? 'bg-heal/10 text-heal' : 'bg-ink-faint/10 text-ink-faint'
                }`}>
                  {c.status}
                </span>
              </div>
              <div className="flex gap-4 mt-3 text-xs text-ink-faint font-body">
                <span>Session {c.session_number}</span>
                <span>{c.player_count} player{c.player_count !== 1 ? 's' : ''}</span>
                <span>{c.character_count} character{c.character_count !== 1 ? 's' : ''}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Create Campaign Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-parchment border border-leather/20 rounded-lg p-8 w-full max-w-md shadow-xl">
            <h3 className="text-xl font-heading font-bold text-leather-dark mb-4">New Campaign</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-heading font-semibold text-ink-faint uppercase tracking-wider mb-1">
                  Campaign Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. The Tomb of Horrors"
                  className="w-full px-4 py-2.5 rounded-lg border border-leather/20 bg-parchment-light font-body text-sm focus:outline-none focus:border-leather/50"
                />
              </div>
              <div>
                <label className="block text-xs font-heading font-semibold text-ink-faint uppercase tracking-wider mb-1">
                  Setting
                </label>
                <textarea
                  value={newSetting}
                  onChange={e => setNewSetting(e.target.value)}
                  placeholder="Describe the world, era, and tone..."
                  rows={3}
                  className="w-full px-4 py-2.5 rounded-lg border border-leather/20 bg-parchment-light font-body text-sm focus:outline-none focus:border-leather/50 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 rounded-lg border border-leather/20 text-sm font-heading text-ink-faint hover:bg-parchment-dark/30">
                Cancel
              </button>
              <button onClick={createCampaign} className="flex-1 py-2.5 rounded-lg bg-leather text-parchment-light text-sm font-heading font-semibold hover:bg-leather-dark">
                Begin Adventure
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Join Campaign Modal */}
      {showJoin && (
        <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-parchment border border-leather/20 rounded-lg p-8 w-full max-w-md shadow-xl">
            <h3 className="text-xl font-heading font-bold text-leather-dark mb-4">Join a Campaign</h3>

            {browseLoading ? (
              <p className="text-ink-faint font-body italic text-center py-8">Searching for adventures...</p>
            ) : browseCampaigns.length === 0 ? (
              <p className="text-ink-faint font-body italic text-center py-8">No campaigns available to join right now.</p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {browseCampaigns.map(c => (
                  <div key={c.id} className="border border-leather/15 rounded-lg p-4 bg-parchment-light/40">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <h4 className="font-heading font-bold text-leather-dark truncate">{c.name}</h4>
                        {c.setting && (
                          <p className="text-xs text-ink-faint font-body mt-0.5 italic line-clamp-2">{c.setting}</p>
                        )}
                        <p className="text-xs text-ink-faint font-body mt-1">
                          {c.player_count} player{c.player_count !== 1 ? 's' : ''} &middot; {c.character_count} character{c.character_count !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => joinCampaign(c.id)}
                        className="ml-3 px-4 py-2 rounded-lg bg-leather text-parchment-light text-xs font-heading font-semibold hover:bg-leather-dark transition-colors flex-shrink-0"
                      >
                        Join
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => { setShowJoin(false); setBrowseCampaigns([]); }}
              className="w-full mt-4 py-2.5 rounded-lg border border-leather/20 text-sm font-heading text-ink-faint hover:bg-parchment-dark/30"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
