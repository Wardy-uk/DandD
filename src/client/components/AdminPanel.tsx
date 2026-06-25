import { useEffect, useState } from 'react';

interface User {
  id: string;
  username: string;
  display_name: string;
  role: string;
  created_at: string;
  last_seen: string | null;
}

interface AppSettings {
  allowRegistration: boolean;
  allowCampaignCreation: boolean;
  defaultAiGrowthEnabled: boolean;
  defaultTargetSceneBuffer: number;
  defaultTargetNpcBuffer: number;
}

interface RuntimeInfo {
  ollamaReachable: boolean;
  models: string[];
  activeModel: string;
  fastModel: string;
  nightlyGrowthHourUtc: number;
  runtimeMode: string;
}

interface Campaign {
  id: string;
  name: string;
  setting: string;
  status: string;
  session_number: number;
  player_count: number;
  character_count: number;
  scene_count: number;
  npc_count: number;
  ai_growth_enabled: number;
  target_scene_buffer: number;
  target_npc_buffer: number;
  last_growth_check_at: string | null;
  last_growth_build_at: string | null;
}

type AdminTab = 'users' | 'settings' | 'campaigns';

interface Props {
  apiUrl: string;
  player: { id: string; token: string };
}

export default function AdminPanel({ apiUrl, player }: Props) {
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<User[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [runningGrowthId, setRunningGrowthId] = useState<string | null>(null);
  const [runningNightlyId, setRunningNightlyId] = useState<string | null>(null);

  const headers = { Authorization: `Bearer ${player.token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    void loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [usersRes, settingsRes, campaignsRes] = await Promise.all([
        fetch(`${apiUrl}/api/admin/users`, { headers }),
        fetch(`${apiUrl}/api/admin/settings`, { headers }),
        fetch(`${apiUrl}/api/admin/campaigns`, { headers }),
      ]);

      const [usersData, settingsData, campaignsData] = await Promise.all([
        usersRes.json(),
        settingsRes.json(),
        campaignsRes.json(),
      ]);

      if (usersData.ok) setUsers(usersData.data);
      if (settingsData.ok) {
        setSettings(settingsData.data.settings);
        setRuntime(settingsData.data.runtime);
      }
      if (campaignsData.ok) setCampaigns(campaignsData.data);
    } catch (err) {
      console.error('Failed to load admin data', err);
      showMessage('Failed to load admin data');
    } finally {
      setLoading(false);
    }
  };

  const showMessage = (msg: string) => {
    setMessage(msg);
    window.clearTimeout((showMessage as any)._timeout);
    (showMessage as any)._timeout = window.setTimeout(() => setMessage(''), 3200);
  };

  const formatDate = (d: string | null) => {
    if (!d) return 'Never';
    return new Date(d + 'Z').toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const toggleRole = async (userId: string, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'player' : 'admin';
    try {
      const res = await fetch(`${apiUrl}/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (data.ok) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
        showMessage(`Role updated to ${newRole}`);
      }
    } catch {
      showMessage('Failed to update role');
    }
  };

  const saveDisplayName = async (userId: string) => {
    try {
      const res = await fetch(`${apiUrl}/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ displayName: editName }),
      });
      const data = await res.json();
      if (data.ok) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, display_name: editName } : u)));
        setEditingId(null);
        showMessage('Display name updated');
      }
    } catch {
      showMessage('Failed to update name');
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (!resetPassword || resetPassword.length < 4) {
      showMessage('Password must be at least 4 characters');
      return;
    }

    try {
      const res = await fetch(`${apiUrl}/api/admin/users/${userId}/reset-password`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: resetPassword }),
      });
      const data = await res.json();
      if (data.ok) {
        setResetId(null);
        setResetPassword('');
        showMessage('Password reset successfully');
      }
    } catch {
      showMessage('Failed to reset password');
    }
  };

  const deleteUser = async (userId: string, username: string) => {
    if (!confirm(`Delete user "${username}"? This will remove all their characters too.`)) return;
    try {
      const res = await fetch(`${apiUrl}/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers,
      });
      const data = await res.json();
      if (data.ok) {
        setUsers((prev) => prev.filter((u) => u.id !== userId));
        showMessage(`User "${username}" deleted`);
      } else {
        showMessage(data.error || 'Failed to delete user');
      }
    } catch {
      showMessage('Failed to delete user');
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const res = await fetch(`${apiUrl}/api/admin/settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (data.ok) {
        setSettings(data.data);
        showMessage('Settings saved');
      }
    } catch {
      showMessage('Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  const updateCampaign = async (campaignId: string, patch: Record<string, unknown>) => {
    try {
      const res = await fetch(`${apiUrl}/api/admin/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.ok) {
        setCampaigns((prev) => prev.map((campaign) => {
          if (campaign.id !== campaignId) return campaign;
          return {
            ...campaign,
            ...Object.fromEntries(
              Object.entries(patch).map(([key, value]) => {
                if (key === 'aiGrowthEnabled') return ['ai_growth_enabled', value ? 1 : 0];
                if (key === 'targetSceneBuffer') return ['target_scene_buffer', value];
                if (key === 'targetNpcBuffer') return ['target_npc_buffer', value];
                return [key, value];
              }),
            ),
          } as Campaign;
        }));
        showMessage('Campaign updated');
      }
    } catch {
      showMessage('Failed to update campaign');
    }
  };

  const runGrowth = async (campaignId: string) => {
    setRunningGrowthId(campaignId);
    try {
      const res = await fetch(`${apiUrl}/api/admin/campaigns/${campaignId}/growth/run`, {
        method: 'POST',
        headers,
      });
      const data = await res.json();
      if (data.ok) {
        showMessage(data.data.summary || 'Growth run completed');
        await loadAll();
      } else {
        showMessage(data.error || 'Growth run failed');
      }
    } catch {
      showMessage('Growth run failed');
    } finally {
      setRunningGrowthId(null);
    }
  };

  const runNightly = async (campaignId: string) => {
    setRunningNightlyId(campaignId);
    try {
      const res = await fetch(`${apiUrl}/api/admin/campaigns/${campaignId}/nightly/run`, {
        method: 'POST',
        headers,
      });
      const data = await res.json();
      if (data.ok) {
        const r = data.data;
        const parts: string[] = [];
        if (r.factionChanges?.length)  parts.push(`${r.factionChanges.length} faction shift${r.factionChanges.length > 1 ? 's' : ''}`);
        if (r.rivalUpdates?.length)    parts.push(`${r.rivalUpdates.length} rival move${r.rivalUpdates.length > 1 ? 's' : ''}`);
        if (r.companionBeats?.length)  parts.push(`${r.companionBeats.length} companion beat${r.companionBeats.length > 1 ? 's' : ''}`);
        if (r.worldEvents?.length)     parts.push(`${r.worldEvents.length} world event${r.worldEvents.length > 1 ? 's' : ''}`);
        if (r.rumourCount)             parts.push(`${r.rumourCount} rumour${r.rumourCount > 1 ? 's' : ''}`);
        if (r.loreReveal)              parts.push('lore reveal');
        showMessage(parts.length ? `Nightly: ${parts.join(', ')}` : 'Nightly growth done — nothing triggered');
        await loadAll();
      } else {
        showMessage(data.error || 'Nightly growth failed');
      }
    } catch {
      showMessage('Nightly growth failed');
    } finally {
      setRunningNightlyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-2xl font-heading font-bold text-leather-dark tracking-wide">
            Admin Console
          </h2>
          <p className="text-sm text-ink-faint font-body italic mt-1">
            Manage users, platform defaults, and campaign growth controls.
          </p>
        </div>
        <div className="flex gap-2">
          {(['users', 'settings', 'campaigns'] as AdminTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`rounded-full px-4 py-2 text-xs font-heading font-semibold uppercase tracking-wide transition-colors ${
                activeTab === tab
                  ? 'bg-leather text-parchment-light'
                  : 'border border-leather/20 text-leather hover:bg-leather/5'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {message && (
        <div className="mb-4 rounded-lg bg-leather/10 px-4 py-2 text-sm font-body text-leather-dark">
          {message}
        </div>
      )}

      {loading ? (
        <p className="py-12 text-center font-body italic text-ink-faint">Loading admin data...</p>
      ) : (
        <>
          {activeTab === 'users' && (
            <div className="overflow-x-auto rounded-lg border border-leather/15 bg-parchment-light/40">
              <table className="min-w-[760px] w-full">
                <thead>
                  <tr className="border-b border-leather/15 bg-parchment-dark/20">
                    <th className="px-4 py-3 text-left text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">User</th>
                    <th className="px-4 py-3 text-left text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">Role</th>
                    <th className="px-4 py-3 text-left text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">Joined</th>
                    <th className="px-4 py-3 text-left text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">Last Seen</th>
                    <th className="px-4 py-3 text-right text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b border-leather/8 last:border-b-0 hover:bg-parchment-light/50">
                      <td className="px-4 py-3">
                        {editingId === u.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="w-40 rounded border border-leather/20 bg-parchment px-2 py-1 font-body text-sm focus:border-leather/50 focus:outline-none"
                              onKeyDown={(e) => e.key === 'Enter' && void saveDisplayName(u.id)}
                              autoFocus
                            />
                            <button onClick={() => void saveDisplayName(u.id)} className="text-xs font-heading text-heal hover:text-heal-light">Save</button>
                            <button onClick={() => setEditingId(null)} className="text-xs font-heading text-ink-faint hover:text-ink-light">Cancel</button>
                          </div>
                        ) : (
                          <div>
                            <span className="text-sm font-heading font-semibold text-leather-dark">
                              {u.display_name || u.username}
                            </span>
                            <span className="ml-2 text-xs font-body text-ink-faint">@{u.username}</span>
                            {u.id === player.id && <span className="ml-2 text-xs font-heading text-leather">(you)</span>}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => void toggleRole(u.id, u.role || 'player')}
                          disabled={u.id === player.id}
                          className={`rounded px-2 py-1 text-xs font-heading font-semibold ${
                            u.role === 'admin'
                              ? 'bg-leather/15 text-leather-dark hover:bg-leather/25'
                              : 'bg-parchment-dark/15 text-ink-faint hover:bg-parchment-dark/25'
                          } ${u.id === player.id ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          {u.role || 'player'}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs font-body text-ink-faint">{formatDate(u.created_at)}</td>
                      <td className="px-4 py-3 text-xs font-body text-ink-faint">{formatDate(u.last_seen)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => { setEditingId(u.id); setEditName(u.display_name || u.username); }}
                            className="text-xs font-body text-leather hover:text-leather-dark"
                          >
                            Rename
                          </button>
                          <button
                            onClick={() => { setResetId(u.id); setResetPassword(''); }}
                            className="text-xs font-body text-leather hover:text-leather-dark"
                          >
                            Reset PW
                          </button>
                          {u.id !== player.id && (
                            <button
                              onClick={() => void deleteUser(u.id, u.username)}
                              className="text-xs font-body text-blood/70 hover:text-blood"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'settings' && settings && (
            <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
              <section className="rounded-lg border border-leather/15 bg-parchment-light/40 p-5">
                <h3 className="mb-4 text-lg font-heading font-bold text-leather-dark">Platform Settings</h3>
                <div className="space-y-4">
                  <ToggleRow
                    label="Allow new registrations"
                    help="Controls whether new players can create accounts."
                    checked={settings.allowRegistration}
                    onChange={(checked) => setSettings({ ...settings, allowRegistration: checked })}
                  />
                  <ToggleRow
                    label="Allow campaign creation"
                    help="Stops non-admin users from creating new campaigns."
                    checked={settings.allowCampaignCreation}
                    onChange={(checked) => setSettings({ ...settings, allowCampaignCreation: checked })}
                  />
                  <ToggleRow
                    label="Enable AI growth by default"
                    help="Applies to newly created campaigns unless overridden per campaign."
                    checked={settings.defaultAiGrowthEnabled}
                    onChange={(checked) => setSettings({ ...settings, defaultAiGrowthEnabled: checked })}
                  />
                  <NumberRow
                    label="Default scene buffer"
                    help="How many unexplored scenes a new campaign should try to keep ahead."
                    value={settings.defaultTargetSceneBuffer}
                    onChange={(value) => setSettings({ ...settings, defaultTargetSceneBuffer: value })}
                  />
                  <NumberRow
                    label="Default NPC buffer"
                    help="How many active NPCs a new campaign should aim to keep available."
                    value={settings.defaultTargetNpcBuffer}
                    onChange={(value) => setSettings({ ...settings, defaultTargetNpcBuffer: value })}
                  />
                </div>
                <div className="mt-5 flex justify-end">
                  <button
                    onClick={() => void saveSettings()}
                    disabled={savingSettings}
                    className="rounded-lg bg-leather px-5 py-2.5 text-sm font-heading font-semibold text-parchment-light hover:bg-leather-dark disabled:opacity-50"
                  >
                    {savingSettings ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>
              </section>

              <section className="rounded-lg border border-leather/15 bg-parchment-light/40 p-5">
                <h3 className="mb-4 text-lg font-heading font-bold text-leather-dark">Runtime Status</h3>
                {runtime && (
                  <div className="space-y-3 text-sm font-body text-ink-light">
                    <RuntimeRow label="Mode" value={runtime.runtimeMode} />
                    <RuntimeRow label="Ollama" value={runtime.ollamaReachable ? 'reachable' : 'offline'} />
                    <RuntimeRow label="Main model" value={runtime.activeModel} />
                    <RuntimeRow label="Fast model" value={runtime.fastModel} />
                    <RuntimeRow label="Nightly growth hour" value={`${runtime.nightlyGrowthHourUtc}:00 UTC`} />
                    <div>
                      <div className="mb-1 text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">Installed models</div>
                      <div className="flex flex-wrap gap-2">
                        {runtime.models.map((model) => (
                          <span key={model} className="rounded-full border border-leather/15 px-3 py-1 text-xs font-heading text-leather">
                            {model}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}

          {activeTab === 'campaigns' && (
            <div className="space-y-4">
              {campaigns.map((campaign) => (
                <div key={campaign.id} className="rounded-lg border border-leather/15 bg-parchment-light/40 p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-heading font-bold text-leather-dark">{campaign.name}</h3>
                        <select
                          value={campaign.status}
                          onChange={(e) => void updateCampaign(campaign.id, { status: e.target.value })}
                          className="rounded border border-leather/20 bg-parchment px-2 py-1 text-xs font-heading text-ink-light focus:border-leather/50 focus:outline-none"
                        >
                          <option value="active">active</option>
                          <option value="paused">paused</option>
                          <option value="completed">completed</option>
                        </select>
                      </div>
                      {campaign.setting && <p className="mt-1 text-sm font-body italic text-ink-faint">{campaign.setting}</p>}
                      <div className="mt-3 flex flex-wrap gap-4 text-xs font-body text-ink-faint">
                        <span>Session {campaign.session_number}</span>
                        <span>{campaign.player_count} players</span>
                        <span>{campaign.character_count} characters</span>
                        <span>{campaign.scene_count} scenes</span>
                        <span>{campaign.npc_count} NPCs</span>
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3 lg:w-[440px]">
                      <ToggleCard
                        label="AI growth"
                        checked={Boolean(campaign.ai_growth_enabled)}
                        onChange={(checked) => void updateCampaign(campaign.id, { aiGrowthEnabled: checked })}
                      />
                      <NumberCard
                        label="Scene buffer"
                        value={campaign.target_scene_buffer}
                        onChange={(value) => void updateCampaign(campaign.id, { targetSceneBuffer: value })}
                      />
                      <NumberCard
                        label="NPC buffer"
                        value={campaign.target_npc_buffer}
                        onChange={(value) => void updateCampaign(campaign.id, { targetNpcBuffer: value })}
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-3 border-t border-leather/10 pt-4">
                    <div className="text-xs font-body text-ink-faint">
                      Content: last check {formatDate(campaign.last_growth_check_at)} · last build {formatDate(campaign.last_growth_build_at)}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void runGrowth(campaign.id)}
                        disabled={runningGrowthId === campaign.id || runningNightlyId === campaign.id}
                        className="rounded-lg border border-leather/20 px-4 py-2 text-xs font-heading font-semibold text-leather hover:bg-leather/5 disabled:opacity-50"
                        title="Add scenes, NPCs, and lore entries to buffer the next session"
                      >
                        {runningGrowthId === campaign.id ? 'Building content...' : 'Run Content Growth'}
                      </button>
                      <button
                        onClick={() => void runNightly(campaign.id)}
                        disabled={runningNightlyId === campaign.id || runningGrowthId === campaign.id}
                        className="rounded-lg border border-amber-600/30 bg-amber-50/30 px-4 py-2 text-xs font-heading font-semibold text-amber-800 hover:bg-amber-50/60 disabled:opacity-50"
                        title="Simulate overnight world changes: faction drift, rival movement, rumours, world events"
                      >
                        {runningNightlyId === campaign.id ? 'Running nightly...' : 'Run Nightly Growth'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {resetId && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-3 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-sm rounded-lg border border-leather/20 bg-parchment p-4 shadow-xl sm:p-6">
            <h3 className="mb-4 text-lg font-heading font-bold text-leather-dark">Reset Password</h3>
            <p className="mb-3 text-xs font-body text-ink-faint">
              For: {users.find((u) => u.id === resetId)?.username}
            </p>
            <input
              type="text"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              placeholder="New password..."
              autoFocus
              className="w-full rounded-lg border border-leather/20 bg-parchment-light px-4 py-2.5 font-body text-sm focus:border-leather/50 focus:outline-none"
            />
            <div className="mt-4 flex gap-3">
              <button onClick={() => setResetId(null)} className="flex-1 rounded-lg border border-leather/20 py-2 text-sm font-heading text-ink-faint hover:bg-parchment-dark/30">
                Cancel
              </button>
              <button onClick={() => void handleResetPassword(resetId)} className="flex-1 rounded-lg bg-leather py-2 text-sm font-heading font-semibold text-parchment-light hover:bg-leather-dark">
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleRow({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-leather/10 bg-parchment/40 p-4">
      <div>
        <div className="font-heading text-sm font-bold text-leather-dark">{label}</div>
        <div className="mt-1 text-sm font-body text-ink-faint">{help}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`rounded-full px-3 py-1 text-xs font-heading font-semibold uppercase tracking-wide ${
          checked ? 'bg-heal/15 text-heal' : 'bg-parchment-dark/30 text-ink-faint'
        }`}
      >
        {checked ? 'on' : 'off'}
      </button>
    </div>
  );
}

function NumberRow({ label, help, value, onChange }: { label: string; help: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-leather/10 bg-parchment/40 p-4">
      <div>
        <div className="font-heading text-sm font-bold text-leather-dark">{label}</div>
        <div className="mt-1 text-sm font-body text-ink-faint">{help}</div>
      </div>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 rounded border border-leather/20 bg-parchment px-3 py-2 text-sm font-heading text-ink-light focus:border-leather/50 focus:outline-none"
      />
    </div>
  );
}

function RuntimeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-leather/10 bg-parchment/40 px-3 py-2">
      <span className="text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">{label}</span>
      <span className="text-sm font-body text-ink-light">{value}</span>
    </div>
  );
}

function ToggleCard({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="rounded-lg border border-leather/10 bg-parchment/40 p-3">
      <div className="mb-2 text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">{label}</div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-full rounded-md px-3 py-2 text-xs font-heading font-semibold uppercase tracking-wide ${
          checked ? 'bg-heal/15 text-heal' : 'bg-parchment-dark/30 text-ink-faint'
        }`}
      >
        {checked ? 'enabled' : 'disabled'}
      </button>
    </div>
  );
}

function NumberCard({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="rounded-lg border border-leather/10 bg-parchment/40 p-3">
      <div className="mb-2 text-xs font-heading font-bold uppercase tracking-wider text-ink-faint">{label}</div>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded border border-leather/20 bg-parchment px-3 py-2 text-sm font-heading text-ink-light focus:border-leather/50 focus:outline-none"
      />
    </div>
  );
}
