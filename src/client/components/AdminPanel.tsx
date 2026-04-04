import { useState, useEffect } from 'react';

interface User {
  id: string;
  username: string;
  display_name: string;
  role: string;
  created_at: string;
  last_seen: string | null;
}

interface Props {
  apiUrl: string;
  player: { id: string; token: string };
}

export default function AdminPanel({ apiUrl, player }: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [message, setMessage] = useState('');

  const headers = { Authorization: `Bearer ${player.token}`, 'Content-Type': 'application/json' };

  useEffect(() => { fetchUsers(); }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/admin/users`, { headers });
      const data = await res.json();
      if (data.ok) setUsers(data.data);
    } catch (err) {
      console.error('Failed to fetch users', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleRole = async (userId: string, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'player' : 'admin';
    try {
      const res = await fetch(`${apiUrl}/api/admin/users/${userId}/role`, {
        method: 'PATCH', headers, body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (data.ok) {
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u));
        showMessage(`Role updated to ${newRole}`);
      }
    } catch {
      showMessage('Failed to update role');
    }
  };

  const saveDisplayName = async (userId: string) => {
    try {
      const res = await fetch(`${apiUrl}/api/admin/users/${userId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ displayName: editName }),
      });
      const data = await res.json();
      if (data.ok) {
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, display_name: editName } : u));
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
        method: 'POST', headers, body: JSON.stringify({ password: resetPassword }),
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
        method: 'DELETE', headers,
      });
      const data = await res.json();
      if (data.ok) {
        setUsers(prev => prev.filter(u => u.id !== userId));
        showMessage(`User "${username}" deleted`);
      } else {
        showMessage(data.error || 'Failed to delete');
      }
    } catch {
      showMessage('Failed to delete user');
    }
  };

  const showMessage = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3000);
  };

  const formatDate = (d: string | null) => {
    if (!d) return 'Never';
    return new Date(d + 'Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-2xl font-heading font-bold text-leather-dark tracking-wide mb-6">
        Admin &mdash; User Management
      </h2>

      {message && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-leather/10 text-sm font-body text-leather-dark">
          {message}
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint font-body italic text-center py-12">Loading users...</p>
      ) : (
        <div className="border border-leather/15 rounded-lg overflow-hidden bg-parchment-light/40">
          <table className="w-full">
            <thead>
              <tr className="border-b border-leather/15 bg-parchment-dark/20">
                <th className="text-left px-4 py-3 text-xs font-heading font-bold text-ink-faint uppercase tracking-wider">User</th>
                <th className="text-left px-4 py-3 text-xs font-heading font-bold text-ink-faint uppercase tracking-wider">Role</th>
                <th className="text-left px-4 py-3 text-xs font-heading font-bold text-ink-faint uppercase tracking-wider">Last Seen</th>
                <th className="text-right px-4 py-3 text-xs font-heading font-bold text-ink-faint uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-leather/8 last:border-b-0 hover:bg-parchment-light/50">
                  <td className="px-4 py-3">
                    {editingId === u.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          className="px-2 py-1 rounded border border-leather/20 bg-parchment font-body text-sm w-32 focus:outline-none focus:border-leather/50"
                          autoFocus
                          onKeyDown={e => e.key === 'Enter' && saveDisplayName(u.id)}
                        />
                        <button onClick={() => saveDisplayName(u.id)}
                          className="text-xs text-heal font-heading font-semibold hover:text-heal-light">Save</button>
                        <button onClick={() => setEditingId(null)}
                          className="text-xs text-ink-faint font-heading hover:text-ink-light">Cancel</button>
                      </div>
                    ) : (
                      <div>
                        <span className="font-heading font-semibold text-sm text-leather-dark">
                          {u.display_name || u.username}
                        </span>
                        <span className="text-xs text-ink-faint font-body ml-2">@{u.username}</span>
                        {u.id === player.id && (
                          <span className="text-xs text-leather font-heading ml-2">(you)</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleRole(u.id, u.role || 'player')}
                      disabled={u.id === player.id}
                      className={`text-xs font-heading font-semibold px-2 py-1 rounded transition-colors ${
                        u.role === 'admin'
                          ? 'bg-leather/15 text-leather-dark hover:bg-leather/25'
                          : 'bg-parchment-dark/15 text-ink-faint hover:bg-parchment-dark/25'
                      } ${u.id === player.id ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      {u.role || 'player'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-faint font-body">
                    {formatDate(u.last_seen)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => { setEditingId(u.id); setEditName(u.display_name || u.username); }}
                        className="text-xs text-leather font-body hover:text-leather-dark"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => { setResetId(u.id); setResetPassword(''); }}
                        className="text-xs text-leather font-body hover:text-leather-dark"
                      >
                        Reset PW
                      </button>
                      {u.id !== player.id && (
                        <button
                          onClick={() => deleteUser(u.id, u.username)}
                          className="text-xs text-blood/60 font-body hover:text-blood"
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

      {/* Reset Password Modal */}
      {resetId && (
        <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-parchment border border-leather/20 rounded-lg p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-lg font-heading font-bold text-leather-dark mb-4">
              Reset Password
            </h3>
            <p className="text-xs text-ink-faint font-body mb-3">
              For: {users.find(u => u.id === resetId)?.username}
            </p>
            <input
              type="text"
              value={resetPassword}
              onChange={e => setResetPassword(e.target.value)}
              placeholder="New password..."
              autoFocus
              className="w-full px-4 py-2.5 rounded-lg border border-leather/20 bg-parchment-light font-body text-sm focus:outline-none focus:border-leather/50"
            />
            <div className="flex gap-3 mt-4">
              <button onClick={() => setResetId(null)}
                className="flex-1 py-2 rounded-lg border border-leather/20 text-sm font-heading text-ink-faint hover:bg-parchment-dark/30">
                Cancel
              </button>
              <button onClick={() => handleResetPassword(resetId)}
                className="flex-1 py-2 rounded-lg bg-leather text-parchment-light text-sm font-heading font-semibold hover:bg-leather-dark">
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
