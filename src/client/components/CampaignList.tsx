import { useState, useEffect } from 'react';
import type { CampaignSettingOption } from '../../shared/campaignSettings.js';
import type { CampaignStartMode } from '../../shared/campaignModes.js';
import Chronicle from './Chronicle.js';

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
  onOpenRoster: () => void;
}

export default function CampaignList({ apiUrl, player, onJoinCampaign, onOpenRoster }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [settingOptions, setSettingOptions] = useState<CampaignSettingOption[]>([]);
  const [defaultSettingId, setDefaultSettingId] = useState('');
  const [startModes, setStartModes] = useState<Array<{ id: CampaignStartMode; name: string; summary: string }>>([]);
  const [defaultStartMode, setDefaultStartMode] = useState<CampaignStartMode>('solo');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [browseCampaigns, setBrowseCampaigns] = useState<Campaign[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSettingId, setNewSettingId] = useState('');
  const [newStartMode, setNewStartMode] = useState<CampaignStartMode>('solo');
  const [chronicleCampaign, setChronicle] = useState<{ id: string; name: string } | null>(null);

  const headers = { Authorization: `Bearer ${player.token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    fetchCampaigns();
    fetchSettingOptions();
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

  const fetchSettingOptions = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/campaigns/settings`, { headers });
      const data = await res.json();
      if (data.ok) {
        setSettingOptions(data.data.options || []);
        setDefaultSettingId(data.data.defaultSettingId || '');
        setStartModes(data.data.startModes || []);
        setDefaultStartMode(data.data.defaultStartMode || 'solo');
        setNewSettingId((current: string) => current || data.data.defaultSettingId || '');
        setNewStartMode(data.data.defaultStartMode || 'solo');
      }
    } catch (err) {
      console.error('Failed to fetch campaign settings', err);
    }
  };

  const createCampaign = async () => {
    if (!newSettingId.trim() || creating) return;
    const suggestedName = selectedSetting?.suggestedNames?.[0] || '';
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch(`${apiUrl}/api/campaigns`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: newName.trim() || suggestedName, settingId: newSettingId, startMode: newStartMode }),
      });
      const data = await res.json();
      if (data.ok) {
        setShowCreate(false);
        setNewName('');
        setNewSettingId(defaultSettingId || settingOptions[0]?.id || '');
        setNewStartMode(defaultStartMode || 'solo');
        setCreateError('');
        fetchCampaigns();
      } else {
        setCreateError(data.error || 'Failed to create campaign. Try again.');
      }
    } catch (err) {
      console.error('Failed to create campaign', err);
      setCreateError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCreating(false);
    }
  };

  const selectedSetting = settingOptions.find((option) => option.id === newSettingId) || null;
  const suggestedNames = selectedSetting?.suggestedNames || [];
  const previewSetting = selectedSetting || settingOptions[0] || null;

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
        onJoinCampaign(campaignId, null);
      }
    } catch (err) {
      console.error('Failed to join campaign', err);
    }
  };

  const enterCampaign = async (campaignId: string) => {
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
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-heading font-bold text-leather-dark tracking-wide sm:text-3xl">
          Your Campaigns
        </h2>
        <div className="grid grid-cols-3 gap-2 sm:flex">
          <button
            onClick={onOpenRoster}
            className="px-4 py-2 rounded-lg border border-leather/20 text-sm font-heading font-semibold text-leather hover:bg-leather/5 transition-colors"
          >
            My Adventurers
          </button>
          <button
            onClick={() => { setShowJoin(true); fetchBrowseCampaigns(); }}
            className="px-4 py-2 rounded-lg border border-leather/20 text-sm font-heading font-semibold text-leather hover:bg-leather/5 transition-colors"
          >
            Join Campaign
          </button>
          <button
            onClick={() => { setShowCreate(true); setCreateError(''); }}
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
            <div
              key={c.id}
              className="group rounded-lg border border-leather/15 bg-parchment-light/40 p-4 transition-all hover:border-leather/30 hover:bg-parchment-light/70 sm:p-5"
            >
              {/* Clickable header area — enters campaign */}
              <button
                className="w-full text-left"
                onClick={() => enterCampaign(c.id)}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="truncate font-heading text-base font-bold tracking-wide text-leather-dark group-hover:text-leather sm:text-lg">
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
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint font-body">
                  <span>Session {c.session_number}</span>
                  <span>{c.player_count} player{c.player_count !== 1 ? 's' : ''}</span>
                  <span>{c.character_count} character{c.character_count !== 1 ? 's' : ''}</span>
                </div>
              </button>

              {/* Campaign actions */}
              <div className="mt-3 flex gap-2 border-t border-leather/10 pt-3">
                <button
                  onClick={() => enterCampaign(c.id)}
                  className="flex-1 rounded-md bg-leather px-3 py-1.5 text-xs font-heading font-semibold text-parchment-light hover:bg-leather-dark transition-colors"
                >
                  Play
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setChronicle({ id: c.id, name: c.name }); }}
                  className="flex-1 rounded-md border border-leather/20 px-3 py-1.5 text-xs font-heading font-semibold text-leather hover:bg-leather/10 transition-colors"
                >
                  📜 Chronicle
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chronicle Modal */}
      {chronicleCampaign && (
        <Chronicle
          campaignId={chronicleCampaign.id}
          campaignName={chronicleCampaign.name}
          apiUrl={apiUrl}
          player={player}
          onClose={() => setChronicle(null)}
        />
      )}

      {/* Create Campaign Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-3 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-3xl rounded-t-2xl sm:rounded-lg border border-leather/20 bg-parchment p-4 shadow-xl sm:p-8 max-h-[92vh] overflow-y-auto">
            <h3 className="text-xl font-heading font-bold text-leather-dark mb-1">New Campaign</h3>
            <p className="mb-4 text-sm font-body italic text-ink-faint">
              Pick a setting first. The campaign title is optional.
            </p>
            <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
              <div className="space-y-4">
                <label className="block text-xs font-heading font-semibold text-ink-faint uppercase tracking-wider mb-1">
                  Setting
                </label>
                <div className="space-y-2 max-h-72 overflow-y-auto rounded-lg border border-leather/15 bg-parchment-light/50 p-2">
                  {settingOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setNewSettingId(option.id);
                        if (!newName.trim()) {
                          setNewName(option.suggestedNames?.[0] || '');
                        }
                      }}
                      className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                        newSettingId === option.id
                          ? 'border-leather bg-leather/10'
                          : 'border-leather/10 bg-parchment hover:border-leather/30 hover:bg-parchment-light'
                      }`}
                    >
                      <div className="font-heading font-semibold text-sm text-leather-dark">{option.name}</div>
                      <div className="mt-1 text-xs font-body italic text-ink-faint">{option.summary}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {option.gameplayFocus.slice(0, 3).map((focus) => (
                          <span
                            key={focus}
                            className="rounded-full border border-leather/10 bg-parchment px-2 py-0.5 text-[10px] font-heading uppercase tracking-wide text-ink-faint"
                          >
                            {focus}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
                <label className="block text-xs font-heading font-semibold text-ink-faint uppercase tracking-wider mb-1">
                  Starting Mode
                </label>
                <div className="grid gap-2">
                  {startModes.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => setNewStartMode(mode.id)}
                      className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                        newStartMode === mode.id
                          ? 'border-leather bg-leather/10'
                          : 'border-leather/10 bg-parchment hover:border-leather/30 hover:bg-parchment-light'
                      }`}
                    >
                      <div className="font-heading font-semibold text-sm text-leather-dark">{mode.name}</div>
                      <div className="mt-1 text-xs font-body italic text-ink-faint">{mode.summary}</div>
                    </button>
                  ))}
                </div>
                <label className="block text-xs font-heading font-semibold text-ink-faint uppercase tracking-wider mb-1">
                  Campaign Title
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder={selectedSetting?.suggestedNames?.[0] || 'Optional custom title'}
                  className="w-full px-4 py-2.5 rounded-lg border border-leather/20 bg-parchment-light font-body text-sm focus:outline-none focus:border-leather/50"
                />
                <p className="mt-2 text-xs font-body text-ink-faint">
                  Leave this blank and QUEST will use a fitting title for the setting.
                </p>
              </div>
              {previewSetting && (
                <div className="rounded-2xl border border-leather/15 bg-[radial-gradient(circle_at_top,rgba(255,248,231,0.95),rgba(241,231,210,0.72))] p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-heading uppercase tracking-[0.24em] text-ink-faint">Adventure Dossier</p>
                      <h4 className="mt-1 font-heading text-xl font-bold text-leather-dark">{previewSetting.name}</h4>
                      <p className="mt-1 text-sm font-body italic text-ink-faint">{previewSetting.tone}</p>
                    </div>
                    <span className="rounded-full border border-leather/15 bg-parchment px-3 py-1 text-[10px] font-heading uppercase tracking-wide text-leather">
                      {newStartMode === 'party' ? 'Party Start' : 'Solo Start'}
                    </span>
                  </div>

                  <div className="mt-4 rounded-xl border border-leather/10 bg-parchment/60 p-3">
                    <p className="text-[10px] font-heading font-bold uppercase tracking-[0.18em] text-ink-faint">Opening Situation</p>
                    <p className="mt-2 text-sm font-body leading-relaxed text-ink">{previewSetting.openingSituation}</p>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <DossierBlock title="Play Focus" items={previewSetting.gameplayFocus} tone="leather" />
                    <DossierBlock title="Signature Threats" items={previewSetting.signatureThreats} tone="blood" />
                    <DossierBlock title="Treasure Style" items={previewSetting.treasureStyle} tone="gold" />
                    <DossierBlock title="Best Party Fit" items={previewSetting.partyFit} tone="forest" />
                  </div>

                  {suggestedNames.length > 0 && (
                    <div className="mt-4">
                      <p className="text-[10px] font-heading font-bold uppercase tracking-[0.18em] text-ink-faint">Suggested Titles</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {suggestedNames.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => setNewName(name)}
                            className={`rounded-full border px-3 py-1 text-[11px] font-heading transition-colors ${
                              newName === name
                                ? 'border-leather bg-leather text-parchment-light'
                                : 'border-leather/20 text-leather hover:bg-leather/5'
                            }`}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            {createError && (
              <p className="mt-4 rounded-lg border border-blood/20 bg-blood/5 px-3 py-2 text-sm font-body text-blood">
                {createError}
              </p>
            )}
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => { setShowCreate(false); setCreateError(''); }}
                disabled={creating}
                className="flex-1 py-2.5 rounded-lg border border-leather/20 text-sm font-heading text-ink-faint hover:bg-parchment-dark/30 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={createCampaign}
                disabled={creating || !newSettingId}
                className="flex-1 py-2.5 rounded-lg bg-leather text-parchment-light text-sm font-heading font-semibold hover:bg-leather-dark disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {creating ? 'Creating...' : 'Begin Adventure'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Join Campaign Modal */}
      {showJoin && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-3 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-md rounded-t-2xl sm:rounded-lg border border-leather/20 bg-parchment p-4 shadow-xl sm:p-8 max-h-[92vh] overflow-y-auto">
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

function DossierBlock({ title, items, tone }: { title: string; items: string[]; tone: 'leather' | 'blood' | 'gold' | 'forest' }) {
  const toneClasses = {
    leather: 'border-leather/10 bg-parchment/60 text-leather',
    blood: 'border-blood/10 bg-blood/5 text-blood',
    gold: 'border-gold/10 bg-gold/5 text-gold',
    forest: 'border-forest/10 bg-forest/5 text-forest',
  } satisfies Record<'leather' | 'blood' | 'gold' | 'forest', string>;

  return (
    <div className={`rounded-xl border p-3 ${toneClasses[tone]}`}>
      <p className="text-[10px] font-heading font-bold uppercase tracking-[0.18em]">{title}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span key={item} className="rounded-full border border-current/15 bg-white/35 px-2.5 py-1 text-[10px] font-heading uppercase tracking-wide">
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
